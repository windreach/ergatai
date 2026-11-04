import { trpcClient } from "@/lib/trpc"
import { createTrpcTerminalProvider } from "./create-provider"
import type { TerminalProvider } from "./types"
import type { TerminalRoutes, StreamEventShape } from "./create-provider"

export const backendManagedProvider: TerminalProvider = createTrpcTerminalProvider({
  id: "backend-managed",
  label: "Backend workspace",
  async attach(request) {
    if (!request.workspaceId) {
      throw new Error("Backend terminal sessions require a workspaceId")
    }

    return trpcClient.backendTerminal.attach.mutate({
      paneId: request.paneId,
      workspaceId: request.workspaceId,
      cwd: request.cwd,
    })
  },
  // Proxy used to lazily resolve tRPC routes and avoid circular dependencies during module
  // initialization. Type assertion needed because the Proxy doesn't perfectly match the
  // expected TerminalProvider routes interface at compile time.
  routes: new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      return (trpcClient.backendTerminal as Record<string, unknown>)[prop as string]
    },
  }) as TerminalRoutes<StreamEventShape>,
  onStreamEvent(event, handlers) {
    if (event.type === "data" && event.data !== undefined) {
      handlers.onData(event.data)
    } else if (event.type === "exit") {
      handlers.onExit(event.exitCode ?? 0)
    } else if (event.type === "resync") {
      handlers.onReset?.()
    }
  },
  streamErrorLabel: "Backend terminal stream error",
})
