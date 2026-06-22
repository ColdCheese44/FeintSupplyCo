import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type LogLevel = "debug" | "info" | "warn" | "error";
type ActionStatus = "start" | "success" | "fail" | "skip" | "info";

interface LogPayload {
  level: LogLevel;
  component: string;
  message: string;
  status?: ActionStatus;
  data?: unknown;
}

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logFilePath = resolve(projectRoot, "data", "feintsupply.log");

/**
 * Maps a text log level to a numeric priority so filtering stays predictable.
 */
function getLogPriority(level: LogLevel): number {
  const priorities: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };
  return priorities[level];
}

/**
 * Reads the desired log level from the environment and falls back safely.
 */
function getConfiguredLogLevel(): LogLevel {
  const rawLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (rawLevel === "debug" || rawLevel === "info" || rawLevel === "warn" || rawLevel === "error") {
    return rawLevel;
  }
  return "info";
}

/**
 * Converts an unknown error into a structured object that is safe to log.
 */
function serializeError(error: unknown): SerializedError | unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return error;
}

/**
 * Ensures the log destination exists before the first write happens.
 */
function ensureLogDirectory(): void {
  const logDirectory = dirname(logFilePath);
  if (!existsSync(logDirectory)) {
    mkdirSync(logDirectory, { recursive: true });
  }
}

/**
 * Writes a single structured log entry to stdout and to the local log file.
 */
function writeLog(payload: LogPayload): void {
  if (getLogPriority(payload.level) < getLogPriority(getConfiguredLogLevel())) {
    return;
  }

  ensureLogDirectory();

  const entry = {
    timestamp: new Date().toISOString(),
    ...payload,
  };
  const serializedEntry = JSON.stringify(entry);

  console.log(serializedEntry);
  appendFileSync(logFilePath, `${serializedEntry}\n`, "utf8");
}

/**
 * Creates a scoped logger so each skill and client can identify its own output.
 */
export function createLogger(component: string) {
  return {
    /**
     * Writes a debug-level log entry for verbose troubleshooting.
     */
    debug(message: string, data?: unknown): void {
      writeLog({ level: "debug", component, message, data });
    },

    /**
     * Writes a normal informational log entry.
     */
    info(message: string, data?: unknown): void {
      writeLog({ level: "info", component, message, data });
    },

    /**
     * Writes a warning-level log entry for recoverable issues.
     */
    warn(message: string, data?: unknown): void {
      writeLog({ level: "warn", component, message, data });
    },

    /**
     * Writes an error-level log entry with serialized error detail when present.
     */
    error(message: string, error?: unknown, data?: unknown): void {
      writeLog({
        level: "error",
        component,
        message,
        data: {
          data,
          error: serializeError(error),
        },
      });
    },

    /**
     * Writes a standardized action log so orchestrated steps share the same shape.
     */
    action(message: string, status: ActionStatus, data?: unknown): void {
      writeLog({ level: status === "fail" ? "error" : "info", component, message, status, data });
    },
  };
}
