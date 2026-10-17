/**
 * Centralized timeout configurations
 * All timeout values in milliseconds
 */

export const TIMEOUT = {
  // Network operations
  NETWORK_CHECK: 2000,        // Network connectivity check
  API_REQUEST: 10000,         // General API request timeout

  // Git operations
  GIT_OPERATION: 5000,        // Git command execution

  // Port scanning
  PORT_SCAN: 5000,            // Port availability check

  // OAuth
  OAUTH_CALLBACK: 5000,       // OAuth callback server timeout

  // Ollama
  OLLAMA_CHECK: 2000,         // Ollama availability check
} as const

export type TimeoutKey = keyof typeof TIMEOUT
