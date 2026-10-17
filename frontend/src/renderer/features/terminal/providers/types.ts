export type TerminalProviderId = "backend-managed" | "legacy-electron-local"

export interface TerminalAttachRequest {
  paneId: string
  tabId?: string
  workspaceId?: string
  scopeKey?: string
  cols: number
  rows: number
  cwd?: string
  initialCommands?: string[]
}

export interface TerminalAttachResult {
  paneId: string
  isNew: boolean
  serializedState: string
}

export interface TerminalStreamHandlers {
  onData: (data: string) => void
  onExit: (exitCode: number, signal?: number) => void
  onReset?: () => void
  onError: (error: Error) => void
}

export interface TerminalProvider {
  id: TerminalProviderId
  label: string
  attach: (request: TerminalAttachRequest) => Promise<TerminalAttachResult>
  write: (input: { paneId: string; data: string }) => Promise<void>
  resize: (input: {
    paneId: string
    cols: number
    rows: number
  }) => Promise<void>
  signal: (input: {
    paneId: string
    signal?: string
  }) => Promise<void>
  kill: (input: { paneId: string }) => Promise<void>
  detach: (input: {
    paneId: string
    serializedState?: string
  }) => Promise<void>
  clearScrollback: (input: { paneId: string }) => Promise<void>
  subscribe: (paneId: string, handlers: TerminalStreamHandlers) => () => void
}

export class TerminalProviderUnavailableError extends Error {
  constructor(providerId: TerminalProviderId, reason: string) {
    super(`Terminal provider "${providerId}" is unavailable: ${reason}`)
    this.name = "TerminalProviderUnavailableError"
  }
}
