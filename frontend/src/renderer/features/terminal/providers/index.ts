import { backendManagedProvider } from "./backend-managed"
import { legacyElectronLocalProvider } from "./legacy-electron-local"
import type { TerminalProvider, TerminalProviderId } from "./types"

export function resolveTerminalProvider(): TerminalProvider {
  const configured = import.meta.env.VITE_ERGATAI_TERMINAL_PROVIDER
  const providerId: TerminalProviderId =
    configured === "backend-managed" ? "backend-managed" : "legacy-electron-local"

  return providerId === "backend-managed"
    ? backendManagedProvider
    : legacyElectronLocalProvider
}

export function killTerminalSession(input: { paneId: string }): Promise<void> {
  return resolveTerminalProvider().kill(input)
}

export type { TerminalProvider, TerminalProviderId } from "./types"
export { TerminalProviderUnavailableError } from "./types"
