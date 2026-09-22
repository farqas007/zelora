type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Minimal structured-logging primitive: every entry is a single-line JSON
 * object on stdout/stderr. Kept dependency-free on purpose so it can be
 * swapped for pino (or a worker-friendly transport) later without changing
 * call sites.
 */
export function createLogger(scope: string): Logger {
  function write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    const entry = {
      level,
      scope,
      message,
      timestamp: new Date().toISOString(),
      ...fields,
    };
    const line = JSON.stringify(entry);
    if (level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}