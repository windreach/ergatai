/**
 * Shared configuration for the desktop app
 */
import { app } from "electron"

const IS_DEV = !!process.env.ELECTRON_RENDERER_URL

/**
 * Get the local API base URL. The desktop app no longer uses a hosted API.
 * Can be overridden via ERGATAI_API_URL environment variable.
 */
export function getApiUrl(): string {
  void app
  return process.env.ERGATAI_API_URL || "http://127.0.0.1:3000"
}

/**
 * Get Ollama API base URL
 * Can be overridden via OLLAMA_URL environment variable
 */
export function getOllamaUrl(): string {
  return process.env.OLLAMA_URL || "http://localhost:11434"
}

/**
 * Get OAuth client ID
 * Can be overridden via OAUTH_CLIENT_ID environment variable
 */
export function getOAuthClientId(): string {
  return process.env.OAUTH_CLIENT_ID || "ergatai"
}

/**
 * Check if running in development mode
 */
export function isDev(): boolean {
  return IS_DEV
}

/**
 * Cache TTL values (in milliseconds)
 */
export const CACHE_TTL = {
  PORT_SCAN: 5 * 1000, // 5 seconds - port scan cache
  NETWORK_STATUS: 10 * 1000, // 10 seconds - network status cache
  PROCESS_NAME: 5 * 1000, // 5 seconds - process name cache
} as const

/**
 * Timeout values (in milliseconds)
 */
export const TIMEOUT = {
  PORT_SCAN: 3000, // 3 seconds - execFile timeout for port scanning
  NETWORK_CHECK: 5000, // 5 seconds - fetch timeout for network check
} as const
