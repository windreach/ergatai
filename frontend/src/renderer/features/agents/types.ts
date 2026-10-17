/**
 * Shared type re-exports for the agents feature.
 *
 * These types are defined in their respective domain modules and re-exported
 * here as a convenience so consumers can import from a single location.
 */

export type { SelectedTextContext, DiffTextContext } from './lib/queue-utils'
export type { PastedTextFile } from './hooks/use-pasted-text-files'
export type { UploadedImage } from './hooks/use-agents-file-upload'
export type { CoreAgentOption } from './lib/agent-contract-api'
export type { TextSelectionSource } from './context/text-selection-context'
