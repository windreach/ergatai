"use client"

import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { ChevronDown, RefreshCw } from "lucide-react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Button } from "../../../components/ui/button"
import {
  AttachIcon,
  IconSpinner,
  OriginalMCPIcon,
  SettingsIcon,
} from "../../../components/ui/icons"
import { Kbd } from "../../../components/ui/kbd"
import {
  PromptInput,
  PromptInputActions,
  PromptInputContextItems,
} from "../../../components/ui/prompt-input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../../components/ui/tooltip"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../components/ui/popover"
import {
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
  anthropicOnboardingCompletedAtom,
  apiKeyOnboardingCompletedAtom,
  customClaudeConfigAtom,
  extendedThinkingEnabledAtom,
  hiddenModelsAtom,
  normalizeCustomClaudeConfig,
  showOfflineModeFeaturesAtom,
} from "../../../lib/atoms"
import { useConversationOllamaModel } from "../hooks/use-conversation-ollama-model"
import { trpc } from "../../../lib/trpc"
import { cn } from "../../../lib/utils"
import {
  areVisibleChatAgentLogosEqual,
  chatAgentLogosAtom,
  createChatAgentLogos,
  lastSelectedCodexModelIdAtom,
  lastSelectedCodexThinkingAtom,
  lastSelectedModelIdAtom,
  conversationCodexModelIdAtomFamily,
  conversationCodexThinkingAtomFamily,
  conversationModelIdAtomFamily,
  conversationModeAtomFamily,
  getNextMode,
  registeredAgentsAtom,
  type AgentMode,
  type ConversationFileChange,
} from "../atoms"
import { useAgentConversationStore } from "../stores/conversation-store"
import { AgentsSlashCommand, type SlashCommandOption } from "../commands"
import { AgentModelSelector } from "../components/agent-model-selector"
import { getCoreAgentIcon } from "../components/core-agent-selector"
import { PermissionModeSelector } from "../components/permission-mode-selector"
import { CoreAgentSelector } from "../components/core-agent-selector"
import {
  loadGroupAgentIds,
  resolveGroupMentionAgents,
  saveGroupAgents,
} from "../collaboration/group-agent-storage"
import { fetchAgentModels } from "../lib/ergatai-agent-manager"
import {
  agentContractApi,
  CORE_AGENT_OPTIONS,
  type CoreAgentId,
  type CoreAgentOption,
} from "../lib/agent-contract-api"
import { AgentSendButton } from "../components/agent-send-button"
import type { UploadedFile, UploadedImage } from "../hooks/use-agents-file-upload"
import {
  clearConversationDraft,
  saveConversationDraftWithAttachments,
} from "../lib/drafts"
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  type CodexThinkingLevel,
} from "../lib/models"
import type { DiffTextContext, SelectedTextContext } from "../lib/queue-utils"
import { useAvailableModels } from "../hooks/use-available-models"
import {
  AgentsFileMention,
  AgentsMentionsEditor,
  type AgentsMentionsEditorHandle,
  type FileMentionOption,
} from "../mentions"
import { AgentContextIndicator, type MessageTokenData } from "../ui/agent-context-indicator"
import { AgentDiffTextContextItem } from "../ui/agent-diff-text-context-item"
import { AgentFileItem } from "../ui/agent-file-item"
import { AgentImageItem } from "../ui/agent-image-item"
import { AgentPastedTextItem } from "../ui/agent-pasted-text-item"
import { AgentTextContextItem } from "../ui/agent-text-context-item"
import { VoiceWaveIndicator } from "../ui/voice-wave-indicator"
import { handlePasteEvent } from "../utils/paste-text"
import type { PastedTextFile } from "../hooks/use-pasted-text-files"
import {
  useVoiceRecording,
} from "../../../lib/hooks/use-voice-recording"
import { getResolvedHotkey } from "../../../lib/hotkeys"
import { customHotkeysAtom } from "../../../lib/atoms"
import { toast } from "sonner"

// Text file extensions that should have content read and cached for agent
const TEXT_FILE_EXTENSIONS = new Set([
  // Code
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".cpp", ".h", ".hpp",
  ".cs", ".php", ".lua", ".r", ".m", ".mm", ".scala", ".clj", ".ex", ".exs",
  ".hs", ".elm", ".erl", ".fs", ".fsx", ".ml", ".v", ".vhdl", ".zig",
  // Config/Data
  ".json", ".yaml", ".yml", ".toml", ".xml", ".ini", ".env", ".conf", ".cfg",
  ".properties", ".plist",
  // Web
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".astro",
  // Documentation
  ".md", ".mdx", ".rst", ".txt", ".text",
  // Graphics (text-based)
  ".svg",
  // Shell/Scripts
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
  // Other
  ".sql", ".graphql", ".gql", ".prisma", ".dockerfile", ".makefile",
  ".gitignore", ".gitattributes", ".editorconfig", ".eslintrc", ".prettierrc",
])

export interface ChatInputAreaProps {
  // Editor ref - passed from parent for external access
  editorRef: React.RefObject<AgentsMentionsEditorHandle | null>
  // File input ref - for attachment button
  fileInputRef: React.RefObject<HTMLInputElement | null>
  // Core callbacks
  onSend: () => void
  onForceSend: () => void // Opt+Enter: stop stream and send immediately, bypassing queue
  onStop: () => Promise<void>
  onCompact: () => void
  onCreateNewConversation?: () => void
  onModeChange?: (newMode: AgentMode) => void
  // State from parent
  isStreaming: boolean
  isCompacting: boolean
  // File uploads
  images: UploadedImage[]
  files: UploadedFile[]
  onAddAttachments: (files: File[]) => void
  onAddFolder?: (folderName: string, filePaths: string[]) => void
  onRemoveImage: (id: string) => void
  onRemoveFile: (id: string) => void
  isUploading: boolean
  // Text context from selected assistant message text
  textContexts: SelectedTextContext[]
  onRemoveTextContext: (id: string) => void
  // Diff text context from selected diff sidebar text
  diffTextContexts?: DiffTextContext[]
  onRemoveDiffTextContext?: (id: string) => void
  // Pasted text files (large pasted text saved as files)
  pastedTexts?: PastedTextFile[]
  onAddPastedText?: (text: string) => Promise<void>
  onRemovePastedText?: (id: string) => void
  // Callback to cache file content for sending (maps mentionId -> content)
  onCacheFileContent?: (mentionId: string, content: string) => void
  // Pre-computed token data for context indicator (avoids passing messages array)
  messageTokenData: MessageTokenData
  // Context
  conversationId: string
  parentChatId: string
  provider?: "claude-code" | "codex" | "opencode"
  /** Runtime agent ID for providers whose model is discovered from ACP. */
  agentId?: string | null
  teamId?: string
  repository?: string
  sandboxId?: string
  projectPath?: string
  changedFiles: ConversationFileChange[]
  // Mobile
  isMobile?: boolean
  // Queue - for sending from queue when input is empty
  queueLength?: number
  onSendFromQueue?: (itemId: string) => void
  firstQueueItemId?: string
  // Callback to notify parent when input has content (for custom text with questions)
  onInputContentChange?: (hasContent: boolean) => void
  // Callback to send message with question answer (Enter sends immediately, not to queue)
  onSubmitWithQuestionAnswer?: () => void
  // Callback to switch provider for brand new (empty) conversations
  onProviderChange?: (provider: "claude-code" | "codex") => void
  // Callback to continue chat with a different provider (creates new conversation with history)
  onContinueWithProvider?: (provider: "claude-code" | "codex") => void
  // Whether this conversation tab is the active/visible one (prevents window-level hotkeys in background tabs)
  isActive?: boolean
  // Group chats use the compact shared agent controls
  isGroupMode?: boolean
  onGroupAgentsChange?: (agents: CoreAgentOption[]) => void
}

/**
 * Custom comparison for memo to prevent re-renders from unstable array references.
 * Compares messages by length and last message id, changedFiles by length and paths.
 */
function arePropsEqual(prevProps: ChatInputAreaProps, nextProps: ChatInputAreaProps): boolean {
  // Compare primitives and stable references first (fast path)
  if (
    prevProps.isStreaming !== nextProps.isStreaming ||
    prevProps.isCompacting !== nextProps.isCompacting ||
    prevProps.isUploading !== nextProps.isUploading ||
    prevProps.conversationId !== nextProps.conversationId ||
    prevProps.parentChatId !== nextProps.parentChatId ||
    prevProps.provider !== nextProps.provider ||
    prevProps.agentId !== nextProps.agentId ||
    prevProps.teamId !== nextProps.teamId ||
    prevProps.repository !== nextProps.repository ||
    prevProps.sandboxId !== nextProps.sandboxId ||
    prevProps.projectPath !== nextProps.projectPath ||
    prevProps.isMobile !== nextProps.isMobile ||
    prevProps.queueLength !== nextProps.queueLength ||
    prevProps.firstQueueItemId !== nextProps.firstQueueItemId ||
    prevProps.isActive !== nextProps.isActive
  ) {
    return false
  }

  if (
    prevProps.isGroupMode !== nextProps.isGroupMode
  ) {
    return false
  }

  // Compare refs by identity (they should be stable)
  if (
    prevProps.editorRef !== nextProps.editorRef ||
    prevProps.fileInputRef !== nextProps.fileInputRef
  ) {
    return false
  }

  // Compare callbacks by identity (they should be memoized in parent)
  if (
    prevProps.onSend !== nextProps.onSend ||
    prevProps.onForceSend !== nextProps.onForceSend ||
    prevProps.onStop !== nextProps.onStop ||
    prevProps.onCompact !== nextProps.onCompact ||
    prevProps.onCreateNewConversation !== nextProps.onCreateNewConversation ||
    prevProps.onModeChange !== nextProps.onModeChange ||
    prevProps.onAddAttachments !== nextProps.onAddAttachments ||
    prevProps.onRemoveImage !== nextProps.onRemoveImage ||
    prevProps.onRemoveFile !== nextProps.onRemoveFile ||
    prevProps.onRemoveTextContext !== nextProps.onRemoveTextContext ||
    prevProps.onAddPastedText !== nextProps.onAddPastedText ||
    prevProps.onRemovePastedText !== nextProps.onRemovePastedText ||
    prevProps.onInputContentChange !== nextProps.onInputContentChange ||
    prevProps.onSubmitWithQuestionAnswer !== nextProps.onSubmitWithQuestionAnswer ||
    prevProps.onProviderChange !== nextProps.onProviderChange ||
    prevProps.onContinueWithProvider !== nextProps.onContinueWithProvider ||
    prevProps.onSendFromQueue !== nextProps.onSendFromQueue
  ) {
    return false
  }

  if (
    prevProps.onGroupAgentsChange !== nextProps.onGroupAgentsChange
  ) {
    return false
  }

  // Compare textContexts array - by length and ids
  if (!prevProps.textContexts || !nextProps.textContexts) {
    return prevProps.textContexts === nextProps.textContexts
  }
  if (prevProps.textContexts.length !== nextProps.textContexts.length) {
    return false
  }
  for (let i = 0; i < prevProps.textContexts.length; i++) {
    if (prevProps.textContexts[i]?.id !== nextProps.textContexts[i]?.id) {
      return false
    }
  }

  // Compare diffTextContexts array - by length and ids
  const prevDiff = prevProps.diffTextContexts || []
  const nextDiff = nextProps.diffTextContexts || []
  if (prevDiff.length !== nextDiff.length) {
    return false
  }
  for (let i = 0; i < prevDiff.length; i++) {
    if (prevDiff[i]?.id !== nextDiff[i]?.id) {
      return false
    }
  }

  // Compare images array - by length and ids
  if (!prevProps.images || !nextProps.images) {
    return prevProps.images === nextProps.images
  }
  if (prevProps.images.length !== nextProps.images.length) {
    return false
  }
  for (let i = 0; i < prevProps.images.length; i++) {
    if (prevProps.images[i]?.id !== nextProps.images[i]?.id) {
      return false
    }
  }

  // Compare files array - by length and ids
  if (!prevProps.files || !nextProps.files) {
    return prevProps.files === nextProps.files
  }
  if (prevProps.files.length !== nextProps.files.length) {
    return false
  }
  for (let i = 0; i < prevProps.files.length; i++) {
    if (prevProps.files[i]?.id !== nextProps.files[i]?.id) {
      return false
    }
  }

  // Compare pastedTexts array - by length and ids
  const prevPasted = prevProps.pastedTexts || []
  const nextPasted = nextProps.pastedTexts || []
  if (prevPasted.length !== nextPasted.length) {
    return false
  }
  for (let i = 0; i < prevPasted.length; i++) {
    if (prevPasted[i]?.id !== nextPasted[i]?.id) {
      return false
    }
  }

  // Compare messageTokenData - only re-render when token counts actually change
  // This is much more stable than comparing messages array reference
  if (
    prevProps.messageTokenData.totalInputTokens !== nextProps.messageTokenData.totalInputTokens ||
    prevProps.messageTokenData.totalOutputTokens !== nextProps.messageTokenData.totalOutputTokens ||
    prevProps.messageTokenData.contextWindow !== nextProps.messageTokenData.contextWindow ||
    prevProps.messageTokenData.messageCount !== nextProps.messageTokenData.messageCount
  ) {
    return false
  }

  // Compare changedFiles - by length and filePaths
  if (!prevProps.changedFiles || !nextProps.changedFiles) {
    return prevProps.changedFiles === nextProps.changedFiles
  }
  if (prevProps.changedFiles.length !== nextProps.changedFiles.length) {
    return false
  }
  for (let i = 0; i < prevProps.changedFiles.length; i++) {
    if (prevProps.changedFiles[i]?.filePath !== nextProps.changedFiles[i]?.filePath) {
      return false
    }
  }

  return true
}

/**
 * ChatInputArea - Isolated input component to prevent re-renders of parent
 *
 * This component manages its own state for:
 * - hasContent (whether input has text)
 * - isFocused (editor focus state)
 * - isDragOver (drag/drop state)
 * - Mention dropdown state (showMentionDropdown, mentionSearchText, etc.)
 * - Slash command dropdown state
 * - Mode dropdown state
 * - Model dropdown state
 *
 * When user types, only this component re-renders, not the entire ChatViewInner.
 */
export const ChatInputArea = memo(function ChatInputArea({
  editorRef,
  fileInputRef,
  onSend,
  onForceSend,
  onStop,
  onCompact,
  onCreateNewConversation,
  onModeChange,
  isStreaming,
  isCompacting,
  images,
  files,
  onAddAttachments,
  onAddFolder,
  onRemoveImage,
  onRemoveFile,
  isUploading,
  textContexts,
  onRemoveTextContext,
  diffTextContexts,
  onRemoveDiffTextContext,
  pastedTexts = [],
  onAddPastedText,
  onRemovePastedText,
  onCacheFileContent,
  messageTokenData,
  conversationId,
  parentChatId,
  provider = "claude-code",
  agentId,
  teamId,
  repository,
  sandboxId,
  projectPath,
  changedFiles,
  isMobile = false,
  queueLength = 0,
  onSendFromQueue,
  firstQueueItemId,
  onInputContentChange,
  onSubmitWithQuestionAnswer,
  onProviderChange,
  onContinueWithProvider,
  isActive = true,
  isGroupMode = false,
  onGroupAgentsChange,
}: ChatInputAreaProps) {
  // Local state - changes here don't re-render parent
  const [hasContent, setHasContent] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)

  // ResizeObserver ref for cleanup
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  // Cleanup ResizeObserver on unmount
  useEffect(() => {
    return () => {
      resizeObserverRef.current?.disconnect()
    }
  }, [])

  // Mention dropdown state
  const [showMentionDropdown, setShowMentionDropdown] = useState(false)
  const [mentionSearchText, setMentionSearchText] = useState("")
  const [mentionPosition, setMentionPosition] = useState({ top: 0, left: 0 })
  const [mentionScope, setMentionScope] = useState<
    "agents" | "resources" | "all"
  >("agents")
  const [groupAgentIds, setGroupAgentIds] = useState<CoreAgentId[]>([
    "claude-code",
  ])
  const [coreAgents, setCoreAgents] = useState<CoreAgentOption[]>([])
  const registeredAgents = useAtomValue(registeredAgentsAtom)
  const setChatAgentLogos = useSetAtom(chatAgentLogosAtom)

  useEffect(() => {
    setGroupAgentIds(loadGroupAgentIds(parentChatId))
  }, [parentChatId])

  useEffect(() => {
    let cancelled = false

    void agentContractApi.listCoreAgents().then((options) => {
      if (!cancelled) setCoreAgents(options)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const boundGroupAgents = useMemo(
    () =>
      resolveGroupMentionAgents(
        groupAgentIds,
        coreAgents.filter((agent) => groupAgentIds.includes(agent.id)),
      ),
    [coreAgents, groupAgentIds],
  )

  useEffect(() => {
    onGroupAgentsChange?.(boundGroupAgents)
  }, [boundGroupAgents, onGroupAgentsChange])

  const handleGroupAgentIdsChange = useCallback(
    (agentIds: CoreAgentId[]) => {
      setGroupAgentIds(agentIds)
      saveGroupAgents(
        parentChatId,
        agentIds.map(
          (agentId) =>
            coreAgents.find((agent) => agent.id === agentId) ??
            resolveGroupMentionAgents([agentId], [])[0]!,
        ),
      )

      if (!isGroupMode) return

      const chatAgentLogos = createChatAgentLogos(
        agentIds,
        coreAgents,
        registeredAgents,
      )
      setChatAgentLogos((current) => {
        if (areVisibleChatAgentLogosEqual(current[parentChatId], chatAgentLogos)) {
          return current
        }

        return {
          ...current,
          [parentChatId]: chatAgentLogos,
        }
      })
    },
    [
      coreAgents,
      isGroupMode,
      parentChatId,
      registeredAgents,
      setChatAgentLogos,
    ],
  )

  // Mention dropdown subpage navigation state
  const [showingFilesList, setShowingFilesList] = useState(false)
  const [showingSkillsList, setShowingSkillsList] = useState(false)
  const [showingAgentsList, setShowingAgentsList] = useState(false)
  const [showingToolsList, setShowingToolsList] = useState(false)

  // Slash command dropdown state
  const [showSlashDropdown, setShowSlashDropdown] = useState(false)
  const [slashSearchText, setSlashSearchText] = useState("")
  const [slashPosition, setSlashPosition] = useState({ top: 0, left: 0 })

  // Model dropdown state
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false)
  const conversationModelIdAtom = useMemo(
    () => conversationModelIdAtomFamily(conversationId),
    [conversationId],
  )
  const [selectedConversationModelId, setSelectedConversationModelId] = useAtom(
    conversationModelIdAtom,
  )
  const conversationCodexModelIdAtom = useMemo(
    () => conversationCodexModelIdAtomFamily(conversationId),
    [conversationId],
  )
  const [selectedConversationCodexModelId, setSelectedConversationCodexModelId] = useAtom(
    conversationCodexModelIdAtom,
  )
  const conversationCodexThinkingAtom = useMemo(
    () => conversationCodexThinkingAtomFamily(conversationId),
    [conversationId],
  )
  const [selectedConversationCodexThinking, setSelectedConversationCodexThinking] = useAtom(
    conversationCodexThinkingAtom,
  )
  const [selectedOllamaModel, setSelectedOllamaModel] = useConversationOllamaModel(conversationId)
  const setLastSelectedModelId = useSetAtom(lastSelectedModelIdAtom)
  const setLastSelectedCodexModelId = useSetAtom(lastSelectedCodexModelIdAtom)
  const setLastSelectedCodexThinking = useSetAtom(lastSelectedCodexThinkingAtom)
  const availableModels = useAvailableModels()
  const isRuntimeModelProvider = provider !== "claude-code" && provider !== "codex"
  const [runtimeModel, setRuntimeModel] = useState<string | null>(null)
  const [isDetectingRuntimeModel, setIsDetectingRuntimeModel] = useState(false)
  const selectedModel = useMemo(
    () =>
      availableModels.models.find((model) => model.id === selectedConversationModelId) ||
      availableModels.models.find((model) => model.id === availableModels.currentModelId) ||
      availableModels.models[0],
    [availableModels.models, availableModels.currentModelId, selectedConversationModelId],
  )
  const runtimeModelLabel = useMemo(() => {
    if (runtimeModel) return runtimeModel
    if (isDetectingRuntimeModel) return "Detecting model…"
    return "Model unavailable"
  }, [runtimeModel, isDetectingRuntimeModel])

  const RuntimeModelIcon = getCoreAgentIcon(provider as CoreAgentId)

  useEffect(() => {
    if (!isRuntimeModelProvider || !agentId) {
      setRuntimeModel(null)
      setIsDetectingRuntimeModel(false)
      return
    }

    let cancelled = false
    setIsDetectingRuntimeModel(true)

    // ACP exposes the model as a config option when available; the existing
    // helper also handles cached snapshots and the /model fallback.
    const providerCommand = CORE_AGENT_OPTIONS.find(
      (option) => option.id === provider,
    )?.defaultCommand ?? provider

    void fetchAgentModels(agentId, providerCommand).then((result) => {
      if (cancelled) return
      setRuntimeModel(result?.current ?? result?.models?.[0] ?? null)
      setIsDetectingRuntimeModel(false)
    }).catch(() => {
      if (cancelled) return
      setRuntimeModel(null)
      setIsDetectingRuntimeModel(false)
    })

    return () => {
      cancelled = true
    }
  }, [agentId, isRuntimeModelProvider, provider])

  const hiddenModels = useAtomValue(hiddenModelsAtom)

  // Connection status for providers
  const anthropicOnboardingCompleted = useAtomValue(anthropicOnboardingCompletedAtom)
  const apiKeyOnboardingCompleted = useAtomValue(apiKeyOnboardingCompletedAtom)
  const { data: claudeCodeIntegration } =
    trpc.claudeCode.getIntegration.useQuery()
  const codexUiModels = useMemo(
    () => {
      const models = CODEX_MODELS
      return models.filter((model) => !hiddenModels.includes(model.id))
    },
    [hiddenModels],
  )
  const selectedCodexModel = useMemo(
    () =>
      codexUiModels.find((model) => model.id === selectedConversationCodexModelId) ||
      codexUiModels[0] ||
      CODEX_MODELS[0]!,
    [codexUiModels, selectedConversationCodexModelId],
  )

  const selectedCodexThinking = useMemo<CodexThinkingLevel>(() => {
    if (
      selectedCodexModel.thinkings.includes(
        selectedConversationCodexThinking as CodexThinkingLevel,
      )
    ) {
      return selectedConversationCodexThinking as CodexThinkingLevel
    }

    if (selectedCodexModel.thinkings.includes("high")) {
      return "high"
    }

    return selectedCodexModel.thinkings[0]!
  }, [selectedCodexModel, selectedConversationCodexThinking])

  useEffect(() => {
    if (
      selectedCodexModel.thinkings.includes(
        selectedConversationCodexThinking as CodexThinkingLevel,
      )
    ) {
      return
    }

    setSelectedConversationCodexThinking(selectedCodexThinking)
  }, [
    selectedCodexModel,
    selectedConversationCodexThinking,
    selectedCodexThinking,
    setSelectedConversationCodexThinking,
  ])

  // Materialize resolved Codex model/thinking into per-conversation? storage once mounted.
  // This prevents later global default changes from affecting existing conversations.
  useEffect(() => {
    if (provider !== "codex") return
    if (selectedCodexModel?.id) {
      setSelectedConversationCodexModelId(selectedCodexModel.id)
    }
    setSelectedConversationCodexThinking(selectedCodexThinking)
  }, [
    provider,
    selectedCodexModel?.id,
    selectedCodexThinking,
    setSelectedConversationCodexModelId,
    setSelectedConversationCodexThinking,
  ])

  const customClaudeConfig = useAtomValue(customClaudeConfigAtom)
  const normalizedCustomClaudeConfig =
    normalizeCustomClaudeConfig(customClaudeConfig)
  const hasCustomClaudeConfig = Boolean(normalizedCustomClaudeConfig)
  const isClaudeConnected =
    Boolean(claudeCodeIntegration?.isConnected) ||
    anthropicOnboardingCompleted ||
    apiKeyOnboardingCompleted ||
    hasCustomClaudeConfig

  // Determine current Ollama model (selected or recommended)
  const currentOllamaModel = selectedOllamaModel || availableModels.recommendedModel || availableModels.ollamaModels[0]

  // Extended thinking (reasoning) toggle
  const [thinkingEnabled, setThinkingEnabled] = useAtom(extendedThinkingEnabledAtom)

  const selectedModelLabel = useMemo(() => {
    if (provider === "codex") {
      return selectedCodexModel.name
    }

    if (availableModels.isOffline && availableModels.hasOllama) {
      return currentOllamaModel || "Ollama"
    }

    if (hasCustomClaudeConfig) {
      return "Custom Model"
    }

    if (!selectedModel) {
      return "Select model"
    }

    return `${selectedModel.name} ${selectedModel.version}`
  }, [
    provider,
    selectedCodexModel.name,
    availableModels.isOffline,
    availableModels.hasOllama,
    currentOllamaModel,
    hasCustomClaudeConfig,
    selectedModel,
  ])
  const canSwitchProvider =
    messageTokenData.messageCount === 0 && !isStreaming && !sandboxId

  // MCP status - from getAllMcpConfig query (provides global/local grouping)
  const setSettingsOpen = useSetAtom(agentsSettingsDialogOpenAtom)
  const setSettingsTab = useSetAtom(agentsSettingsDialogActiveTabAtom)

  const {
    data: allMcpConfig,
    isLoading: isMcpLoading,
    refetch: refetchMcp,
  } = trpc.mcp.getAllMcpConfig.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  })

  const [isMcpRefreshing, setIsMcpRefreshing] = useState(false)
  const isMcpBusy = isMcpLoading || isMcpRefreshing

  const handleRefreshMcp = useCallback(async () => {
    setIsMcpRefreshing(true)
    try {
      await refetchMcp()
    } finally {
      setIsMcpRefreshing(false)
    }
  }, [refetchMcp])

  // Extract global MCPs and project-specific MCPs
  const mcpGroups = useMemo(() => {
    if (!allMcpConfig?.groups) return { global: [], local: [] }

    const globalGroup = allMcpConfig.groups.find((g) => g.groupName === "Global")
    const localGroup = allMcpConfig.groups.find(
      (g) => g.projectPath && projectPath && g.projectPath === projectPath,
    )

    return {
      global: globalGroup?.mcpServers || [],
      local: localGroup?.mcpServers || [],
    }
  }, [allMcpConfig?.groups, projectPath])

  const totalMcps = mcpGroups.global.length + mcpGroups.local.length
  const connectedMcps =
    mcpGroups.global.filter((s) => s.status === "connected").length +
    mcpGroups.local.filter((s) => s.status === "connected").length

  // Auto-switch model based on network status (only if offline features enabled)
  // Note: When offline, we show Ollama models selector instead of Claude models
  // The selectedOllamaModel atom is used to track which Ollama model is selected

  // Plan mode - per-conversation? using atomFamily
  const conversationModeAtom = useMemo(
    () => conversationModeAtomFamily(conversationId),
    [conversationId],
  )
  const [conversationMode, setConversationMode] = useAtom(conversationModeAtom)

  // Helper to update mode (atomFamily + Zustand store sync)
  const updateMode = useCallback((newMode: AgentMode) => {
    if (onModeChange) {
      onModeChange(newMode)
      return
    }
    setConversationMode(newMode)
    useAgentConversationStore.getState().updateConversationMode(conversationId, newMode)
  }, [onModeChange, setConversationMode, conversationId])

  // Toggle mode helper
  const toggleMode = useCallback(() => {
    updateMode(getNextMode(conversationMode))
  }, [conversationMode, updateMode])

  // Voice input state
  const {
    isRecording: isVoiceRecording,
    audioLevel: voiceAudioLevel,
    startRecording: startVoiceRecording,
    stopRecording: stopVoiceRecording,
    cancelRecording: cancelVoiceRecording,
  } = useVoiceRecording()
  const [isTranscribing, setIsTranscribing] = useState(false)
  const voiceMountedRef = useRef(true)

  useEffect(() => {
    voiceMountedRef.current = true
    return () => {
      voiceMountedRef.current = false
    }
  }, [])

  // Voice transcription is disabled until a local provider is connected.
  const isVoiceAvailable = false

  // Get resolved voice input hotkey
  const customHotkeys = useAtomValue(customHotkeysAtom)
  const voiceInputHotkey = getResolvedHotkey("voice-input", customHotkeys)

  // Refs for draft saving
  const currentConversationIdRef = useRef<string>(conversationId)
  const currentChatIdRef = useRef<string | null>(parentChatId)
  const currentDraftTextRef = useRef<string>("")
  const folderInputRef = useRef<HTMLInputElement>(null)
  currentConversationIdRef.current = conversationId
  currentChatIdRef.current = parentChatId

  // Keyboard shortcut: Cmd+/ to open model selector
  useEffect(() => {
    if (!isActive) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "/") {
        e.preventDefault()
        e.stopPropagation()
        const shouldBlockForCustomClaude =
          provider === "claude-code" && hasCustomClaudeConfig
        if (!shouldBlockForCustomClaude) {
          setIsModelDropdownOpen(true)
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [hasCustomClaudeConfig, provider, isActive])

  // Voice input handlers
  const handleVoiceMouseDown = useCallback(async () => {
    if (isStreaming || isTranscribing || isVoiceRecording) return
    try {
      await startVoiceRecording()
    } catch (err) {
      console.error("[VoiceInput] Failed to start recording:", err)
      toast.error(err instanceof Error ? err.message : "Failed to start recording")
    }
  }, [isStreaming, isTranscribing, isVoiceRecording, startVoiceRecording])

  const handleVoiceMouseUp = useCallback(async () => {
    if (!isVoiceRecording) return

    await stopVoiceRecording()
  }, [isVoiceRecording, stopVoiceRecording])

  const handleVoiceMouseLeave = useCallback(() => {
    if (isVoiceRecording) {
      // Cancel instead of transcribing when leaving button area
      cancelVoiceRecording()
    }
  }, [isVoiceRecording, cancelVoiceRecording])

  // Auto-cancel recording when window loses focus (prevents stuck recording if keyup never fires)
  useEffect(() => {
    if (!isVoiceRecording) return

    const handleFocusLoss = () => {
      cancelVoiceRecording()
    }

    const handleVisibilityChange = () => {
      if (document.hidden) cancelVoiceRecording()
    }

    window.addEventListener("blur", handleFocusLoss)
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => {
      window.removeEventListener("blur", handleFocusLoss)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [isVoiceRecording, cancelVoiceRecording])

  // Keyboard shortcut: Voice input hotkey (push-to-talk: hold to record, release to transcribe)
  useEffect(() => {
    if (!voiceInputHotkey) return
    if (!isActive) return

    // Parse hotkey once
    const parts = voiceInputHotkey.split("+").map(p => p.toLowerCase())
    const modifiers = parts.filter(p => ["cmd", "meta", "ctrl", "opt", "alt", "shift"].includes(p))
    const mainKey = parts.find(p => !["cmd", "meta", "ctrl", "opt", "alt", "shift"].includes(p))

    const needsCmd = modifiers.includes("cmd") || modifiers.includes("meta")
    const needsShift = modifiers.includes("shift")
    const needsCtrl = modifiers.includes("ctrl")
    const needsAlt = modifiers.includes("alt") || modifiers.includes("opt")

    // For modifier-only hotkeys (like ctrl+opt), we track when all modifiers are pressed
    const isModifierOnlyHotkey = !mainKey

    const modifiersMatch = (e: KeyboardEvent) => {
      return (
        e.metaKey === needsCmd &&
        e.shiftKey === needsShift &&
        e.ctrlKey === needsCtrl &&
        e.altKey === needsAlt
      )
    }

    const matchesHotkey = (e: KeyboardEvent) => {
      if (isModifierOnlyHotkey) {
        // For modifier-only: just check if all required modifiers are pressed
        return modifiersMatch(e)
      }

      // For regular hotkey with main key
      const keyMatches =
        e.key.toLowerCase() === mainKey ||
        e.code.toLowerCase() === mainKey ||
        e.code.toLowerCase() === `key${mainKey}` ||
        (mainKey === "space" && e.code === "Space")

      return keyMatches && modifiersMatch(e)
    }

    // Check if any modifier key is released
    const isModifierRelease = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      return key === "control" || key === "alt" || key === "meta" || key === "shift"
    }

    // Check if the released key is the main key (not a modifier)
    const isMainKeyRelease = (e: KeyboardEvent) => {
      if (isModifierOnlyHotkey) {
        return isModifierRelease(e)
      }
      const eventKey = e.key.toLowerCase()
      return (
        eventKey === mainKey ||
        e.code.toLowerCase() === mainKey ||
        e.code.toLowerCase() === `key${mainKey}` ||
        (mainKey === "space" && e.code === "Space")
      )
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!matchesHotkey(e)) return
      if (e.repeat) return // Ignore key repeat

      e.preventDefault()
      e.stopPropagation()

      // Start recording on keydown
      if (!isVoiceRecording && !isTranscribing && !isStreaming) {
        handleVoiceMouseDown()
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      // Stop recording when the main key (or any modifier for modifier-only hotkeys) is released
      if (!isMainKeyRelease(e)) return

      // Only stop if we're currently recording
      if (isVoiceRecording) {
        e.preventDefault()
        e.stopPropagation()
        handleVoiceMouseUp()
      }
    }

    window.addEventListener("keydown", handleKeyDown, true)
    window.addEventListener("keyup", handleKeyUp, true)
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true)
      window.removeEventListener("keyup", handleKeyUp, true)
    }
  }, [voiceInputHotkey, isVoiceRecording, isTranscribing, isStreaming, handleVoiceMouseDown, handleVoiceMouseUp, isActive])

  // Save draft on blur (with attachments and text contexts)
  const handleEditorBlur = useCallback(async () => {
    setIsFocused(false)

    const draft = editorRef.current?.getValue() || ""
    const chatId = currentChatIdRef.current
    const conversationIdValue = currentConversationIdRef.current

    // Update ref for unmount save
    currentDraftTextRef.current = draft

    if (!chatId) return

    const hasContent =
      draft.trim() ||
      images.length > 0 ||
      files.length > 0 ||
      textContexts.length > 0 ||
      (diffTextContexts?.length ?? 0) > 0

    if (hasContent) {
      await saveConversationDraftWithAttachments(chatId, conversationIdValue, draft, {
        images,
        files,
        textContexts,
      })
    } else {
      clearConversationDraft(chatId, conversationIdValue)
    }
  }, [editorRef, images, files, textContexts, diffTextContexts])

  // Content change handler
  const handleContentChange = useCallback((newHasContent: boolean) => {
    setHasContent(newHasContent)
    onInputContentChange?.(newHasContent)
    // Sync the draft text ref for unmount save
    const draft = editorRef.current?.getValue() || ""
    currentDraftTextRef.current = draft
  }, [editorRef, onInputContentChange])

  // Editor submit handler - handles Enter key with queue logic
  // If input is empty and queue has items, stop stream and send first from queue
  const handleEditorSubmit = useCallback(async () => {
    const inputValue = editorRef.current?.getValue() || ""
    const hasText = inputValue.trim().length > 0
    const hasAttachments = images.length > 0 || files.length > 0 || textContexts.length > 0 || (diffTextContexts?.length ?? 0) > 0

    if (!hasText && !hasAttachments && queueLength > 0 && onSendFromQueue && firstQueueItemId) {
      // Input empty, queue has items - stop stream and send from queue
      await onStop()
      onSendFromQueue(firstQueueItemId)
    } else {
      onSend()
    }
  }, [editorRef, images, files, textContexts, diffTextContexts, queueLength, onSendFromQueue, firstQueueItemId, onStop, onSend])

  // Mention select handler
  const handleMentionSelect = useCallback((mention: FileMentionOption) => {
    // Category navigation - enter subpage instead of inserting mention
    if (mention.type === "category") {
      if (mention.id === "files") {
        setShowingFilesList(true)
        return
      }
      if (mention.id === "skills") {
        setShowingSkillsList(true)
        return
      }
      if (mention.id === "agents") {
        setShowingAgentsList(true)
        return
      }
      if (mention.id === "tools") {
        setShowingToolsList(true)
        return
      }
    }

    // Otherwise: insert mention as normal
    editorRef.current?.insertMention(mention)
    setShowMentionDropdown(false)
    // Reset subpage state
    setShowingFilesList(false)
    setShowingSkillsList(false)
    setShowingAgentsList(false)
    setShowingToolsList(false)
  }, [editorRef])

  // Slash command handlers
  const handleSlashTrigger = useCallback(
    ({ searchText, rect }: { searchText: string; rect: DOMRect }) => {
      setSlashSearchText(searchText)
      setSlashPosition({ top: rect.top, left: rect.left })
      setShowSlashDropdown(true)
    },
    [],
  )

  const handleCloseSlashTrigger = useCallback(() => {
    setShowSlashDropdown(false)
  }, [])

  const handleSlashSelect = useCallback(
    (command: SlashCommandOption) => {
      // Clear the slash command text from editor
      editorRef.current?.clearSlashCommand()
      setShowSlashDropdown(false)

      // Handle builtin commands that change app state (no text input needed)
      if (command.category === "builtin") {
        switch (command.name) {
          case "clear":
            // Create a new conversation (fresh conversation)
            if (onCreateNewConversation) {
              onCreateNewConversation()
            }
            return
          case "plan":
            if (conversationMode !== "plan") {
              updateMode("plan")
            }
            return
          case "agent":
            if (conversationMode === "plan") {
              updateMode("agent")
            }
            return
          case "files":
            setMentionScope("resources")
            setShowingFilesList(true)
            setShowMentionDropdown(true)
            return
          case "skills":
            setMentionScope("resources")
            setShowingSkillsList(true)
            setShowMentionDropdown(true)
            return
          case "mcp":
            setMentionScope("resources")
            setShowingToolsList(true)
            setShowMentionDropdown(true)
            return
          case "compact":
            // Trigger context compaction
            onCompact()
            return
        }
      }

      // For all other commands (builtin prompts):
      // insert the command and let user add arguments or press Enter to send
      editorRef.current?.setValue(`/${command.name} `)
    },
    [conversationMode, updateMode, onCreateNewConversation, onCompact, editorRef],
  )

  // Paste handler for images, plain text, and large text (saved as files)
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => handlePasteEvent(e, onAddAttachments, onAddPastedText),
    [onAddAttachments, onAddPastedText],
  )

  // Drag/drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])



  // Pick a folder via the native file input with webkitdirectory
  const handlePickFolder = useCallback(() => {
    folderInputRef.current?.click()
  }, [])

  // Handle folder selection from the file input
  // Creates a folder attachment card instead of expanding all files
  const handleFolderSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const inputFiles = Array.from(e.target.files || [])
    if (inputFiles.length === 0) return

    // Extract folder name from the first file's relative path
    const firstFile = inputFiles[0]
    const relativePath = (firstFile as File & { webkitRelativePath?: string }).webkitRelativePath || ""
    const folderName = relativePath.split("/")[0] || firstFile.name

    // Collect all file paths in the folder
    const filePaths = inputFiles.map(f =>
      (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
    )

    // Create a folder attachment card
    if (onAddFolder) {
      onAddFolder(folderName, filePaths)
    } else {
      // Fallback: add all files as attachments
      onAddAttachments(inputFiles)
    }

    // Reset the input so it can be used again
    e.target.value = ""

    // Focus the editor
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        editorRef.current?.focus()
      })
    })
  }, [editorRef, onAddAttachments, onAddFolder])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)

      // Detect directories (webkitGetAsEntry is available in Chromium/Electron).
      // Dropped folders become a single folder mention chip (like file chips
      // but with a folder icon); files continue through existing logic.
      const items = Array.from(e.dataTransfer.items)

      // Helper function to recursively read all files from a directory entry
      const readDirectoryFiles = (entry: FileSystemDirectoryEntry): Promise<File[]> => {
        return new Promise((resolve, reject) => {
          const files: File[] = []
          const reader = entry.createReader()

          const readEntries = () => {
            reader.readEntries(async (entries) => {
              if (entries.length === 0) {
                resolve(files)
                return
              }

              for (const ent of entries) {
                if (ent.isFile) {
                  const fileEntry = ent as FileSystemFileEntry
                  try {
                    const file = await new Promise<File>((res, rej) => {
                      fileEntry.file(res, rej)
                    })
                    files.push(file)
                  } catch (err) {
                    console.error(`[handleDrop] Failed to read file:`, err)
                  }
                } else if (ent.isDirectory) {
                  const subFiles = await readDirectoryFiles(ent as FileSystemDirectoryEntry)
                  files.push(...subFiles)
                }
              }

              // Continue reading (readEntries returns up to 100 entries at a time)
              readEntries()
            }, reject)
          }

          readEntries()
        })
      }

      // Separate folders from individual files
      const droppedFolders: { name: string; files: File[] }[] = []
      const droppedIndividualFiles: File[] = []

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (!item) continue

        const entry = item.webkitGetAsEntry?.()
        if (entry?.isDirectory) {
          // It's a folder - read all files and store as folder card
          try {
            const files = await readDirectoryFiles(entry as FileSystemDirectoryEntry)
            const folderName = entry.name
            droppedFolders.push({ name: folderName, files })
          } catch (err) {
            console.error(`[handleDrop] Failed to read directory:`, err)
          }
        } else if (entry?.isFile) {
          // It's a regular file
          const file = item.getAsFile()
          if (file) {
            droppedIndividualFiles.push(file)
          }
        }
      }

      // Handle individual files (non-folder drops)
      if (droppedIndividualFiles.length > 0) {
        // Cache text file content for agent
        for (const file of droppedIndividualFiles) {
          const ext = file.name.includes(".") ? "." + file.name.split(".").pop()?.toLowerCase() : ""
          const hasExtension = ext !== ""
          const isTextFile = hasExtension && TEXT_FILE_EXTENSIONS.has(ext)
          const isSmallEnough = file.size <= 100 * 1024 // 100KB

          if (isTextFile && isSmallEnough && onCacheFileContent) {
            const filePath = window.webUtils?.getPathForFile?.(file) || (file as File & { path?: string }).path
            let mentionId: string
            if (projectPath && filePath && filePath.startsWith(projectPath)) {
              const relativePath = filePath.slice(projectPath.length).replace(/^\//, "")
              mentionId = `file:local:${relativePath}`
            } else if (filePath) {
              mentionId = `file:external:${filePath}`
            } else {
              mentionId = `file:external:${file.name}`
            }

            // Read and cache content asynchronously (don't block attachment UI)
            file.text().then(content => {
              onCacheFileContent(mentionId, content)
            }).catch(err => {
              console.error(`[handleDrop] Failed to read file content ${filePath}:`, err)
            })
          }
        }

        onAddAttachments(droppedIndividualFiles)
      }

      // Handle folders - create folder cards
      if (droppedFolders.length > 0 && onAddFolder) {
        for (const folder of droppedFolders) {
          // Extract file paths relative to the folder
          const filePaths = folder.files.map(f => {
            // For dropped folders, we don't have webkitRelativePath, so use file.name
            // The folder name is already captured in folder.name
            return f.name
          })
          onAddFolder(folder.name, filePaths)

          // Cache text file content for files inside the folder
          for (const file of folder.files) {
            const ext = file.name.includes(".") ? "." + file.name.split(".").pop()?.toLowerCase() : ""
            const hasExtension = ext !== ""
            const isTextFile = hasExtension && TEXT_FILE_EXTENSIONS.has(ext)
            const isSmallEnough = file.size <= 100 * 1024 // 100KB

            if (isTextFile && isSmallEnough && onCacheFileContent) {
              const filePath = window.webUtils?.getPathForFile?.(file) || (file as File & { path?: string }).path
              let mentionId: string
              if (projectPath && filePath && filePath.startsWith(projectPath)) {
                const relativePath = filePath.slice(projectPath.length).replace(/^\//, "")
                mentionId = `file:local:${relativePath}`
              } else if (filePath) {
                mentionId = `file:external:${filePath}`
              } else {
                mentionId = `file:external:${file.name}`
              }

              file.text().then(content => {
                onCacheFileContent(mentionId, content)
              }).catch(err => {
                console.error(`[handleDrop] Failed to read file content ${filePath}:`, err)
              })
            }
          }
        }
      } else if (droppedFolders.length > 0) {
        // Fallback: if onAddFolder is not available, expand folders into individual files
        const allFolderFiles = droppedFolders.flatMap(f => f.files)
        onAddAttachments(allFolderFiles)
      }

      // Focus after state update - use double rAF to wait for React render
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          editorRef.current?.focus()
        })
      })
    },
    [editorRef, projectPath, onAddAttachments, onAddFolder, onCacheFileContent],
  )

  return (
    <div
      ref={(el) => {
        if (!el) return
        if (el.dataset.observed) return
        el.dataset.observed = "true"
        const parent = el.parentElement
        const observer = new ResizeObserver((entries) => {
          const { height, width } = entries[0]?.contentRect ?? {
            height: 0,
            width: 0,
          }
          el.style.setProperty("--chat-input-height", `${height}px`)
          el.style.setProperty("--chat-input-width", `${width}px`)
          parent?.style.setProperty("--chat-input-height", `${height}px`)
          parent?.style.setProperty("--chat-input-width", `${width}px`)
        })
        observer.observe(el)
        resizeObserverRef.current = observer
      }}
      className="px-2 pb-2 shadow-sm shadow-background relative z-10"
    >
      <div className="w-full max-w-2xl mx-auto">
        <div
          className="relative w-full"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div
            className="relative w-full cursor-text"
            onClick={() => editorRef.current?.focus()}
          >
            <PromptInput
              className={cn(
                "border bg-input-background relative z-10 p-2 rounded-xl transition-[border-color,box-shadow] duration-150",
                isDragOver && "ring-2 ring-primary/50 border-primary/50",
                isFocused && !isDragOver && "ring-2 ring-primary/50",
              )}
              maxHeight={200}
              onSubmit={onSend}
              contextItems={
                images.length > 0 || files.length > 0 || textContexts.length > 0 || (diffTextContexts?.length ?? 0) > 0 || pastedTexts.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-[6px]">
                    {(() => {
                      // Build allImages array for gallery navigation
                      const allImages = images
                        .filter((img): img is typeof img & { url: string } => !!img.url && !img.isLoading)
                        .map((img) => ({
                          id: img.id,
                          filename: img.filename,
                          url: img.url,
                        }))

                      return images.map((img, idx) => (
                        <AgentImageItem
                          key={img.id}
                          id={img.id}
                          filename={img.filename}
                          url={img.url || ""}
                          isLoading={img.isLoading}
                          onRemove={() => onRemoveImage(img.id)}
                          allImages={allImages}
                          imageIndex={idx}
                        />
                      ))
                    })()}
                    {files.map((f) => (
                      <AgentFileItem
                        key={f.id}
                        filename={f.filename}
                        size={f.size}
                        isLoading={f.isLoading}
                        onRemove={() => onRemoveFile(f.id)}
                        isFolder={f.isFolder}
                        fileCount={f.folderFiles?.length}
                      />
                    ))}
                    {textContexts.map((tc) => (
                      <AgentTextContextItem
                        key={tc.id}
                        text={tc.text}
                        preview={tc.preview}
                        onRemove={() => onRemoveTextContext(tc.id)}
                      />
                    ))}
                    {diffTextContexts?.map((dtc) => (
                      <AgentDiffTextContextItem
                        key={dtc.id}
                        filePath={dtc.filePath}
                        lineNumber={dtc.lineNumber}
                        lineType={dtc.lineType}
                        onRemove={onRemoveDiffTextContext ? () => onRemoveDiffTextContext(dtc.id) : undefined}
                      />
                    ))}
                    {pastedTexts.map((pt) => (
                      <AgentPastedTextItem
                        key={pt.id}
                        preview={pt.preview}
                        kind={pt.kind}
                        onRemove={onRemovePastedText ? () => onRemovePastedText(pt.id) : undefined}
                      />
                    ))}
                  </div>
                ) : null
              }
            >
              <PromptInputContextItems />
              <div className="relative">
                <AgentsMentionsEditor
                  ref={editorRef}
                  onTrigger={({ searchText, rect }) => {
                    // Desktop: use projectPath for local file search
                    if (projectPath || repository) {
                      setMentionScope("agents")
                      setMentionSearchText(searchText)
                      setMentionPosition({ top: rect.top, left: rect.left })
                      setShowMentionDropdown(true)
                    }
                  }}
                  onCloseTrigger={() => {
                    setShowMentionDropdown(false)
                    // Reset subpage state when closing
                    setShowingFilesList(false)
                    setShowingSkillsList(false)
                    setShowingAgentsList(false)
                    setShowingToolsList(false)
                  }}
                  onSlashTrigger={handleSlashTrigger}
                  onCloseSlashTrigger={handleCloseSlashTrigger}
                  onContentChange={handleContentChange}
                  onSubmit={onSubmitWithQuestionAnswer || handleEditorSubmit}
                  onForceSubmit={onForceSend}
                  onShiftTab={toggleMode}
                  placeholder={isStreaming ? "Add to the queue" : "Plan, @ for agent, / for commands"}
                  className={cn(
                    "bg-transparent max-h-[200px] overflow-y-auto p-1",
                    isMobile && "min-h-[56px]",
                  )}
                  onPaste={handlePaste}
                  onFocus={() => setIsFocused(true)}
                  onBlur={handleEditorBlur}
                />
              </div>
              <PromptInputActions className="w-full">
                <div className="flex items-center gap-0.5 flex-1 min-w-0">
	                    {/* Mode toggle (Agent/Plan) */}

	                    <div className="group/model-controls flex items-center gap-0.5">
	                    {!isGroupMode && (
	                      isRuntimeModelProvider ? (
	                        <button
	                          type="button"
	                          disabled
	                          className="flex h-7 items-center gap-1.5 px-2 text-sm text-muted-foreground opacity-100 disabled:opacity-100"
	                          title={`Detected ${provider} model`}
	                        >
	                          {isDetectingRuntimeModel ? (
	                            <IconSpinner className="h-4 w-4 shrink-0" />
	                          ) : (
	                            <RuntimeModelIcon className="h-4 w-4 shrink-0" />
	                          )}
	                          <span className="max-w-40 truncate">{runtimeModelLabel}</span>
	                        </button>
	                      ) : (
	                      <AgentModelSelector
	                        open={isModelDropdownOpen}
	                        onOpenChange={setIsModelDropdownOpen}
	                        selectedAgentId={provider === "codex" ? "codex" : "claude-code"}
	                        onSelectedAgentIdChange={(nextProvider) => {
	                          if (!canSwitchProvider) return
	                          if (nextProvider === provider) return
	                          onProviderChange?.(nextProvider)
	                        }}
	                        allowProviderSwitch={canSwitchProvider}
	                        onContinueWithProvider={!canSwitchProvider ? onContinueWithProvider : undefined}
	                        selectedModelLabel={selectedModelLabel}
	                        claude={{
	                          models: availableModels.models.filter((m) => !hiddenModels.includes(m.id)),
	                          selectedModelId: selectedModel?.id,
	                          onSelectModel: (modelId) => {
	                            const model =
	                              availableModels.models.find((item) => item.id === modelId) ||
	                              availableModels.models[0]
	                            if (!model) return
	                            setSelectedConversationModelId(model.id)
	                            setLastSelectedModelId(model.id)
	                          },
	                          hasCustomModelConfig: hasCustomClaudeConfig,
	                          isOffline: availableModels.isOffline && availableModels.hasOllama,
	                          ollamaModels: availableModels.ollamaModels,
	                          selectedOllamaModel: currentOllamaModel,
	                          recommendedOllamaModel: availableModels.recommendedModel,
	                          onSelectOllamaModel: setSelectedOllamaModel,
	                          isConnected: isClaudeConnected,
	                          thinkingEnabled,
	                          onThinkingChange: setThinkingEnabled,
	                        }}
	                        codex={{
	                          models: codexUiModels,
	                          selectedModelId: selectedCodexModel.id,
	                          onSelectModel: (modelId) => {
	                            const model = codexUiModels.find((item) => item.id === modelId)
	                            if (!model) return
	                            const nextThinking = model.thinkings.includes(
	                              selectedConversationCodexThinking as CodexThinkingLevel,
	                            )
	                              ? (selectedConversationCodexThinking as CodexThinkingLevel)
	                              : (model.thinkings.includes("high")
	                                ? "high"
	                                : model.thinkings[0]!)

	                            setSelectedConversationCodexModelId(model.id)
	                            setSelectedConversationCodexThinking(nextThinking)
	                            setLastSelectedCodexModelId(model.id)
	                            setLastSelectedCodexThinking(nextThinking)
	                          },
	                          selectedThinking: selectedCodexThinking,
	                          onSelectThinking: (thinking) => {
	                            setSelectedConversationCodexThinking(thinking)
	                            setLastSelectedCodexThinking(thinking)
	                          },
	                          isConnected: false,
	                        }}
	                      />
	                      )
	                    )}
	                    {!isRuntimeModelProvider && <PermissionModeSelector />}
                  </div>

                </div>

                <div className="flex items-center gap-0.5 ml-auto flex-shrink-0">
                  {/* Hidden file input - accepts any files */}
                  <input
                    type="file"
                    ref={fileInputRef}
                    hidden
                    multiple
                    onChange={(e) => {
                      const inputFiles = Array.from(e.target.files || [])
                      onAddAttachments(inputFiles)
                      e.target.value = ""
                    }}
                  />
                  {/* Hidden folder input - accepts folders */}
                  <input
                    type="file"
                    ref={folderInputRef}
                    hidden
                    {...({ webkitdirectory: "", directory: "" } as any)}
                    onChange={handleFolderSelected}
                  />
                  {/* Voice wave indicator / transcribing state / normal toolbar */}
                  {isVoiceRecording ? (
                    <VoiceWaveIndicator isRecording={isVoiceRecording} audioLevel={voiceAudioLevel} />
                  ) : isTranscribing ? (
                    <div className="flex items-center px-2 h-5">
                      <IconSpinner className="size-3.5 text-muted-foreground" />
                    </div>
                  ) : (
                    <>
                      {/* Context window indicator - click to compact */}
                      <AgentContextIndicator
                        tokenData={messageTokenData}
                        // onCompact={onCompact}
                        isCompacting={isCompacting}
                        disabled={isStreaming}
                      />

                      {/* Attachment button */}
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 rounded-sm outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70"
                            disabled={images.length >= 5 && files.length >= 10}
                          >
                            <AttachIcon className="h-4 w-4" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-auto p-1">
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded-sm px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                            onClick={() => {
                              fileInputRef.current?.click()
                            }}
                          >
                            上传文件
                          </button>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded-sm px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                            onClick={handlePickFolder}
                          >
                            上传文件夹
                          </button>
                        </PopoverContent>
                      </Popover>
                    </>
                  )}

                  {/* Send/Stop/Voice button */}
                  <div className="ml-1">
                    <AgentSendButton
                      isStreaming={isStreaming}
                      isSubmitting={false}
                      disabled={
                        (!hasContent &&
                          images.length === 0 &&
                          files.length === 0 &&
                          textContexts.length === 0 &&
                          (diffTextContexts?.length ?? 0) === 0 &&
                          queueLength === 0) ||
                        isUploading
                      }
                      hasContent={hasContent || images.length > 0 || files.length > 0 || textContexts.length > 0 || (diffTextContexts?.length ?? 0) > 0}
                      onClick={() => {
                        // If input is empty and queue has items, send first queue item
                        if (!hasContent && images.length === 0 && files.length === 0 && queueLength > 0 && onSendFromQueue && firstQueueItemId) {
                          onSendFromQueue(firstQueueItemId)
                        } else {
                          onSend()
                        }
                      }}
                      onStop={onStop}
                      mode={conversationMode}
                      // Voice input props - show mic when input is empty and voice is available
                      showVoiceInput={isVoiceAvailable}
                      isRecording={isVoiceRecording}
                      isTranscribing={isTranscribing}
                      onVoiceMouseDown={handleVoiceMouseDown}
                      onVoiceMouseUp={handleVoiceMouseUp}
                      onVoiceMouseLeave={handleVoiceMouseLeave}
                    />
                  </div>
                </div>
              </PromptInputActions>
            </PromptInput>
          </div>
        </div>
      </div>

      {/* File mention dropdown */}
      {/* Desktop: use projectPath for local file search */}
      <AgentsFileMention
        isOpen={
          showMentionDropdown &&
          (!!projectPath || !!repository || !!sandboxId)
        }
        onClose={() => {
          setShowMentionDropdown(false)
          // Reset subpage state when closing
          setShowingFilesList(false)
          setShowingSkillsList(false)
          setShowingAgentsList(false)
          setShowingToolsList(false)
        }}
        onSelect={handleMentionSelect}
        searchText={mentionSearchText}
        position={mentionPosition}
        teamId={teamId}
        repository={repository}
        sandboxId={sandboxId}
        projectPath={projectPath}
        changedFiles={changedFiles}
        // Subpage navigation state
        showingFilesList={showingFilesList}
        showingSkillsList={showingSkillsList}
        showingAgentsList={showingAgentsList}
        showingToolsList={showingToolsList}
        scope={mentionScope}
        boundAgents={isGroupMode ? boundGroupAgents : undefined}
      />

      {/* Slash command dropdown */}
      <AgentsSlashCommand
        isOpen={showSlashDropdown}
        onClose={handleCloseSlashTrigger}
        onSelect={handleSlashSelect}
        searchText={slashSearchText}
        position={slashPosition}
        chatId={parentChatId}
        mode={conversationMode}
      />
    </div>
  )
}, arePropsEqual)
