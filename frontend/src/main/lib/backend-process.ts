/**
 * Local backend lifecycle manager.
 *
 * The desktop app talks to ergatai-server over HTTP/SSE. Packaged builds ship
 * the server under resources/bin; we start it on demand and stop it when the
 * app exits. If a server is already running (dev.sh, ergatai-launcher, a CLI
 * session), we attach to it instead of spawning a second one.
 *
 * Environment:
 * - ERGATAI_API_URL: backend base URL. Non-local URLs are never managed.
 * - ERGATAI_BACKEND_AUTOSTART=0: only attach, never spawn.
 * - ERGATAI_BACKEND_KEEP_ALIVE=1: leave a spawned backend running after quit.
 * - ERGATAI_SERVER_BINARY: override the ergatai-server executable path.
 */

import { app } from "electron"
import { spawn, type ChildProcess } from "node:child_process"
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
  truncateSync,
} from "node:fs"
import { join, resolve } from "node:path"
import {
  getErgataiAuthConfig,
  getErgataiUserDataDir,
} from "./ergatai/api"

const PROBE_TIMEOUT_MS = 1_000
const READY_TIMEOUT_MS = 15_000
const READY_POLL_INTERVAL_MS = 250
const SHUTDOWN_TIMEOUT_MS = 5_000
const MAX_LOG_BYTES = 10 * 1024 * 1024

export type BackendLifecycleState =
  | "idle"
  | "attached"
  | "spawned"
  | "external"
  | "disabled"
  | "missing"
  | "failed"

export interface BackendLifecycleResult {
  state: BackendLifecycleState
  url: string
  pid?: number
  reason?: string
}

type ProbeResult = "healthy" | "unhealthy" | "foreign" | "down"

interface LocalTarget {
  host: string
  port: number
}

let backendProcess: ChildProcess | null = null
let ownsBackend = false
let keepBackendAlive = false
let shuttingDown = false
let exitHookRegistered = false
let lastResult: BackendLifecycleResult = {
  state: "idle",
  url: "",
}

function isLocalApiTarget(baseUrl: string): LocalTarget | null {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    return null
  }

  if (parsed.protocol !== "http:") return null

  const host = parsed.hostname.replace(/^\[|\]$/g, "")
  const isLoopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1"
  if (!isLoopback) return null

  const port = parsed.port ? Number(parsed.port) : 80
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null

  return { host: host === "localhost" ? "127.0.0.1" : host, port }
}

function isErgataiHealthPayload(
  value: unknown,
): value is { status: string; checks: unknown } {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.status === "string" && "checks" in record
}

async function probeBackend(baseUrl: string): Promise<ProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: controller.signal,
    })
    const payload: unknown = await response.json().catch(() => null)

    if (!isErgataiHealthPayload(payload)) return "foreign"
    return payload.status === "healthy" ? "healthy" : "unhealthy"
  } catch {
    return "down"
  } finally {
    clearTimeout(timer)
  }
}

function isEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase())
}

function backendBinaryName(): string {
  return process.platform === "win32" ? "ergatai-server.exe" : "ergatai-server"
}

function locateBackendBinary(): {
  path: string | null
  candidates: string[]
} {
  const override = process.env.ERGATAI_SERVER_BINARY
  if (override) {
    const resolved = resolve(override)
    return {
      path: existsSync(resolved) ? resolved : null,
      candidates: [resolved],
    }
  }

  const name = backendBinaryName()
  const candidates: string[] = []

  if (app.isPackaged) {
    candidates.push(join(process.resourcesPath, "bin", name))
  } else {
    const appPath = app.getAppPath()
    const repoRoot = join(appPath, "..")
    candidates.push(
      join(appPath, "resources", "bin", `${process.platform}-${process.arch}`, name),
      join(repoRoot, "target", "debug", name),
      join(repoRoot, "target", "release", name),
    )
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return { path: candidate, candidates }
  }
  return { path: null, candidates }
}

function getBackendLogPath(): string {
  const logDir = join(app.getPath("userData"), "logs")
  mkdirSync(logDir, { recursive: true })
  return join(logDir, "backend.log")
}

function prepareBackendLog(logPath: string): number {
  try {
    if (statSync(logPath).size > MAX_LOG_BYTES) truncateSync(logPath, 0)
  } catch {
    // Log file does not exist yet.
  }

  appendFileSync(
    logPath,
    `\n===== ${new Date().toISOString()} starting managed ergatai-server =====\n`,
  )
  return openSync(logPath, "a")
}

function ensureExitHook(): void {
  if (exitHookRegistered) return
  exitHookRegistered = true

  // Last-resort cleanup if Electron exits without running before-quit.
  process.on("exit", () => {
    if (!backendProcess || !ownsBackend || keepBackendAlive) return
    if (backendProcess.exitCode !== null) return
    try {
      backendProcess.kill()
    } catch {
      // Process may already be gone.
    }
  })
}

function spawnManagedBackend(binary: string, target: LocalTarget): ChildProcess {
  const auth = getErgataiAuthConfig()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ERGATAI_USER_DATA_DIR: getErgataiUserDataDir(),
    RUST_LOG: process.env.RUST_LOG ?? (app.isPackaged ? "info" : "debug"),
  }
  if (auth.token) env.ERGATAI_API_TOKEN = auth.token

  const logPath = getBackendLogPath()
  const logFd = prepareBackendLog(logPath)
  const cwd = app.isPackaged ? app.getPath("home") : join(app.getAppPath(), "..")

  try {
    return spawn(
      binary,
      ["--host", target.host, "--port", String(target.port)],
      {
        cwd,
        env,
        stdio: ["ignore", logFd, logFd],
        detached: keepBackendAlive,
        windowsHide: true,
      },
    )
  } finally {
    closeSync(logFd)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForReady(baseUrl: string): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS

  while (Date.now() < deadline) {
    if (!backendProcess || backendProcess.exitCode !== null) return false

    if ((await probeBackend(baseUrl)) === "healthy") return true
    await delay(READY_POLL_INTERVAL_MS)
  }

  return false
}

/**
 * Ensure a usable local backend exists.
 *
 * Resolution order:
 * 1. A healthy (or still starting) Ergatai server already on the configured URL
 * 2. A packaged/dev ergatai-server binary that we spawn
 * 3. Do nothing and let the UI surface the connection error
 */
export async function ensureBackend(): Promise<BackendLifecycleResult> {
  const auth = getErgataiAuthConfig()
  const baseUrl = auth.apiUrl.replace(/\/+$/, "")
  const target = isLocalApiTarget(baseUrl)

  if (!target) {
    lastResult = {
      state: "external",
      url: baseUrl,
      reason: "ERGATAI_API_URL is not a local HTTP URL",
    }
    console.log("[Backend] Not managing external backend:", baseUrl)
    return lastResult
  }

  const probe = await probeBackend(baseUrl)
  if (probe === "healthy" || probe === "unhealthy") {
    lastResult = {
      state: "attached",
      url: baseUrl,
      reason: `existing backend is ${probe}`,
    }
    console.log(`[Backend] Attached to existing ${probe} backend at ${baseUrl}`)
    return lastResult
  }

  if (probe === "foreign") {
    lastResult = {
      state: "failed",
      url: baseUrl,
      reason: "port is used by a non-Ergatai service",
    }
    console.error(
      `[Backend] ${baseUrl} is in use by a non-Ergatai service; not spawning`,
    )
    return lastResult
  }

  if (!isEnabled(process.env.ERGATAI_BACKEND_AUTOSTART, true)) {
    lastResult = {
      state: "disabled",
      url: baseUrl,
      reason: "ERGATAI_BACKEND_AUTOSTART=0",
    }
    console.log("[Backend] Autostart disabled; waiting for an external backend")
    return lastResult
  }

  const { path: binary, candidates } = locateBackendBinary()
  if (!binary) {
    lastResult = {
      state: "missing",
      url: baseUrl,
      reason: `ergatai-server not found (checked: ${candidates.join(", ")})`,
    }
    console.error("[Backend] ergatai-server binary not found:", candidates)
    return lastResult
  }

  keepBackendAlive = isEnabled(process.env.ERGATAI_BACKEND_KEEP_ALIVE, false)
  console.log(
    `[Backend] Starting ${binary} on ${target.host}:${target.port}` +
      (keepBackendAlive ? " (keep alive on quit)" : ""),
  )

  let proc: ChildProcess
  try {
    proc = spawnManagedBackend(binary, target)
  } catch (error) {
    console.error("[Backend] Failed to spawn ergatai-server:", error)
    lastResult = {
      state: "failed",
      url: baseUrl,
      reason: error instanceof Error ? error.message : "spawn failed",
    }
    return lastResult
  }

  backendProcess = proc
  ownsBackend = true
  ensureExitHook()
  if (keepBackendAlive) proc.unref()

  proc.once("error", (error) => {
    console.error("[Backend] Failed to start ergatai-server:", error)
    if (backendProcess === proc) {
      backendProcess = null
      ownsBackend = false
    }
  })

  proc.once("exit", (code, signal) => {
    if (backendProcess === proc) {
      backendProcess = null
      ownsBackend = false
    }
    if (!shuttingDown && !keepBackendAlive) {
      console.warn(
        `[Backend] ergatai-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      )
    }
  })

  const ready = await waitForReady(baseUrl)
  if (ready) {
    console.log(`[Backend] ergatai-server is ready (pid=${proc.pid ?? "unknown"})`)
  } else {
    console.warn(
      `[Backend] ergatai-server did not become healthy within ${READY_TIMEOUT_MS}ms`,
    )
  }

  lastResult = {
    state: ready ? "spawned" : "failed",
    url: baseUrl,
    pid: proc.pid ?? undefined,
    reason: ready ? undefined : "backend did not report healthy in time",
  }
  return lastResult
}

/**
 * Stop the backend if this process owns it. Attached/external backends are
 * never touched. With ERGATAI_BACKEND_KEEP_ALIVE=1 the child is left running.
 */
export async function stopBackend(): Promise<void> {
  shuttingDown = true

  const proc = backendProcess
  const owned = ownsBackend
  const keepAlive = keepBackendAlive
  backendProcess = null
  ownsBackend = false

  if (!proc || proc.exitCode !== null) return
  if (!owned || keepAlive) {
    proc.unref()
    return
  }

  console.log(`[Backend] Stopping ergatai-server (pid=${proc.pid ?? "unknown"})`)

  await new Promise<void>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve()
    }

    proc.once("exit", finish)
    try {
      // On Unix this starts ergatai-server's graceful shutdown. Windows has no
      // SIGTERM; Node maps it to TerminateProcess, and the next backend start
      // cleans up leaked nats-server processes.
      proc.kill("SIGTERM")
    } catch {
      finish()
      return
    }

    timer = setTimeout(() => {
      if (settled) return
      console.warn("[Backend] ergatai-server did not exit in time; forcing")
      try {
        proc.kill("SIGKILL")
      } catch {
        // Process may already be gone.
      }
      finish()
    }, SHUTDOWN_TIMEOUT_MS)
  })
}

export function getLastBackendResult(): BackendLifecycleResult {
  return lastResult
}
