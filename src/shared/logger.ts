export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

export class Logger {
  private level: LogLevel;

  constructor(level: LogLevel = LogLevel.INFO) {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, meta);
  }

  /** Returns a stop function that logs elapsed time when called. */
  time(label: string): () => void {
    const start = performance.now();
    return () => {
      const durationMs = Math.round(performance.now() - start);
      this.info(label, { durationMs });
    };
  }

  private log(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    if (level < this.level) return;

    const entry: LogEntry = {
      level: LogLevel[level]!,
      message,
      timestamp: new Date().toISOString(),
      ...meta,
    };

    // Always write to stderr — stdout is reserved for MCP stdio transport
    process.stderr.write(JSON.stringify(entry) + "\n");
  }
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value) return LogLevel.INFO;
  const upper = value.toUpperCase();
  if (upper in LogLevel) {
    const parsed = LogLevel[upper as keyof typeof LogLevel];
    if (typeof parsed === "number") return parsed;
  }
  return LogLevel.INFO;
}

export const logger = new Logger(
  parseLogLevel(process.env.GIT_ORACLE_LOG_LEVEL),
);
