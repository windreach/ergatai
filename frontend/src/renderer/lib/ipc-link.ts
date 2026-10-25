import type { AnyTRPCRouter } from "@trpc/server"
import {
  ipcLink as createElectronIpcLink,
  type IPCLinkOptions,
} from "trpc-electron/renderer"

let nextIpcRequestId = 0

// Use globalThis to cache the IPC link instance across HMR reloads
// This prevents IPC listener leaks when TRPCProvider is remounted during development
const globalForIpcLink = globalThis as unknown as {
  __trpcIpcLink?: ReturnType<typeof createElectronIpcLink>
}

export function ipcLink<TRouter extends AnyTRPCRouter>(
  opts?: IPCLinkOptions<TRouter>,
) {
  // Reuse cached link instance to prevent IPC listener leaks during HMR
  // trpc-electron's ipcLink registers IPC listeners that accumulate if recreated
  if (!globalForIpcLink.__trpcIpcLink) {
    globalForIpcLink.__trpcIpcLink = createElectronIpcLink<TRouter>(opts)
  }

  const link = globalForIpcLink.__trpcIpcLink

  return (runtime: Parameters<typeof link>[0]) => {
    const operationLink = link(runtime)

    return (operation: Parameters<typeof operationLink>[0]) => {
      return operationLink({
        ...operation,
        op: {
          ...operation.op,
          id: ++nextIpcRequestId,
        },
      })
    }
  }
}
