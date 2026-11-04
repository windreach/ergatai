import { trpcClient } from "@/lib/trpc"
import { createTrpcTerminalProvider } from "./create-provider"
import type { TerminalProvider } from "./types"
import type { TerminalRoutes, StreamEventShape } from "./create-provider"

export const legacyElectronLocalProvider: TerminalProvider = createTrpcTerminalProvider({
  id: "legacy-electron-local",
  label: "Local shell",
  async attach(request) {
    return trpcClient.terminal.createOrAttach.mutate(request)
  },
  // Proxy used to lazily resolve tRPC routes and avoid circular dependencies during module
  // initialization. Type assertion needed because the Proxy doesn't perfectly match the
  // expected TerminalProvider routes interface at compile time.
  routes: new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      return (trpcClient.terminal as Record<string, unknown>)[prop as string]
    },
  }) as TerminalRoutes<StreamEventShape>,
  onStreamEvent(event, handlers) {
    if (event.type === "data" && event.data !== undefined) {
      handlers.onData(event.data)
    } else if (event.type === "exit") {
      handlers.onExit(event.exitCode ?? 0, event.signal)
    }
  },
  streamErrorLabel: "Terminal stream error",
})
