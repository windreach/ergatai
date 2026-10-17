import type {
  TerminalAttachResult,
  TerminalProvider,
  TerminalStreamHandlers,
} from "./types"

type MutationProcedure<TInput> = {
  mutate(input: TInput): Promise<void>
}

type StreamEventShape = {
  type: string
  data?: string
  exitCode?: number
  signal?: number
}

type StreamProcedure<TStreamEvent extends StreamEventShape> = {
  subscribe(
    paneId: string,
    handlers: {
      onData(event: TStreamEvent): void
      onError(error: unknown): void
    },
  ): { unsubscribe(): void }
}

type TerminalRoutes<TStreamEvent extends StreamEventShape> = {
  write: MutationProcedure<{ paneId: string; data: string }>
  resize: MutationProcedure<{ paneId: string; cols: number; rows: number }>
  signal: MutationProcedure<{ paneId: string; signal?: string }>
  kill: MutationProcedure<{ paneId: string }>
  detach: MutationProcedure<{
    paneId: string
    serializedState?: string
  }>
  clearScrollback: MutationProcedure<{ paneId: string }>
  stream: StreamProcedure<TStreamEvent>
}

export function createTrpcTerminalProvider<TStreamEvent extends StreamEventShape>({
  id,
  label,
  attach,
  routes,
  onStreamEvent,
  streamErrorLabel,
}: {
  id: TerminalProvider["id"]
  label: string
  attach: TerminalProvider["attach"]
  routes: TerminalRoutes<TStreamEvent>
  onStreamEvent: (
    event: TStreamEvent,
    handlers: TerminalStreamHandlers,
  ) => void
  streamErrorLabel: string
}): TerminalProvider {
  return {
    id,
    label,
    attach,
    async write(input) {
      await routes.write.mutate(input)
    },
    async resize(input) {
      await routes.resize.mutate(input)
    },
    async signal(input) {
      await routes.signal.mutate(input)
    },
    async kill(input) {
      await routes.kill.mutate(input)
    },
    async detach(input) {
      await routes.detach.mutate(input)
    },
    async clearScrollback(input) {
      await routes.clearScrollback.mutate(input)
    },
    subscribe(paneId, handlers) {
      const subscription = routes.stream.subscribe(paneId, {
        onData(event) {
          onStreamEvent(event, handlers)
        },
        onError(error) {
          handlers.onError(
            error instanceof Error ? error : new Error(streamErrorLabel),
          )
        },
      })

      return () => subscription.unsubscribe()
    },
  }
}
