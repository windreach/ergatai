import { createTRPCReact } from "@trpc/react-query"
import { createTRPCProxyClient } from "@trpc/client"
import { ipcLink } from "./ipc-link"
import type { AppRouter } from "../../main/lib/trpc/routers"
import superjson from "superjson"

/**
 * React hooks for tRPC
 */
export const trpc: ReturnType<typeof createTRPCReact<AppRouter>> =
  createTRPCReact<AppRouter>()

/**
 * Vanilla client for use outside React components (stores, utilities)
 *
 * Lazily created so that importing modules which merely reference `trpcClient`
 * does not force IPC setup (and failures) in non-browser/test environments.
 */
let _trpcClient: ReturnType<typeof createTRPCProxyClient<AppRouter>> | null = null

function getTrpcClient(): ReturnType<typeof createTRPCProxyClient<AppRouter>> {
  if (!_trpcClient) {
    _trpcClient = createTRPCProxyClient<AppRouter>({
      links: [ipcLink({ transformer: superjson })],
    })
  }
  return _trpcClient
}

export const trpcClient = new Proxy({} as ReturnType<typeof createTRPCProxyClient<AppRouter>>, {
  get(_target, prop, receiver) {
    const client = getTrpcClient()
    const value = Reflect.get(client, prop, receiver)
    // Do not bind: tRPC client is proxy-based; binding breaks nested procedure calls.
    return value
  },
})
