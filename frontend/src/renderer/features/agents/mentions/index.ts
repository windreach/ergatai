export {
  AgentsMentionsEditor,
  type AgentsMentionsEditorHandle,
  type FileMentionOption,
  type SlashTriggerPayload,
} from "./agents-mentions-editor"

// Re-export MENTION_PREFIXES from canonical source (12 items)
export { MENTION_PREFIXES } from "../../mentions"

// Re-export agent-native trigger helpers from canonical source
export { normalizeAgentTriggers, matchAgentTriggers } from "../../mentions"
export type { AgentTriggerMatch, AgentNativeTrigger } from "../../mentions"

export { AgentsFileMention } from "./agents-file-mention"

export {
  useRenderFileMentions,
  RenderFileMentions,
  extractFileMentions,
  hasFileMentions,
  FileOpenProvider,
  useFileOpen,
} from "./render-file-mentions"
