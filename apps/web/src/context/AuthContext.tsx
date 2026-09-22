import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { LoginRequest, RegisterRequest, UserDto } from "@zelora/shared";
import { createApiClient, type ZeloraApi } from "../lib/api/client";
import { bootstrapSession } from "../lib/auth/session";

/**
 * React boundary around the session bootstrap and the in-memory auth state.
 * The API client lives outside React; this provider owns the single CSRF token
 * holder the client reads from, so the token is re-read fresh on every request
 * and is never written to browser storage.
 */

export type AuthStatus = "loading" | "authenticated" | "signed-out";

export interface AuthContextValue {
  api: ZeloraApi;
  status: AuthStatus;
  user: UserDto | null;
  csrfToken: string | null;
  login: (input: LoginRequest) => Promise<void>;
  register: (input: RegisterRequest) => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const csrfTokenRef = useRef<string | null>(null);
  const apiRef = useRef<ZeloraApi | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<UserDto | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);

  if (apiRef.current === null) {
    apiRef.current = createApiClient({
      getCsrfToken: () => csrfTokenRef.current,
    });
  }
  const api = apiRef.current;

  const applyAuthenticated = useCallback((nextUser: UserDto, nextCsrfToken: string) => {
    csrfTokenRef.current = nextCsrfToken;
    setUser(nextUser);
    setCsrfToken(nextCsrfToken);
    setStatus("authenticated");
  }, []);

  const applySignedOut = useCallback(() => {
    csrfTokenRef.current = null;
    setUser(null);
    setCsrfToken(null);
    setStatus("signed-out");
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function restoreSession(): Promise<void> {
      try {
        const bootstrap = await bootstrapSession(api);
        if (cancelled) return;
        if (bootstrap.status === "authenticated") {
          applyAuthenticated(bootstrap.user, bootstrap.csrfToken);
        } else {
          applySignedOut();
        }
      } catch {
        if (!cancelled) {
          applySignedOut();
        }
      }
    }

    void restoreSession();
    return () => {
      cancelled = true;
    };
  }, [api, applyAuthenticated, applySignedOut]);

  const login = useCallback(
    async (input: LoginRequest) => {
      const envelope = await api.login(input);
      if (!envelope.ok) {
        throw new Error(envelope.error.message);
      }
      applyAuthenticated(envelope.data.user, envelope.data.session.csrfToken);
    },
    [api, applyAuthenticated],
  );

  const register = useCallback(
    async (input: RegisterRequest) => {
      const envelope = await api.register(input);
      if (!envelope.ok) {
        throw new Error(envelope.error.message);
      }
      applyAuthenticated(envelope.data.user, envelope.data.session.csrfToken);
    },
    [api, applyAuthenticated],
  );

  const logout = useCallback(async () => {
    const envelope = await api.logout();
    if (!envelope.ok) {
      throw new Error(envelope.error.message);
    }
    applySignedOut();
  }, [api, applySignedOut]);

  const logoutAll = useCallback(async () => {
    const envelope = await api.logoutAll();
    if (!envelope.ok) {
      throw new Error(envelope.error.message);
    }
    applySignedOut();
  }, [api, applySignedOut]);

  const value: AuthContextValue = {
    api,
    status,
    user,
    csrfToken,
    login,
    register,
    logout,
    logoutAll,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}