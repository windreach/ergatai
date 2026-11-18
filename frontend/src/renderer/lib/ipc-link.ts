import type { AnyTRPCRouter } from "@trpc/server"
import {
  ipcLink as createElectronIpcLink,
  type IPCLinkOptions,
} from "trpc-electron/renderer"

// Use globalThis to cache across HMR reloads. `trpc-electron`'s ipcLink creates a
// new IPCClient (and a permanent ipcRenderer.onMessage listener) every time the
// link runtime is initialized. Caching only the outer factory is not enough:
// each tRPC client (React provider, vanilla proxy, HMR remount) would still call
// link(runtime) and add another listener. Cache the initialized operation link
// and the request id counter too, so the whole renderer shares one listener.
const globalForIpcLink = globalThis as unknown as {
  __trpcIpcLink?: ReturnType<typeof createElectronIpcLink>
  __trpcOperationLink?: ReturnType<
    ReturnType<typeof createElectronIpcLink>
  >
  __trpcNextRequestId?: number
}

export function ipcLink<TRouter extends AnyTRPCRouter>(
  opts?: IPCLinkOptions<TRouter>,
) {
  return (runtime: Parameters<ReturnType<typeof createElectronIpcLink>>[0]) => {
    if (!globalForIpcLink.__trpcOperationLink) {
      const link =
        globalForIpcLink.__trpcIpcLink ??
        (globalForIpcLink.__trpcIpcLink = createElectronIpcLink<TRouter>(opts))

      globalForIpcLink.__trpcOperationLink = link(runtime)
    }

    const operationLink = globalForIpcLink.__trpcOperationLink

    return (operation: Parameters<typeof operationLink>[0]) => {
      // Keep the counter on globalThis as well. Resetting it on HMR while the
      // shared IPCClient still has pending requests could reuse an in-flight id
      // and route a response to the wrong callback.
      const id = (globalForIpcLink.__trpcNextRequestId ?? 0) + 1
      globalForIpcLink.__trpcNextRequestId = id

      return operationLink({
        ...operation,
        op: {
          ...operation.op,
          id,
        },
      })
    }
  }
}
