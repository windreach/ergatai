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
 */
export const trpcClient = createTRPCProxyClient<AppRouter>({
  links: [ipcLink({ transformer: superjson })],
})
