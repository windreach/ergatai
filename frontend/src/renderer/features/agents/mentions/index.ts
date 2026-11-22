// Modified from 1Code (Apache-2.0) by Ergatai — see MODIFICATIONS.md
export {
  AgentsMentionsEditor,
  type AgentsMentionsEditorHandle,
  type FileMentionOption,
  type SlashTriggerPayload,
  type EditorTriggerConfig,
} from "./agents-mentions-editor"

// Re-export MENTION_PREFIXES from canonical source (12 items)
export { MENTION_PREFIXES } from "../../mentions"

export { AgentsFileMention } from "./agents-file-mention"
export { AgentsSkillTrigger } from "./agents-skill-trigger"
export { AgentsHashTrigger } from "./agents-hash-trigger"

export {
  useRenderFileMentions,
  RenderFileMentions,
  extractFileMentions,
  hasFileMentions,
  FileOpenProvider,
  useFileOpen,
} from "./render-file-mentions"
