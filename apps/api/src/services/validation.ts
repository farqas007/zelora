import { ValidationError } from "@zelora/core";
import {
  AUTH_LIMITS,
  EMAIL_PATTERN,
  type LoginRequest,
  type RegisterRequest,
} from "@zelora/shared";

/**
 * API-level validation/normalization for Phase 3 auth requests. Input is
 * normalized first (email trimmed + lowercased, name trimmed), then validated
 * against the shared {@link AUTH_LIMITS}. Field problems are collected into a
 * single {@link ValidationError} carrying per-field message arrays.
 *
 * This module is intentionally API-specific: it must not be moved into
 * shared/core because browser-facing contracts stay dependency-free.
 */

type FieldErrors = Record<string, string[]>;

/** Trim surrounding whitespace and lowercase an email address. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Trim surrounding whitespace from a display name. */
export function normalizeName(name: string): string {
  return name.trim();
}

/** Validate a (previously normalized) email. Returns an empty array when valid. */
export function validateEmail(email: string): string[] {
  if (
    email.length < AUTH_LIMITS.emailMinLength ||
    email.length > AUTH_LIMITS.emailMaxLength
  ) {
    return [
      `Email must be between ${AUTH_LIMITS.emailMinLength} and ${AUTH_LIMITS.emailMaxLength} characters.`,
    ];
  }
  if (!EMAIL_PATTERN.test(email)) {
    return ["Email is invalid."];
  }
  return [];
}

/** Validate a password length against {@link AUTH_LIMITS}. Passwords are never normalized. */
export function validatePassword(password: string): string[] {
  if (password.length < AUTH_LIMITS.passwordMinLength) {
    return [`Password must be at least ${AUTH_LIMITS.passwordMinLength} characters.`];
  }
  if (password.length > AUTH_LIMITS.passwordMaxLength) {
    return [`Password must be at most ${AUTH_LIMITS.passwordMaxLength} characters.`];
  }
  return [];
}

/** Validate a (previously trimmed) name against {@link AUTH_LIMITS}. */
export function validateName(name: string): string[] {
  if (
    name.length < AUTH_LIMITS.nameMinLength ||
    name.length > AUTH_LIMITS.nameMaxLength
  ) {
    return [
      `Name must be between ${AUTH_LIMITS.nameMinLength} and ${AUTH_LIMITS.nameMaxLength} characters.`,
    ];
  }
  return [];
}

/** Reject anything that is not a plain JSON object body. */
function asObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("The request is invalid.", {
      body: ["Request body must be a JSON object."],
    });
  }
  return body as Record<string, unknown>;
}

function addFieldError(fields: FieldErrors, field: string, message: string): void {
  const existing = fields[field];
  if (existing === undefined) {
    fields[field] = [message];
  } else {
    existing.push(message);
  }
}

function collectField(
  fields: FieldErrors,
  record: Record<string, unknown>,
  field: string,
  label: string,
  normalize: (value: string) => string,
  validate: (value: string) => string[],
): string | null {
  const raw = record[field];
  if (raw === undefined || raw === null) {
    addFieldError(fields, field, `${label} is required.`);
    return null;
  }
  if (typeof raw !== "string") {
    addFieldError(fields, field, `${label} must be a string.`);
    return null;
  }
  const value = normalize(raw);
  for (const message of validate(value)) {
    addFieldError(fields, field, message);
  }
  return value;
}

/**
 * Parse and validate a register request body. Returns the normalized request;
 * throws a {@link ValidationError} with per-field errors on any problem.
 */
export function parseRegisterRequest(body: unknown): RegisterRequest {
  const record = asObjectBody(body);
  const fields: FieldErrors = {};

  const email = collectField(fields, record, "email", "Email", normalizeEmail, validateEmail);
  const password = collectField(fields, record, "password", "Password", (value) => value, validatePassword);
  const name = collectField(fields, record, "name", "Name", normalizeName, validateName);

  if (Object.keys(fields).length > 0) {
    throw new ValidationError("The request is invalid.", fields);
  }

  return { email: email as string, password: password as string, name: name as string };
}

/**
 * Parse and validate a login request body. Returns the normalized request;
 * throws a {@link ValidationError} with per-field errors on any problem.
 */
export function parseLoginRequest(body: unknown): LoginRequest {
  const record = asObjectBody(body);
  const fields: FieldErrors = {};

  const email = collectField(fields, record, "email", "Email", normalizeEmail, validateEmail);
  const password = collectField(fields, record, "password", "Password", (value) => value, validatePassword);

  if (Object.keys(fields).length > 0) {
    throw new ValidationError("The request is invalid.", fields);
  }

  return { email: email as string, password: password as string };
}