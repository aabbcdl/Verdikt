/**
 * Simple logger with levels and formatting.
 *
 * Bug 1: formatMessage uses wrong order (message before level)
 * Bug 2: shouldLog comparison is inverted (>= instead of <=)
 * Bug 3: createLogger doesn't pass prefix to child loggers
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  child(prefix: string): Logger;
}

export function createLogger(
  minLevel: LogLevel = "info",
  prefix: string = "",
  output: (line: string) => void = console.log,
): Logger {
  const shouldLog = (level: LogLevel): boolean => {
    // Bug: comparison inverted
    return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
  };

  const formatMessage = (level: LogLevel, message: string): string => {
    const tag = prefix ? `[${prefix}]` : "";
    // Bug: message before level
    return `${tag} ${message} ${level.toUpperCase()}: `;
  };

  const log = (level: LogLevel, message: string) => {
    if (shouldLog(level)) {
      output(formatMessage(level, message));
    }
  };

  return {
    debug: (msg) => log("debug", msg),
    info: (msg) => log("info", msg),
    warn: (msg) => log("warn", msg),
    error: (msg) => log("error", msg),
    child: (childPrefix: string) => {
      // Bug: doesn't combine parent prefix with child prefix
      return createLogger(minLevel, childPrefix, output);
    },
  };
}
