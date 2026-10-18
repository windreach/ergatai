/**
 * Ergatai Rust Backend HTTP Client
 *
 * Single entry point for all HTTP communication with the local Rust
 * backend (ergatai-api). Token and URL are managed here so they never
 * leak to the renderer process.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as crypto from "crypto"
import { authIdSchema } from "../validation/ids"

export const ERGATAI_API_URL =
  process.env.ERGATAI_API_URL || "http://127.0.0.1:3000"

/**
 * Warn if a non-localhost API URL is configured without HTTPS.
 * Bearer tokens sent over plain HTTP to remote hosts can be intercepted.
 */
function validateApiUrlSecurity(url: string): void {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    const isLocalhost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".localhost")

    if (!isLocalhost && parsed.protocol === "http:") {
      console.warn(
        `[security] ERGATAI_API_URL uses HTTP for non-localhost host "${hostname}". ` +
        `Bearer tokens will be sent unencrypted. Set ERGATAI_API_URL to an https:// URL.`,
      )
    }
  } catch {
    // Invalid URL — callers will get a fetch error; nothing to validate here.
  }
}

/**
 * Redact the path segment of a URL for safe logging.
 * Preserves scheme + host, replaces path with `[redacted]`.
 */
function redactUrlPath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}/[redacted]`
  } catch {
    return "[invalid-url]"
  }
}

validateApiUrlSecurity(ERGATAI_API_URL)

let cachedToken: string | null = null

/**
 * Get the user data directory for Ergatai.
 * Matches the backend's `ergatai_runtime::dirs::user_data_dir()` logic.
 */
function getUserDataDir(): string {
  // Check environment variable first (matches backend)
  const envDir = process.env.ERGATAI_USER_DATA_DIR
  if (envDir) {
    return envDir
  }

  // Platform-specific user data directory
  const platform = os.platform()
  const home = os.homedir()

  if (platform === "win32") {
    // Windows: %LOCALAPPDATA%/ergatai/
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local")
    return path.join(localAppData, "ergatai")
  } else if (platform === "darwin") {
    // macOS: ~/Library/Application Support/ergatai/
    return path.join(home, "Library", "Application Support", "ergatai")
  } else {
    // Linux and others: ~/.local/share/ergatai/
    const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share")
    return path.join(xdgDataHome, "ergatai")
  }
}

function readOrGenerateToken(): string | null {
  if (cachedToken) return cachedToken

  if (process.env.ERGATAI_API_TOKEN) {
    const parsed = authIdSchema.safeParse(process.env.ERGATAI_API_TOKEN)
    if (parsed.success) {
      cachedToken = parsed.data
      return cachedToken
    }

    console.error("ERGATAI_API_TOKEN must be a UUIDv4")
    return null
  }

  const tokenPath = path.join(getUserDataDir(), ".api-token")

  try {
    const token = fs.readFileSync(tokenPath, "utf-8").trim()
    const parsed = authIdSchema.safeParse(token)
    if (parsed.success) {
      cachedToken = parsed.data
      return cachedToken
    }

    if (token) {
      console.warn("Ignoring legacy API token; restart the backend to rotate it")
      return null
    }
  } catch {
    // File doesn't exist yet — backend will generate it on startup
  }

  // Generate an authentication token so the frontend can start before the backend.
  // Use double-check pattern to prevent race conditions from concurrent calls
  try {
    // Try to read again in case another process generated it
    try {
      const existingToken = fs.readFileSync(tokenPath, "utf-8").trim()
      const parsed = authIdSchema.safeParse(existingToken)
      if (parsed.success) {
        cachedToken = parsed.data
        return cachedToken
      }
    } catch {
      // Still doesn't exist, generate it
    }

    const token = crypto.randomUUID()
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true })
    fs.writeFileSync(tokenPath, token, { mode: 0o600 })
    cachedToken = token
    return cachedToken
  } catch {
    return null
  }
}

export const ERGATAI_API_TOKEN = process.env.ERGATAI_API_TOKEN

export interface ErgataiAuthConfig {
  apiUrl: string
  token: string | null
}

export class ErgataiApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: string,
  ) {
    super(message)
    this.name = "ErgataiApiError"
  }
}

export function isErgataiApiError(error: unknown): error is ErgataiApiError {
  return error instanceof ErgataiApiError
}

export function getErgataiAuthConfig(): ErgataiAuthConfig {
  return {
    apiUrl: ERGATAI_API_URL,
    token: readOrGenerateToken(),
  }
}

/**
 * Options for ergataiFetch that extend RequestInit
 */
interface ErgataiFetchOptions extends RequestInit {
  /** Silence error logging for specific status codes (e.g., [404] for expected "not found" cases) */
  silentStatus?: number[]
}

export async function ergataiFetch<T>(
  path: string,
  init?: ErgataiFetchOptions,
): Promise<T> {
  const { apiUrl, token } = getErgataiAuthConfig()

  // Default 10s timeout; allow override via init.signal for long-running ops
  const DEFAULT_TIMEOUT_MS = 10_000
  const isLongRunning = init?.method === "POST"
  const timeoutController = new AbortController()
  const timeout = setTimeout(
    () => timeoutController.abort(),
    isLongRunning ? 120_000 : DEFAULT_TIMEOUT_MS,
  )
  const abortHandler = () => timeoutController.abort()
  init?.signal?.addEventListener("abort", abortHandler, { once: true })

  try {
    const url = `${apiUrl}${path}`

    const headers: Record<string, string> = {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers as Record<string, string> || {}),
    }

    if (process.env.ERGATAI_DEBUG) {
      console.log(`[ergataiFetch] ${init?.method || "GET"} ${redactUrlPath(url)}`)
      console.log(`[ergataiFetch] Headers:`, Object.keys(headers).join(', '))
    }

    const response = await fetch(url, {
      ...init,
      signal: timeoutController.signal,
      headers,
    })

    if (!response.ok) {
      const body = await response.text()
      const isSilent = init?.silentStatus?.includes(response.status)
      if (!isSilent) {
        console.error(`[ergataiFetch] Error ${response.status} on ${init?.method || "GET"} ${url}: ${body}`)
      }
      throw new ErgataiApiError(
        response.status,
        `Ergatai API error ${response.status}: ${body}`,
        body,
      )
    }

    if (
      response.status === 204 ||
      response.headers.get("content-length") === "0"
    ) {
      // Return undefined for empty responses - caller must handle this case
      return undefined as unknown as T
    }

    const text = await response.text()

    try {
      return JSON.parse(text)
    } catch (parseError) {
      console.error(`[ergataiFetch] Failed to parse JSON: ${text}`)
      throw new ErgataiApiError(0, `Failed to parse response: ${text.substring(0, 100)}`)
    }
  } catch (error) {
    if (error instanceof ErgataiApiError) throw error
    if (init?.signal?.aborted) throw error
    console.error(`[ergataiFetch] Request failed:`, error)
    throw new ErgataiApiError(0, `Ergatai API request failed: ${String(error)}`)
  } finally {
    clearTimeout(timeout)
    init?.signal?.removeEventListener("abort", abortHandler)
  }
}
