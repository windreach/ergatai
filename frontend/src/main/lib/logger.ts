/**
 * Structured logging utility for ergatai frontend
 *
 * Provides consistent, structured logging with:
 * - Log levels (debug, info, warn, error)
 * - Context/metadata attachment
 * - Environment-aware output (dev vs prod)
 * - Easy filtering and aggregation
 */

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface LogEntry {
  level: LogLevel
  message: string
  context?: string
  timestamp: string
  data?: Record<string, unknown>
  error?: Error
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

// Current log level (can be adjusted based on environment)
let currentLogLevel: LogLevel = process.env.NODE_ENV === "development" ? "debug" : "warn"

/**
 * Set the current log level
 *
 * Note: This is a global setting that affects all logger instances created with createLogger().
 * In test environments, be aware that changing the log level will affect all tests sharing this module.
 */
export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level
}

/**
 * Get the current log level
 */
export function getLogLevel(): LogLevel {
  return currentLogLevel
}

/**
 * Check if a log level should be output
 */
function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLogLevel]
}

/**
 * Format a log entry for output
 */
function formatEntry(entry: LogEntry): string {
  const parts = [
    `[${entry.timestamp}]`,
    `[${entry.level.toUpperCase()}]`,
    entry.context ? `[${entry.context}]` : "",
    entry.message,
  ].filter(Boolean)

  if (entry.data && Object.keys(entry.data).length > 0) {
    parts.push(JSON.stringify(entry.data, null, 2))
  }

  return parts.join(" ")
}

/**
 * Output a log entry
 */
function output(entry: LogEntry): void {
  const formatted = formatEntry(entry)

  switch (entry.level) {
    case "debug":
      console.debug(formatted)
      break
    case "info":
      console.info(formatted)
      break
    case "warn":
      console.warn(formatted)
      break
    case "error":
      console.error(formatted, entry.error ?? "")
      break
  }
}

/**
 * Create a logger with a specific context
 */
export function createLogger(context: string) {
  return {
    debug(message: string, error?: unknown, data?: Record<string, unknown>): void {
      if (!shouldLog("debug")) return
      output({
        level: "debug",
        message,
        context,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error : undefined,
        data,
      })
    },

    info(message: string, error?: unknown, data?: Record<string, unknown>): void {
      if (!shouldLog("info")) return
      output({
        level: "info",
        message,
        context,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error : undefined,
        data,
      })
    },

    warn(message: string, error?: unknown, data?: Record<string, unknown>): void {
      if (!shouldLog("warn")) return
      output({
        level: "warn",
        message,
        context,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error : undefined,
        data,
      })
    },

    error(message: string, error?: unknown, data?: Record<string, unknown>): void {
      if (!shouldLog("error")) return
      output({
        level: "error",
        message,
        context,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error : undefined,
        data,
      })
    },
  }
}

// Default logger instance
export const logger = createLogger("ergatai")
