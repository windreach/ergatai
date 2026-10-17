import { createInterface } from "node:readline"
import { join } from "node:path"

import { RuntimeEngine, RuntimeOperationError } from "./runtime-engine"
import { SessionStore } from "./session-store"
import {
  COLLAB_RUNTIME_PROTOCOL_VERSION,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeResponse,
  type RuntimeResult,
} from "./protocol"

const RUNTIME_VERSION = "0.1.0"
const MAX_FRAME_BYTES = 1024 * 1024

type CommandError = Extract<
  RuntimeResponse,
  { ok: false }
>["error"]

const startedAtMs = Date.now()
const token = process.env.ERGATAI_COLLAB_RUNTIME_TOKEN
let authenticated = false
let stopping = false
const stateDir = process.env.ERGATAI_COLLAB_RUNTIME_DATA_DIR
  ? join(process.env.ERGATAI_COLLAB_RUNTIME_DATA_DIR, "collaboration")
  : join(process.cwd(), ".ergatai-collab-runtime", "collaboration")
const runtime = new RuntimeEngine(new SessionStore(stateDir))

if (!token) {
  process.stderr.write(
    "ERGATAI_COLLAB_RUNTIME_TOKEN is required\n",
  )
  process.exit(1)
}

function writeFrame(frame: unknown): void {
  if (stopping) {
    return
  }
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function writeEvent(event: RuntimeEvent): void {
  writeFrame(event)
}

function respond(id: string, result: RuntimeResult): void {
  const response: RuntimeResponse = {
    id,
    protocolVersion: COLLAB_RUNTIME_PROTOCOL_VERSION,
    ok: true,
    result,
  }
  writeFrame(response)
}

function respondError(
  id: string,
  code: CommandError["code"],
  message: string,
): void {
  const response: RuntimeResponse = {
    id,
    protocolVersion: COLLAB_RUNTIME_PROTOCOL_VERSION,
    ok: false,
    error: { code, message },
  }
  writeFrame(response)
}

async function handleCommand(id: string, command: RuntimeCommand): Promise<void> {
  if (command.type !== "hello" && !authenticated) {
    respondError(id, "unauthorized", "hello must be sent first")
    return
  }

  switch (command.type) {
    case "hello":
      authenticated = true
      respond(id, {
        type: "hello",
        protocolVersion: COLLAB_RUNTIME_PROTOCOL_VERSION,
        runtimeVersion: RUNTIME_VERSION,
      })
      return
    case "health":
      respond(id, {
        type: "health",
        status: "ok",
        protocolVersion: COLLAB_RUNTIME_PROTOCOL_VERSION,
        uptimeMs: Date.now() - startedAtMs,
        activeSessions: runtime.activeSessionCount,
      })
      return
    case "shutdown":
      authenticated = true
      respond(id, { type: "accepted" })
      stopping = true
      setImmediate(() => process.exit(0))
      return
    case "apply_interaction":
      {
        const routing = await runtime.applyInteraction(
          command.interaction,
          command.collaborationMode,
        )
        for (const event of routing.events) {
          writeEvent(event)
		}
		respond(id, {
			type: "interaction_routed",
			route: routing.route ?? "lightweight_chat",
			sessionId: routing.sessionId,
			runId: routing.runId,
		})
      }
      return
    case "resume_session":
      {
        const result = await runtime.resumeSession(command.sessionId)
        for (const event of result.events) {
          writeEvent(event)
        }
      }
      respond(id, { type: "accepted" })
      return
    case "approve":
      {
        const result = await runtime.approve(command.approvalId)
        for (const event of result.events) {
          writeEvent(event)
        }
      }
      respond(id, { type: "accepted" })
      return
    case "reject":
      {
        const result = await runtime.reject(command.approvalId)
        for (const event of result.events) {
          writeEvent(event)
        }
      }
      respond(id, { type: "accepted" })
      return
    case "cancel":
      {
        const result = await runtime.cancel({
          sessionId: command.sessionId,
          runId: command.runId,
        })
        for (const event of result.events) {
          writeEvent(event)
        }
      }
      respond(id, { type: "accepted" })
      return
  }
}

async function parseAndDispatch(line: string): Promise<void> {
  if (!line.trim()) {
    return
  }

  let request: unknown
  try {
    request = JSON.parse(line)
  } catch {
    writeEvent({
      type: "protocol_error",
      reason: "frame is not valid JSON",
    })
    return
  }

  const id =
    typeof request === "object" &&
    request !== null &&
    "id" in request &&
    typeof request.id === "string"
      ? request.id
      : ""
  const protocolVersion =
    typeof request === "object" &&
    request !== null &&
    "protocolVersion" in request
      ? request.protocolVersion
      : undefined

  if (!id) {
    respondError("", "invalid_command", "missing request id")
    return
  }
  if (protocolVersion !== COLLAB_RUNTIME_PROTOCOL_VERSION) {
    respondError(id, "unsupported_protocol", "protocol version mismatch")
    return
  }
  if (
    typeof request !== "object" ||
    request === null ||
    !("token" in request) ||
    request.token !== token
  ) {
    respondError(id, "unauthorized", "invalid runtime token")
    return
  }
  if (
    typeof request !== "object" ||
    request === null ||
    !("command" in request) ||
    typeof request.command !== "object" ||
    request.command === null ||
    !("type" in request.command) ||
    typeof request.command.type !== "string"
  ) {
    respondError(id, "invalid_command", "missing command type")
    return
  }

  // Validate command type is a known value
  const VALID_COMMAND_TYPES = new Set([
    "hello", "health", "apply_interaction", "resume_session",
    "approve", "reject", "cancel", "shutdown",
  ])
  if (!VALID_COMMAND_TYPES.has(request.command.type)) {
    respondError(id, "invalid_command", `unknown command type: ${request.command.type}`)
    return
  }

  try {
    await handleCommand(id, request.command as RuntimeCommand)
  } catch (error) {
    if (error instanceof RuntimeOperationError) {
      respondError(id, error.code, error.message)
      return
    }
    respondError(
      id,
      "internal_error",
      error instanceof Error ? error.message : "collaboration runtime command failed",
    )
  }
}

function shutdownFromSignal(): void {
  stopping = true
  setImmediate(() => process.exit(0))
}

process.once("SIGINT", shutdownFromSignal)
process.once("SIGTERM", shutdownFromSignal)

const stdin = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})

stdin.on("line", (line) => {
  if (line.length > MAX_FRAME_BYTES) {
    writeEvent({
      type: "protocol_error",
      reason: "frame exceeds 1 MiB limit",
    })
    return
  }
  void parseAndDispatch(line)
})

stdin.on("close", () => {
  stopping = true
  setImmediate(() => process.exit(0))
})

try {
  await runtime.recover()
} catch (error) {
  process.stderr.write(
    `failed to recover collaboration runtime state: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  )
  process.exit(1)
}

writeEvent({
  type: "ready",
  protocolVersion: COLLAB_RUNTIME_PROTOCOL_VERSION,
  runtimeVersion: RUNTIME_VERSION,
})
