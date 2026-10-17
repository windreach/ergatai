import { trpcClient } from "@/lib/trpc"
import { createTrpcTerminalProvider } from "./create-provider"
import type { TerminalProvider } from "./types"

export const legacyElectronLocalProvider: TerminalProvider = createTrpcTerminalProvider({
  id: "legacy-electron-local",
  label: "Local shell",
  async attach(request) {
    return trpcClient.terminal.createOrAttach.mutate(request)
  },
  routes: {
    write: trpcClient.terminal.write,
    resize: trpcClient.terminal.resize,
    signal: trpcClient.terminal.signal,
    kill: trpcClient.terminal.kill,
    detach: trpcClient.terminal.detach,
    clearScrollback: trpcClient.terminal.clearScrollback,
    stream: trpcClient.terminal.stream,
  },
  onStreamEvent(event, handlers) {
    if (event.type === "data" && event.data !== undefined) {
      handlers.onData(event.data)
    } else if (event.type === "exit") {
      handlers.onExit(event.exitCode, event.signal)
    }
  },
  streamErrorLabel: "Terminal stream error",
})
