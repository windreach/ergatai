export {
  AgentsMentionsEditor,
  type AgentsMentionsEditorHandle,
  type FileMentionOption,
  type SlashTriggerPayload,
} from "./agents-mentions-editor"

// Re-export MENTION_PREFIXES from canonical source (12 items)
export { MENTION_PREFIXES } from "../../mentions/types/core"

export { AgentsFileMention } from "./agents-file-mention"

export {
  useRenderFileMentions,
  RenderFileMentions,
  extractFileMentions,
  hasFileMentions,
  FileOpenProvider,
  useFileOpen,
} from "./render-file-mentions"
