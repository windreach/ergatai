// Modified from 1Code (Apache-2.0) by Ergatai — see MODIFICATIONS.md
import i18n from "@/lib/i18n"
import { useEffect, useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { trpc, trpcClient as vanillaTrpcClient } from "../lib/trpc"
import { ipcLink } from "../lib/ipc-link"
import superjson from "superjson"

interface TRPCProviderProps {
  children: React.ReactNode
}

// Global query client instance for use outside React components
let globalQueryClient: QueryClient | null = null

export function getQueryClient(): QueryClient | null {
  return globalQueryClient
}

export function TRPCProvider({ children }: TRPCProviderProps) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 5000,
          gcTime: 60_000,
          refetchOnWindowFocus: false,
          networkMode: "always",
          retry: false,
        },
        mutations: {
          networkMode: "always",
          retry: false,
        },
      },
    })
    globalQueryClient = client
    return client
  })

  const [trpcClient] = useState(() => {
    const client = trpc.createClient({
      links: [ipcLink({ transformer: superjson })],
    })
    // SECURITY: Only expose tRPC client in test mode.
    // The test router is also conditionally registered (see routers/index.ts),
    // so even if window.trpc is accessed in production, test.* procedures won't exist.
    if (typeof window !== "undefined") {
      const isTestMode = (window as { desktopApi?: { isTestMode?: boolean } }).desktopApi?.isTestMode === true
      if (isTestMode) {
        // Expose vanilla proxy client for e2e tests
        ;(window as { trpc?: unknown }).trpc = vanillaTrpcClient
      }
      // Debug-only: expose for DevTools console access (dev builds only)
      if (process.env.NODE_ENV === "development") {
        ;(window as { trpcClient?: unknown }).trpcClient = client
      }
    }
    return client
  })

  // Cleanup pending queries/subscriptions on unmount. The IPC listener itself
  // is cached across HMR in lib/ipc-link.ts, so it does not need to be torn
  // down here (and tearing it down would break the next provider instance).
  useEffect(() => {
    return () => {
      queryClient.clear()
      globalQueryClient = null
    }
  }, [queryClient])

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  )
}