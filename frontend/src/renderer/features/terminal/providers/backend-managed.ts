import { trpcClient } from "@/lib/trpc"
import { createTrpcTerminalProvider } from "./create-provider"
import type { TerminalProvider } from "./types"

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
  routes: {
    write: trpcClient.backendTerminal.write,
    resize: trpcClient.backendTerminal.resize,
    signal: trpcClient.backendTerminal.signal,
    kill: trpcClient.backendTerminal.kill,
    detach: trpcClient.backendTerminal.detach,
    clearScrollback: trpcClient.backendTerminal.clearScrollback,
    stream: trpcClient.backendTerminal.stream,
  },
  onStreamEvent(event, handlers) {
    if (event.type === "data" && event.data !== undefined) {
      handlers.onData(event.data)
    } else if (event.type === "exit") {
      handlers.onExit(event.exitCode)
    } else if (event.type === "resync") {
      handlers.onReset?.()
    }
  },
  streamErrorLabel: "Backend terminal stream error",
})
