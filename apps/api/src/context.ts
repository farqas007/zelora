import type { AuthSessionRecord } from "@zelora/db/auth";
import type { UserRecord } from "@zelora/db/users";

/**
 * Identity of an authenticated request, resolved by the auth middleware from
 * the session cookie plus the user it belongs to. Type-only: the database
 * contracts are referenced purely as types so edge runtimes never pull the
 * Node-only SQLite stack through this module.
 */
export interface AuthContext {
  session: AuthSessionRecord;
  user: UserRecord;
}

/**
 * Hono environment for authenticated endpoints. Routes that run behind the
 * auth middleware read the resolved identity with `c.get("auth")`.
 */
export interface AppEnv {
  Variables: {
    auth: AuthContext;
  };
}