import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { observable } from "@trpc/server/observable"
import * as fs from "node:fs"
import * as path from "node:path"
import { app } from "electron"
import { router, publicProcedure } from "../index"
import {
  ErgataiApiError,
  ergataiFetch,
  getErgataiAuthConfig,
} from "../../ergatai/api"
import { getAuthManager } from "../../../auth-manager"

const backendTerminalSessionSchema = z.object({
  session_id: z.string().min(1),
  status: z.string(),
  workspace_id: z.string().min(1),
  user_id: z.string().min(1),
  profile: z.enum(["workspace_shell", "agent_observation"]),
  transport: z.enum(["pty", "pipes"]),
  cwd: z.string(),
  recoverable: z.boolean(),
})

const backendTerminalAttachResponseSchema = z.object({
  session: backendTerminalSessionSchema,
})

const backendStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("data"),
    sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    data: z.string(),
  }),
  z.object({
    type: z.literal("exit"),
    sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    exit_code: z.number().int(),
  }),
  z.object({
    type: z.literal("resync"),
  }),
])

export type BackendTerminalStreamEvent =
  | { type: "data"; sequence: number; data: string }
  | { type: "exit"; sequence: number; exitCode: number }
  | { type: "resync" }

type TerminalSessionMappings = Record<string, string>

const paneIdToBackendSessionId = new Map<string, string>()
let sessionMappingsLoaded = false

function getTerminalSessionMappingsPath(): string {
  return path.join(app.getPath("userData"), "terminal-session-mappings.json")
}

function loadSessionMappings(): void {
  if (sessionMappingsLoaded) return
  sessionMappingsLoaded = true

  try {
    const mappings = JSON.parse(
      fs.readFileSync(getTerminalSessionMappingsPath(), "utf-8"),
    ) as TerminalSessionMappings
    for (const [paneId, sessionId] of Object.entries(mappings)) {
      if (paneId && typeof sessionId === "string" && sessionId) {
        paneIdToBackendSessionId.set(paneId, sessionId)
      }
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      console.warn("[BackendTerminalRouter] Failed to load session mappings:", error)
    }
  }
}

function persistSessionMappings(): void {
  loadSessionMappings()

  try {
    const mappingsPath = getTerminalSessionMappingsPath()
    fs.mkdirSync(path.dirname(mappingsPath), { recursive: true })
    fs.writeFileSync(
      mappingsPath,
      JSON.stringify(Object.fromEntries(paneIdToBackendSessionId)),
      { mode: 0o600 },
    )
  } catch (error) {
    console.warn("[BackendTerminalRouter] Failed to save session mappings:", error)
  }
}

const activeTerminalStatuses = new Set(["starting", "running"])

const attachInputSchema = z.object({
  paneId: z.string().min(1),
  workspaceId: z.string().min(1),
  cwd: z.string().optional(),
})

async function getActiveBackendSessionId(
  paneId: string,
): Promise<string | null> {
  loadSessionMappings()
  const sessionId = paneIdToBackendSessionId.get(paneId)
  if (!sessionId) return null

  try {
    const response = await ergataiFetch<{
      session: { status: string }
    }>(`/api/v1/terminal-sessions/${encodeURIComponent(sessionId)}`)
    const session = backendTerminalSessionSchema
      .pick({ session_id: true, status: true })
      .parse(response.session)

    if (activeTerminalStatuses.has(session.status)) return sessionId
  } catch (error) {
    if (!(error instanceof ErgataiApiError && error.status === 404)) {
      throw error
    }
  }

  paneIdToBackendSessionId.delete(paneId)
  persistSessionMappings()
  return null
}

function toTrpcError(operation: string, error: unknown): TRPCError {
  if (error instanceof TRPCError) return error

  console.error(`[BackendTerminalRouter] ${operation} error:`, error)
  const status =
    error instanceof ErgataiApiError ? error.status : undefined
  const code =
    status === 404
      ? "NOT_FOUND"
      : status === 401 || status === 403
        ? "FORBIDDEN"
        : "INTERNAL_SERVER_ERROR"

  return new TRPCError({
    code,
    message:
      error instanceof Error ? error.message : `Failed to ${operation} terminal`,
  })
}

async function requireBackendSessionId(paneId: string): Promise<string> {
  const sessionId = paneIdToBackendSessionId.get(paneId)
  if (sessionId) return sessionId

  throw new TRPCError({
    code: "NOT_FOUND",
    message: `No backend terminal session is attached to pane "${paneId}"`,
  })
}

export const backendTerminalRouter = router({
  attach: publicProcedure.input(attachInputSchema).mutation(async ({ input }) => {
    try {
      const existingSessionId = await getActiveBackendSessionId(input.paneId)
      if (existingSessionId) {
        return {
          paneId: input.paneId,
          isNew: false,
          serializedState: "",
        }
      }

      const response = await ergataiFetch<{
        session: { session_id: string }
      }>("/api/v1/terminal-sessions", {
        method: "POST",
        body: JSON.stringify({
          workspace_id: input.workspaceId,
          profile: "workspace_shell",
          transport: "pty",
          user_id: getAuthManager()?.getUser().id ?? "local",
          cwd: input.cwd,
        }),
      })
      const parsed = backendTerminalAttachResponseSchema.parse(response)
      paneIdToBackendSessionId.set(input.paneId, parsed.session.session_id)
      persistSessionMappings()

      return {
        paneId: input.paneId,
        isNew: true,
        serializedState: "",
      }
    } catch (error) {
      throw toTrpcError("attach", error)
    }
  }),

  write: publicProcedure
    .input(
      z.object({
        paneId: z.string().min(1),
        data: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const sessionId = await requireBackendSessionId(input.paneId)
        await ergataiFetch(
          `/api/v1/terminal-sessions/${encodeURIComponent(sessionId)}/input`,
          {
            method: "POST",
            body: JSON.stringify({ data: input.data }),
          },
        )
      } catch (error) {
        throw toTrpcError("write to", error)
      }
    }),

  signal: publicProcedure
    .input(
      z.object({
        paneId: z.string().min(1),
        signal: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const sessionId = await requireBackendSessionId(input.paneId)
        await ergataiFetch(
          `/api/v1/terminal-sessions/${encodeURIComponent(sessionId)}/signal`,
          {
            method: "POST",
            body: JSON.stringify({ signal: input.signal ?? "INT" }),
          },
        )
      } catch (error) {
        throw toTrpcError("signal", error)
      }
    }),

  kill: publicProcedure
    .input(z.object({ paneId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const sessionId = await requireBackendSessionId(input.paneId)

      try {
        await ergataiFetch(
          `/api/v1/terminal-sessions/${encodeURIComponent(sessionId)}/terminate`,
          { method: "POST" },
        )
      } catch (error) {
        if (!(error instanceof ErgataiApiError && error.status === 404)) {
          throw toTrpcError("terminate", error)
        }
      } finally {
        if (paneIdToBackendSessionId.get(input.paneId) === sessionId) {
          paneIdToBackendSessionId.delete(input.paneId)
          persistSessionMappings()
        }
      }
    }),

  resize: publicProcedure
    .input(
      z.object({
        paneId: z.string().min(1),
        cols: z.number().int().positive(),
        rows: z.number().int().positive(),
      }),
    )
    .mutation(async ({ input }) => {
      const sessionId = await requireBackendSessionId(input.paneId)
      await ergataiFetch(
        `/api/v1/terminal-sessions/${encodeURIComponent(sessionId)}/resize`,
        {
          method: "POST",
          body: JSON.stringify({ cols: input.cols, rows: input.rows }),
        },
      )
    }),

  detach: publicProcedure
    .input(
      z.object({
        paneId: z.string().min(1),
        serializedState: z.string().optional(),
      }),
    )
    .mutation(async () => {}),

  clearScrollback: publicProcedure
    .input(z.object({ paneId: z.string().min(1) }))
    .mutation(async () => {}),

  stream: publicProcedure
    .input(z.string().min(1))
    .subscription(({ input }) => {
      return observable<BackendTerminalStreamEvent>((emit) => {
        const abortController = new AbortController()
        let cleanedUp = false
        let cursor: number | null = null
        let reconnectAttempts = 0
        let sessionEnded = false

        const cleanup = () => {
          if (cleanedUp) return
          cleanedUp = true
          abortController.abort()
        }

        const parseEvent = (rawEvent: string): BackendTerminalStreamEvent | null => {
          const data = rawEvent
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => {
              const value = line.slice(5)
              return value.startsWith(" ") ? value.slice(1) : value
            })
            .join("\n")

          if (!data) return null
          const event = backendStreamEventSchema.parse(JSON.parse(data))

          if (event.type === "data") {
            return {
              type: "data",
              sequence: event.sequence,
              data: event.data,
            }
          }
          if (event.type === "exit") {
            return {
              type: "exit",
              sequence: event.sequence,
              exitCode: event.exit_code,
            }
          }
          return { type: "resync" }
        }

        const waitForSessionId = async (): Promise<string | null> => {
          const deadline = Date.now() + 10_000

          while (Date.now() < deadline && !abortController.signal.aborted) {
            const sessionId = await getActiveBackendSessionId(input)
            if (sessionId) return sessionId
            await new Promise((resolve) => setTimeout(resolve, 100))
          }

          return null
        }

        const handleEvent = (event: BackendTerminalStreamEvent) => {
          reconnectAttempts = 0

          if (event.type === "exit") sessionEnded = true

          if (event.type === "resync") {
            cursor = null
            emit.next(event)
            return
          }

          if (cursor !== null && event.sequence <= cursor) return
          cursor = event.sequence
          emit.next(event)
        }

        const reconnectDelay = () =>
          Math.min(100 * 2 ** reconnectAttempts, 5_000)

        const streamSession = async (sessionId: string): Promise<"reconnect" | "stop"> => {
          const sessionAbortController = new AbortController()
          const abortSession = () => sessionAbortController.abort()
          abortController.signal.addEventListener("abort", abortSession, {
            once: true,
          })
          const mappingWatcher = setInterval(() => {
            if (paneIdToBackendSessionId.get(input) !== sessionId) {
              sessionAbortController.abort()
            }
          }, 100)

          try {
            const { apiUrl, token } = getErgataiAuthConfig()
            const streamQuery = new URLSearchParams()
            if (cursor !== null) streamQuery.set("after", String(cursor))
            const response = await fetch(
              `${apiUrl}/api/v1/terminal-sessions/${encodeURIComponent(sessionId)}/stream?${streamQuery}`,
              {
                headers: {
                  Accept: "text/event-stream",
                  Authorization: `Bearer ${token}`,
                },
                signal: sessionAbortController.signal,
              },
            )

            if (!response.ok) {
              const detail = await response.text().catch(() => "unknown error")
              throw new Error(
                `Backend terminal stream failed (${response.status}): ${detail}`,
              )
            }
            if (!response.body) {
              throw new Error("Backend terminal stream has no readable body")
            }

            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ""

            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              buffer += decoder.decode(value, { stream: true })
              buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")

              while (true) {
                const boundary = buffer.indexOf("\n\n")
                if (boundary === -1) break

                const rawEvent = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                const event = parseEvent(rawEvent)
                if (event) handleEvent(event)
              }
            }

            if (sessionEnded) return "stop"

            reconnectAttempts += 1
            return "reconnect"
          } catch (error) {
            if (sessionAbortController.signal.aborted) {
              return "stop"
            }

            if (
              !abortController.signal.aborted
            ) {
              reconnectAttempts += 1
              if (reconnectAttempts >= 5) {
                emit.error(
                  error instanceof Error
                    ? error
                    : new Error("Backend terminal stream error"),
                )
                return "stop"
              }
            }

            return "reconnect"
          } finally {
            clearInterval(mappingWatcher)
            abortController.signal.removeEventListener("abort", abortSession)
          }
        }

        void (async () => {
          try {
            while (!abortController.signal.aborted) {
              const sessionId = await waitForSessionId()
              if (abortController.signal.aborted) return
              if (!sessionId) {
                throw new TRPCError({
                  code: "NOT_FOUND",
                  message: `No backend terminal session is attached to pane "${input}"`,
                })
              }

              const shouldReconnect = await streamSession(sessionId)
              if (abortController.signal.aborted) return
              if (shouldReconnect === "stop") return

              await new Promise((resolve) =>
                setTimeout(resolve, reconnectDelay()),
              )
            }
          } catch {
            // The observable has already emitted the underlying stream error.
          }
        })()

        return cleanup
      })
    }),
})
