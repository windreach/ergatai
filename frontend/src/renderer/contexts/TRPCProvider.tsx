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
      const isTestMode = (window as any).desktopApi?.isTestMode === true
      if (isTestMode) {
        // Expose vanilla proxy client for e2e tests
        ;(window as any).trpc = vanillaTrpcClient
      }
      // Debug-only: expose for DevTools console access (dev builds only)
      if (process.env.NODE_ENV === "development") {
        ;(window as any).trpcClient = client
      }
    }
    return client
  })

  // Cleanup trpc client on unmount to prevent IPC listener leaks during HMR
  useEffect(() => {
    return () => {
      // trpc-electron's ipcLink registers IPC listeners that need to be cleaned up.
      // When HMR reloads the module, the old client's listeners accumulate if not cleaned.
      // Note: trpc client doesn't expose a destroy() method, but unsubscribing all
      // queries/mutations will cause ipcLink to remove its IPC listeners.
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
