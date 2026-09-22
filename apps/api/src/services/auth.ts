import {
  AUTH_ERROR_CODES,
  type AuthSessionDto,
  type LoginRequest,
  type RegisterRequest,
  type UserDto,
} from "@zelora/shared";
import type { AppConfig, PasswordHasher } from "@zelora/core";
import {
  AppError,
  generateCsrfToken,
  generateSessionToken,
  getDummyPasswordHash,
  hashSessionToken,
} from "@zelora/core";
import type { UserRepository } from "@zelora/db/users";
import type { AuthSessionRepository } from "@zelora/db/auth";
import type { Clock } from "./clock";
import type { RateLimiter } from "./rate-limit";
import {
  normalizeEmail,
  normalizeName,
  parseLoginRequest,
  parseRegisterRequest,
} from "./validation";

export interface AuthServiceResult {
  user: UserDto;
  session: AuthSessionDto;
  rawSessionToken: string;
}

function mapUserToDto(user: {
  id: string;
  email: string;
  name: string;
  role: "customer" | "seller" | "admin";
  status: "active" | "suspended" | "deleted";
  createdAt: Date;
}): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

function mapSessionToDto(session: {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  csrfToken: string;
}): AuthSessionDto {
  return {
    id: session.id,
    createdAt: session.createdAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    csrfToken: session.csrfToken,
  };
}

export interface AuthServiceDependencies {
  config: AppConfig;
  userRepository: UserRepository;
  sessionRepository: AuthSessionRepository;
  passwordHasher: PasswordHasher;
  clock: Clock;
  /**
   * Optional rate limiter used to throttle login attempts per normalized
   * email. When omitted (or disabled) the service never touches it, so the
   * existing login behavior is preserved exactly.
   */
  rateLimiter?: RateLimiter;
}

export class AuthService {
  private readonly config: AppConfig;
  private readonly userRepository: UserRepository;
  private readonly sessionRepository: AuthSessionRepository;
  private readonly passwordHasher: PasswordHasher;
  private readonly clock: Clock;
  private readonly rateLimiter?: RateLimiter;

  constructor(dependencies: AuthServiceDependencies) {
    this.config = dependencies.config;
    this.userRepository = dependencies.userRepository;
    this.sessionRepository = dependencies.sessionRepository;
    this.passwordHasher = dependencies.passwordHasher;
    this.clock = dependencies.clock;
    this.rateLimiter = dependencies.rateLimiter;
  }

  private async createSession(
    userId: string,
  ): Promise<{ sessionDto: AuthSessionDto; rawToken: string }> {
    const rawToken = generateSessionToken();
    const tokenHash = await hashSessionToken(rawToken);
    const csrfToken = generateCsrfToken();
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.config.sessionTtlSeconds * 1000);

    const created = await this.sessionRepository.create({
      userId,
      tokenHash,
      csrfToken,
      expiresAt,
    });

    return {
      sessionDto: mapSessionToDto(created),
      rawToken,
    };
  }

  async register(request: RegisterRequest): Promise<AuthServiceResult> {
    const normalizedRequest = parseRegisterRequest(request as unknown);
    const normalizedEmail = normalizeEmail(normalizedRequest.email);
    const normalizedName = normalizeName(normalizedRequest.name);

    const existingUser = await this.userRepository.findByEmail(normalizedEmail);
    if (existingUser !== null) {
      throw new AppError(
        AUTH_ERROR_CODES.EMAIL_IN_USE,
        "An account with this email already exists.",
        409,
      );
    }

    const passwordHash = await this.passwordHasher.hash(
      normalizedRequest.password,
    );

    const createdUser = await this.userRepository.create({
      email: normalizedEmail,
      name: normalizedName,
      passwordHash,
      role: "customer",
    });

    const { sessionDto, rawToken } = await this.createSession(createdUser.id);

    return {
      user: mapUserToDto(createdUser),
      session: sessionDto,
      rawSessionToken: rawToken,
    };
  }

  async login(request: LoginRequest): Promise<AuthServiceResult> {
    const normalizedRequest = parseLoginRequest(request as unknown);
    const normalizedEmail = normalizeEmail(normalizedRequest.email);

    const emailBucketKey = `auth:login:email:${normalizedEmail}`;
    const emailLimitActive =
      this.rateLimiter !== undefined && this.config.rateLimitEnabled;
    if (emailLimitActive) {
      const outcome = await this.rateLimiter!.consume(
        emailBucketKey,
        this.config.rateLimitLoginEmailMax,
        this.config.rateLimitLoginEmailWindowSeconds,
      );
      if (!outcome.allowed) {
        // Keep the throttled path indistinguishable from an invalid password:
        // same PBKDF2 work via the dummy hash, same generic envelope, and no
        // repository lookup, so a locked-out address never reveals existence.
        await this.passwordHasher.verify(
          normalizedRequest.password,
          await getDummyPasswordHash(this.config.pbkdf2Iterations),
        );
        throw new AppError(
          AUTH_ERROR_CODES.INVALID_CREDENTIALS,
          "Invalid email or password.",
          401,
        );
      }
    }

    const user = await this.userRepository.findByEmail(normalizedEmail);

    if (user === null || user.passwordHash === null) {
      await this.passwordHasher.verify(
        normalizedRequest.password,
        await getDummyPasswordHash(this.config.pbkdf2Iterations),
      );
      throw new AppError(
        AUTH_ERROR_CODES.INVALID_CREDENTIALS,
        "Invalid email or password.",
        401,
      );
    }

    if (user.status === "suspended" || user.status === "deleted") {
      const statusValid = await this.passwordHasher.verify(
        normalizedRequest.password,
        user.passwordHash,
      );
      if (!statusValid) {
        throw new AppError(
          AUTH_ERROR_CODES.INVALID_CREDENTIALS,
          "Invalid email or password.",
          401,
        );
      }
      throw new AppError(
        user.status === "suspended"
          ? AUTH_ERROR_CODES.ACCOUNT_SUSPENDED
          : AUTH_ERROR_CODES.ACCOUNT_DELETED,
        user.status === "suspended"
          ? "This account has been suspended."
          : "This account has been deleted.",
        403,
      );
    }

    const passwordValid = await this.passwordHasher.verify(
      normalizedRequest.password,
      user.passwordHash,
    );

    if (!passwordValid) {
      throw new AppError(
        AUTH_ERROR_CODES.INVALID_CREDENTIALS,
        "Invalid email or password.",
        401,
      );
    }

    const { sessionDto, rawToken } = await this.createSession(user.id);

    if (emailLimitActive) {
      await this.rateLimiter!.reset(emailBucketKey);
    }

    return {
      user: mapUserToDto(user),
      session: sessionDto,
      rawSessionToken: rawToken,
    };
  }
}
