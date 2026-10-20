import { useState } from "react"
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
    // Expose for debugging in DevTools console
    if (typeof window !== "undefined") {
      ;(window as any).trpcClient = client
      // 测试模式下暴露为 window.trpc 以便测试访问
      const isTestMode = (window as any).desktopApi?.isTestMode === true
      if (isTestMode) {
        // 暴露 vanilla proxy client（支持 query/mutation/subscription 方法）
        ;(window as any).trpc = vanillaTrpcClient
      }
    }
    return client
  })

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  )
}
