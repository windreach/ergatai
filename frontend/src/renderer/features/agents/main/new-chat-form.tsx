"use client"

import { useVirtualizer } from "@tanstack/react-virtual"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { AlignJustify, Plus, TerminalSquare } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "../../../components/ui/button"
import {
  AttachIcon,
  BranchIcon,
  CheckIcon,
  IconChevronDown,
  IconOpenSidebarRight,
  SearchIcon,
} from "../../../components/ui/icons"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../../components/ui/tooltip"
import { cn } from "../../../lib/utils"
import {
  agentsDebugModeAtom,
  chatAgentLogosAtom,
  createChatAgentLogos,
  justCreatedIdsAtom,
  lastSelectedAgentIdAtom,
  lastSelectedCodexModelIdAtom,
  lastSelectedCodexThinkingAtom,
  lastSelectedBranchesAtom,
  lastSelectedModelIdAtom,
  lastSelectedRepoAtom,
  lastSelectedWorkModeAtom,
  selectedAgentChatIdAtom,
  selectedDraftIdAtom,
  selectedWorkspaceAtom,
  registeredAgentsAtom,
  getNextMode,
  type AgentMode,
} from "../atoms"
import { defaultAgentModeAtom } from "../../../lib/atoms"
import { WorkModeSelector } from "../components/work-mode-selector"
import { PermissionModeSelector } from "../components/permission-mode-selector"
// import { selectedTeamIdAtom } from "@/lib/atoms/team"
import { atom } from "jotai"
const selectedTeamIdAtom = atom<string | null>(null)
import {
  agentsSettingsDialogOpenAtom,
  agentsSettingsDialogActiveTabAtom,
  anthropicOnboardingCompletedAtom,
  apiKeyOnboardingCompletedAtom,
  customClaudeConfigAtom,
  extendedThinkingEnabledAtom,
  hiddenModelsAtom,
  normalizeCustomClaudeConfig,
  showOfflineModeFeaturesAtom,
  selectedOllamaModelAtom,
  customHotkeysAtom,
} from "../../../lib/atoms"
// Desktop uses real tRPC
import { toast } from "sonner"
import { trpc, trpcClient } from "../../../lib/trpc"
import {
  AgentsSlashCommand,
  COMMAND_PROMPTS,
  type SlashCommandOption,
} from "../commands"
import { useAgentsFileUpload } from "../hooks/use-agents-file-upload"
import { usePastedTextFiles } from "../hooks/use-pasted-text-files"
import { useFocusInputOnEnter } from "../hooks/use-focus-input-on-enter"
import { useToggleFocusOnCmdEsc } from "../hooks/use-toggle-focus-on-cmd-esc"
import {
  useVoiceRecording,
} from "../../../lib/hooks/use-voice-recording"
import { getResolvedHotkey } from "../../../lib/hotkeys"
import {
  AgentsFileMention,
  AgentsMentionsEditor,
  MENTION_PREFIXES,
  type AgentsMentionsEditorHandle,
  type FileMentionOption,
} from "../mentions"
import { AgentFileItem } from "../ui/agent-file-item"
import { AgentImageItem } from "../ui/agent-image-item"
import { AgentPastedTextItem } from "../ui/agent-pasted-text-item"
import { AgentsHeaderControls } from "../ui/agents-header-controls"
import { VoiceWaveIndicator } from "../ui/voice-wave-indicator"
// import { CreateBranchDialog } from "@/app/(alpha)/agents/{components}/create-branch-dialog"
import {
  PromptInput,
  PromptInputActions,
  PromptInputContextItems,
} from "../../../components/ui/prompt-input"
import { ResizableBottomPanel } from "../../../components/ui/resizable-bottom-panel"
import {
  agentsSidebarOpenAtom,
  agentsConversationsSidebarModeAtom,
  agentsUnseenChangesAtom,
} from "../atoms"
import {
  detailsSidebarOpenAtom,
} from "../../details-sidebar/atoms"
import { DetailsSidebar } from "../../details-sidebar/details-sidebar"
import {
  terminalBottomHeightAtom,
  terminalDisplayModeAtom,
  terminalSidebarOpenAtomFamily,
} from "../../terminal/atoms"
import {
  TerminalBottomPanelContent,
  TerminalSidebar,
} from "../../terminal/terminal-sidebar"
import { getTerminalScopeKey } from "../../terminal/utils"
import { AgentSendButton } from "../components/agent-send-button"
import { WorkspaceSelector } from "../components/workspace-selector"
import { useCollaborationMode } from "../collaboration/use-collaboration-mode"
import {
  resolveGroupMentionAgents,
  saveGroupAgents,
} from "../collaboration/group-agent-storage"
import {
  setGroupAgentRuntimeStatuses,
  type GroupAgentRuntimeStatuses,
} from "../collaboration/group-agent-runtime"
import { AgentModelSelector } from "../components/agent-model-selector"
import { CoreAgentSelector } from "../components/core-agent-selector"
import {
  agentContractApi,
  getCoreAgentProfileName,
  type CoreAgentId,
  type CoreAgentOption,
} from "../lib/agent-contract-api"
import { CreateBranchDialog } from "../components/create-branch-dialog"
import { formatTimeAgo } from "../utils/format-time-ago"
import { handlePasteEvent } from "../utils/paste-text"
import {
  loadGlobalDrafts,
  saveGlobalDrafts,
  generateDraftId,
  deleteNewChatDraft,
  markDraftVisible,
  type DraftProject,
} from "../lib/drafts"
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  type CodexThinkingLevel,
} from "../lib/models"
import { useAvailableModels } from "../hooks/use-available-models"
// import type { PlanType } from "@/lib/config/subscription-plans"
type PlanType = string

type GroupInitialMessagePart = {
  type?: string
  text?: string
  data?: {
    base64Data?: string
    mediaType?: string
    filename?: string
  }
}

type GroupInitialImagePart = GroupInitialMessagePart & {
  data: {
    base64Data: string
    mediaType: string
    filename?: string
  }
}

async function dispatchInitialGroupMessage(input: {
  chatId: string
  conversationId?: string
  workspaceId?: string
  agents: CoreAgentOption[]
  messageParts?: unknown[]
}) {
  if (!input.conversationId) return

  const text = input.messageParts?.find(
    (part): part is GroupInitialMessagePart =>
      typeof part === "object" &&
      part !== null &&
      (part as GroupInitialMessagePart).type === "text",
  )?.text ?? ""
  const mentionedNames = Array.from(
    new Set(
      Array.from(text.matchAll(/@\[agent:([^\]]+)\]/g)).map(
        (match) => match[1],
      ),
    ),
  )
  const targets = mentionedNames
    .map(
      (mentionedName) =>
        input.agents.find(
          (agent) =>
            agent.name.toLowerCase() === mentionedName.toLowerCase() ||
            agent.id === mentionedName ||
            getCoreAgentProfileName(agent) === mentionedName,
        ),
    )
    .filter((agent): agent is CoreAgentOption => Boolean(agent))

  if (mentionedNames.length === 0) return
  if (targets.length !== mentionedNames.length) {
    toast.error("One or more mentioned agents are not in this group")
    return
  }

  const message = text.replace(/@\[agent:([^\]]+)\]/g, "").trim()
  const images = input.messageParts
    ?.filter(
      (part): part is GroupInitialImagePart =>
        typeof part === "object" &&
        part !== null &&
        (part as GroupInitialMessagePart).type === "data-image" &&
        Boolean((part as GroupInitialMessagePart).data?.base64Data) &&
        Boolean((part as GroupInitialMessagePart).data?.mediaType),
    )
    .map((part) => ({
      base64Data: part.data.base64Data,
      mediaType: part.data.mediaType,
      filename: part.data.filename,
    })) ?? []

  setGroupAgentRuntimeStatuses(
    input.chatId,
    Object.fromEntries(
      targets.map((target) => [target.id, "running"]),
    ) as GroupAgentRuntimeStatuses,
  )

  // Backend no longer supports appending messages directly
  // Group acknowledgements are now managed through the agent chat transport
  console.warn("[new-chat-form] appendConversationMessage disabled - backend endpoint removed")

  const correlationId = `group-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
  void Promise.allSettled(
    targets.map(async (target) => {
      try {
        await trpcClient.groupChat.addMember.mutate({
          chatId: input.chatId,
          agentCommand: getCoreAgentProfileName(target),
          agentName: target.name,
          workspaceId: input.workspaceId,
        })
        await trpcClient.groupChat.sendToAgent.mutate({
          chatId: input.chatId,
          agentCommand: getCoreAgentProfileName(target),
          message,
          correlationId,
          images,
        })
      } catch (error) {
        setGroupAgentRuntimeStatuses(input.chatId, {
          [target.id]: "failed",
        })
        console.error("[GroupChat] Failed to dispatch initial message:", error)
        toast.error(
          error instanceof Error ? error.message : "Failed to send to agent",
        )
      }
    }),
  )
}


interface NewChatFormProps {
  isMobileFullscreen?: boolean
  onBackToChats?: () => void
  selectedWorkspaceId?: string | null
}

export function NewChatForm({
  isMobileFullscreen = false,
  onBackToChats,
  selectedWorkspaceId,
}: NewChatFormProps = {}) {
  // UNCONTROLLED: just track if editor has content for send button
  const [hasContent, setHasContent] = useState(false)
  const [selectedTeamId] = useAtom(selectedTeamIdAtom)
  const [selectedChatId, setSelectedChatId] = useAtom(selectedAgentChatIdAtom)
  const [selectedDraftId, setSelectedDraftId] = useAtom(selectedDraftIdAtom)
  const [sidebarOpen, setSidebarOpen] = useAtom(agentsSidebarOpenAtom)
  const [conversationsSidebarMode, setConversationsSidebarMode] = useAtom(
    agentsConversationsSidebarModeAtom,
  )

  // Current draft ID being edited (generated when user starts typing in empty form)
  const currentDraftIdRef = useRef<string | null>(null)
  const unseenChanges = useAtomValue(agentsUnseenChangesAtom)

  // Check if any chat has unseen changes
  const hasAnyUnseenChanges = unseenChanges.size > 0
  const [lastSelectedRepo, setLastSelectedRepo] = useAtom(lastSelectedRepoAtom)
  const [selectedWorkspace, setSelectedWorkspace] = useAtom(selectedWorkspaceAtom)
  // Fetch projects to validate selectedWorkspace exists
  const { data: projectsList, isLoading: isLoadingProjects } =
    trpc.projects.list.useQuery()

  // Validate selected project exists in DB
  // While loading, trust the stored value to prevent flicker
  const validatedProject = useMemo(() => {
    if (!selectedWorkspace) return null
    // While loading, trust localStorage value to prevent flicker
    if (isLoadingProjects) return selectedWorkspace
    // After loading, validate against DB
    if (!projectsList) return null
    const exists = projectsList.some((p) => p.id === selectedWorkspace.id)
    return exists ? selectedWorkspace : null
  }, [selectedWorkspace, projectsList, isLoadingProjects])
  const canUseRightSidebar = true
  const terminalSidebarAtom = useMemo(
    () => terminalSidebarOpenAtomFamily(validatedProject?.id ?? ""),
    [validatedProject?.id],
  )
  const [isTerminalSidebarOpen, setIsTerminalSidebarOpen] = useAtom(
    terminalSidebarAtom,
  )
  const [isDetailsSidebarOpen, setIsDetailsSidebarOpen] = useAtom(
    detailsSidebarOpenAtom,
  )
  const terminalDisplayMode = useAtomValue(terminalDisplayModeAtom)
  const terminalScopeKey = useMemo(
    () =>
      getTerminalScopeKey({
        branch: null,
        worktreePath: validatedProject?.path ?? null,
        id: validatedProject?.id ?? "",
      }),
    [validatedProject?.id, validatedProject?.path],
  )
  const activeRightSidebar = isDetailsSidebarOpen
    ? "details"
    : isTerminalSidebarOpen
      ? "terminal"
      : null
  const handleOpenTerminal = useCallback(() => {
    setIsTerminalSidebarOpen(true)
    setIsDetailsSidebarOpen(false)
  }, [setIsDetailsSidebarOpen, setIsTerminalSidebarOpen])
  const handleOpenDetails = useCallback(() => {
    setIsDetailsSidebarOpen(true)
    setIsTerminalSidebarOpen(false)
  }, [setIsDetailsSidebarOpen, setIsTerminalSidebarOpen])

  // Clear invalid project from storage
  useEffect(() => {
    if (selectedWorkspace && projectsList && !validatedProject) {
      setSelectedWorkspace(null)
    }
  }, [selectedWorkspace, projectsList, validatedProject, setSelectedWorkspace])
  const [lastSelectedAgentId, setLastSelectedAgentId] = useAtom(
    lastSelectedAgentIdAtom,
  )
  const [lastSelectedModelId, setLastSelectedModelId] = useAtom(
    lastSelectedModelIdAtom,
  )
  // Mode for new chat - uses user's default preference directly
  // Note: defaultAgentMode is initialized synchronously via atomWithStorage with getOnInit: true
  const defaultAgentMode = useAtomValue(defaultAgentModeAtom)
  const [agentMode, setAgentMode] = useState<AgentMode>(() => defaultAgentMode)
  const { mode: collaborationMode } = useCollaborationMode()
  const [groupAgentIds, setGroupAgentIds] = useState<CoreAgentId[]>([
    "claude-code",
  ])
  const [coreAgents, setCoreAgents] = useState<CoreAgentOption[]>([])
  const boundGroupAgents = useMemo(
    () =>
      resolveGroupMentionAgents(
        groupAgentIds,
        coreAgents.filter((agent) => groupAgentIds.includes(agent.id)),
      ),
    [coreAgents, groupAgentIds],
  )

  useEffect(() => {
    let cancelled = false

    void agentContractApi.listCoreAgents().then((options) => {
      if (!cancelled) setCoreAgents(options)
    })

    return () => {
      cancelled = true
    }
  }, [])
  // Toggle mode helper
  const toggleMode = useCallback(() => {
    setAgentMode(getNextMode)
  }, [])
  const [workMode, setWorkMode] = useAtom(lastSelectedWorkModeAtom)
  const debugMode = useAtomValue(agentsDebugModeAtom)
  const customClaudeConfig = useAtomValue(customClaudeConfigAtom)
  const normalizedCustomClaudeConfig =
    normalizeCustomClaudeConfig(customClaudeConfig)
  const hasCustomClaudeConfig = Boolean(normalizedCustomClaudeConfig)
  // Connection status for providers
  const anthropicOnboardingCompleted = useAtomValue(anthropicOnboardingCompletedAtom)
  const apiKeyOnboardingCompleted = useAtomValue(apiKeyOnboardingCompletedAtom)
  const { data: claudeCodeIntegration } =
    trpc.claudeCode.getIntegration.useQuery()
  const isClaudeConnected =
    Boolean(claudeCodeIntegration?.isConnected) ||
    anthropicOnboardingCompleted ||
    apiKeyOnboardingCompleted ||
    hasCustomClaudeConfig
  const setSettingsDialogOpen = useSetAtom(agentsSettingsDialogOpenAtom)
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom)
  const setJustCreatedIds = useSetAtom(justCreatedIdsAtom)
  const [repoSearchQuery, setRepoSearchQuery] = useState("")
  const [createBranchDialogOpen, setCreateBranchDialogOpen] = useState(false)

  // Worktree config banner state
  const [worktreeBannerDismissed, setWorktreeBannerDismissed] = useState(() => {
    try {
      return localStorage.getItem("worktree-banner-dismissed") === "true"
    } catch {
      return false
    }
  })

  // Check if project has worktree config
  const { data: worktreeConfigData } = trpc.worktreeConfig.get.useQuery(
    { projectId: validatedProject?.id ?? "" },
    { enabled: !!validatedProject?.id && workMode === "worktree" && !worktreeBannerDismissed },
  )

  const showWorktreeBanner =
    workMode === "worktree" &&
    validatedProject &&
    !worktreeBannerDismissed &&
    worktreeConfigData &&
    !worktreeConfigData.config

  const handleDismissWorktreeBanner = () => {
    setWorktreeBannerDismissed(true)
    try {
      localStorage.setItem("worktree-banner-dismissed", "true")
    } catch {}
  }

  const handleConfigureWorktree = () => {
    // Open the projects settings tab
    setSettingsActiveTab("projects")
    setSettingsDialogOpen(true)
  }
  // Parse owner/repo from GitHub URL
  const parseGitHubUrl = (url: string) => {
    const match = url.match(/(?:github\.com\/)?([^\/]+)\/([^\/\s#?]+)/)
    if (!match) return null
    return `${match[1]}/${match[2].replace(/\.git$/, "")}`
  }
  const enabledAgents = useMemo(
    () => coreAgents,
    [coreAgents],
  )
  const fallbackAgent = enabledAgents[0] ?? { id: "claude-code" as CoreAgentId, name: "Claude Code" }
  const [selectedAgent, setSelectedAgent] = useState<CoreAgentOption>(fallbackAgent)

  // Update selectedAgent when coreAgents load or lastSelectedAgentId changes
  useEffect(() => {
    if (enabledAgents.length === 0) return
    const nextAgent =
      enabledAgents.find((agent) => agent.id === lastSelectedAgentId) ||
      enabledAgents[0]
    setSelectedAgent((current) => {
      // Only update if current is the initial fallback or no longer in the list
      if (!enabledAgents.find((a) => a.id === current.id)) {
        return nextAgent
      }
      return current
    })
  }, [enabledAgents, lastSelectedAgentId])

  const registeredAgents = useAtomValue(registeredAgentsAtom)
  const setChatAgentLogos = useSetAtom(chatAgentLogosAtom)
  const chatAgentLogos = useMemo(() => {
    if (collaborationMode !== "group") {
      return createChatAgentLogos(
        [selectedAgent.id],
        [],
        registeredAgents,
        selectedAgent.name,
      )
    }

    const agentIds = boundGroupAgents.length > 0
      ? boundGroupAgents.map((agent) => agent.id)
      : groupAgentIds.length > 0
        ? groupAgentIds
        : [selectedAgent.id]

    return createChatAgentLogos(agentIds, boundGroupAgents, registeredAgents)
  }, [
    boundGroupAgents,
    collaborationMode,
    groupAgentIds,
    registeredAgents,
    selectedAgent,
  ])

  // Get available models (with offline support)
  const availableModels = useAvailableModels()
  const [selectedOllamaModel, setSelectedOllamaModel] = useAtom(selectedOllamaModelAtom)
  const [lastSelectedCodexModelId, setLastSelectedCodexModelId] = useAtom(
    lastSelectedCodexModelIdAtom,
  )
  const [lastSelectedCodexThinking, setLastSelectedCodexThinking] = useAtom(
    lastSelectedCodexThinkingAtom,
  )
  const [thinkingEnabled, setThinkingEnabled] = useAtom(
    extendedThinkingEnabledAtom,
  )

  const [selectedModel, setSelectedModel] = useState(
    () => {
      // Priority: backend current model > last selected > first available
      const backendCurrent = availableModels.currentModelId
        ? availableModels.models.find((m) => m.id === availableModels.currentModelId)
        : null
      const lastSelected = availableModels.models.find((m) => m.id === lastSelectedModelId)
      return backendCurrent || lastSelected || availableModels.models[0]
    },
  )

  // Sync selectedModel when backend current model or atom value changes
  useEffect(() => {
    // If backend reports a current model, prefer it
    if (availableModels.currentModelId) {
      const backendModel = availableModels.models.find((m) => m.id === availableModels.currentModelId)
      if (backendModel) {
        if (backendModel.id !== selectedModel.id) {
          setSelectedModel(backendModel)
        }
        return
      }
    }
    const model = availableModels.models.find((m) => m.id === lastSelectedModelId)
    if (model && model.id !== selectedModel.id) {
      setSelectedModel(model)
    }
  }, [availableModels.models, availableModels.currentModelId, lastSelectedModelId])

  const hiddenModels = useAtomValue(hiddenModelsAtom)
  const codexUiModels = useMemo(
    () => {
      const models = CODEX_MODELS
      return models.filter((model) => !hiddenModels.includes(model.id))
    },
    [hiddenModels],
  )
  const selectedCodexModel = useMemo(
    () =>
      codexUiModels.find((model) => model.id === lastSelectedCodexModelId) ||
      codexUiModels[0] ||
      CODEX_MODELS[0]!,
    [codexUiModels, lastSelectedCodexModelId],
  )

  const selectedCodexThinking = useMemo<CodexThinkingLevel>(() => {
    if (
      selectedCodexModel.thinkings.includes(
        lastSelectedCodexThinking as CodexThinkingLevel,
      )
    ) {
      return lastSelectedCodexThinking as CodexThinkingLevel
    }

    if (selectedCodexModel.thinkings.includes("high")) {
      return "high"
    }

    return selectedCodexModel.thinkings[0]!
  }, [selectedCodexModel, lastSelectedCodexThinking])

  useEffect(() => {
    if (
      selectedCodexModel.thinkings.includes(
        lastSelectedCodexThinking as CodexThinkingLevel,
      )
    ) {
      return
    }

    setLastSelectedCodexThinking(selectedCodexThinking)
  }, [
    selectedCodexModel,
    lastSelectedCodexThinking,
    selectedCodexThinking,
    setLastSelectedCodexThinking,
  ])

  const selectedChatModel = useMemo(() => {
    if (selectedAgent.id === "codex") {
      return `${selectedCodexModel.id}/${selectedCodexThinking}`
    }
    // Don't default to "opus" - let the agent use its default model
    return selectedModel?.id ?? undefined
  }, [
    selectedAgent.id,
    selectedCodexModel.id,
    selectedCodexThinking,
    selectedModel?.id,
  ])

  // Determine current Ollama model (selected or recommended)
  const currentOllamaModel = selectedOllamaModel || availableModels.recommendedModel || availableModels.ollamaModels[0]
  const claudeAgent =
    enabledAgents.find((agent) => agent.id === "claude-code") || fallbackAgent
  const selectedModelLabel = useMemo(() => {
    if (selectedAgent.id === "codex") {
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
    selectedAgent.id,
    selectedCodexModel.name,
    availableModels.isOffline,
    availableModels.hasOllama,
    currentOllamaModel,
    hasCustomClaudeConfig,
    selectedModel,
  ])
  const [repoPopoverOpen, setRepoPopoverOpen] = useState(false)
  const [branchPopoverOpen, setBranchPopoverOpen] = useState(false)
  const [lastSelectedBranches, setLastSelectedBranches] = useAtom(
    lastSelectedBranchesAtom,
  )
  const [branchSearch, setBranchSearch] = useState("")
  const [selectedBranchType, setSelectedBranchType] = useState<
    "local" | "remote" | undefined
  >(undefined)

  // Get/set selected branch for current project (persisted per project)
  const selectedBranch = validatedProject?.id
    ? lastSelectedBranches[validatedProject.id]?.name || ""
    : ""
  const setSelectedBranch = useCallback(
    (branch: string, type?: "local" | "remote") => {
      if (validatedProject?.id && type) {
        setLastSelectedBranches((prev) => ({
          ...prev,
          [validatedProject.id]: { name: branch, type },
        }))
        setSelectedBranchType(type)
      }
    },
    [validatedProject?.id, setLastSelectedBranches],
  )
  const branchListRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<AgentsMentionsEditorHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Restore selectedBranchType from persisted storage when project changes
  useEffect(() => {
    if (validatedProject?.id) {
      const stored = lastSelectedBranches[validatedProject.id]
      if (stored?.type) {
        setSelectedBranchType(stored.type)
      } else {
        setSelectedBranchType(undefined)
      }
    } else {
      setSelectedBranchType(undefined)
    }
  }, [validatedProject?.id, lastSelectedBranches])

  // File upload hook
  const {
    images,
    files,
    handleAddAttachments,
    removeImage,
    removeFile,
    clearImages,
    clearFiles,
    isUploading,
  } = useAgentsFileUpload()

  // Pasted text files - use a stable temp ID for new chat
  const tempPastedIdRef = useRef(`new-chat-${Date.now()}`)
  const {
    pastedTexts,
    addPastedText,
    removePastedText,
    clearPastedTexts,
  } = usePastedTextFiles(tempPastedIdRef.current)

  // File contents cache - stores content for file mentions (keyed by mentionId)
  // This content gets added to the prompt when sending, without showing a separate card
  const fileContentsRef = useRef<Map<string, string>>(new Map())

  // Mention dropdown state
  const [showMentionDropdown, setShowMentionDropdown] = useState(false)
  const [mentionSearchText, setMentionSearchText] = useState("")
  const [mentionPosition, setMentionPosition] = useState({ top: 0, left: 0 })
  const [mentionScope, setMentionScope] = useState<"agents" | "resources" | "all">("agents")

  // Mention subpage navigation state
  const [showingFilesList, setShowingFilesList] = useState(false)
  const [showingSkillsList, setShowingSkillsList] = useState(false)
  const [showingAgentsList, setShowingAgentsList] = useState(false)
  const [showingToolsList, setShowingToolsList] = useState(false)

  // Slash command dropdown state
  const [showSlashDropdown, setShowSlashDropdown] = useState(false)
  const [slashSearchText, setSlashSearchText] = useState("")
  const [slashPosition, setSlashPosition] = useState({ top: 0, left: 0 })

  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false)

  // Voice input state
  const customHotkeys = useAtomValue(customHotkeysAtom)
  const {
    isRecording: isVoiceRecording,
    audioLevel: voiceAudioLevel,
    startRecording,
    stopRecording,
    cancelRecording,
  } = useVoiceRecording()
  const [isTranscribing, setIsTranscribing] = useState(false)
  // Voice transcription is disabled until a local provider is connected.
  const isVoiceAvailable = false

  // Voice input handlers
  const handleVoiceMouseDown = useCallback(async () => {
    if (isUploading || isTranscribing || isVoiceRecording) return
    try {
      await startRecording()
    } catch (err) {
      console.error("[NewChatForm] Failed to start recording:", err)
    }
  }, [isUploading, isTranscribing, isVoiceRecording, startRecording])

  const handleVoiceMouseUp = useCallback(async () => {
    if (!isVoiceRecording) return

    await stopRecording()
  }, [isVoiceRecording, stopRecording])

  const handleVoiceMouseLeave = useCallback(() => {
    if (isVoiceRecording) {
      cancelRecording()
    }
  }, [isVoiceRecording, cancelRecording])

  // Voice hotkey listener (push-to-talk: hold to record, release to transcribe)
  useEffect(() => {
    const voiceHotkey = getResolvedHotkey("voice-input", customHotkeys)
    if (!voiceHotkey) return

    // Parse hotkey once
    const parts = voiceHotkey.split("+").map(p => p.toLowerCase())
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
      if (!isVoiceRecording && !isTranscribing) {
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
  }, [customHotkeys, isVoiceRecording, isTranscribing, handleVoiceMouseDown, handleVoiceMouseUp])

  // Shift+Tab handler for mode switching (now handled inside input component via onShiftTab prop)

  // Keyboard shortcut: Enter to focus input when not already focused
  useFocusInputOnEnter(editorRef)

  // Keyboard shortcut: Cmd+Esc to toggle focus/blur
  useToggleFocusOnCmdEsc(editorRef)

  const repos: Array<{
    id: string
    name: string
    full_name: string
    sandbox_status?: string
    pushed_at?: string | null
  }> = []
  const readyRepos = repos

  // Use state to avoid hydration mismatch
  const [resolvedRepo, setResolvedRepo] = useState<(typeof repos)[0] | null>(
    null,
  )

  // Derive selected repo from saved or first available (client-side only)
  // Now includes all repos, not just ready ones
  useEffect(() => {
    if (lastSelectedRepo) {
      // For public imports, use lastSelectedRepo directly (it won't be in repos list)
      if (lastSelectedRepo.isPublicImport) {
        setResolvedRepo({
          id: lastSelectedRepo.id,
          name: lastSelectedRepo.name,
          full_name: lastSelectedRepo.full_name,
          sandbox_status: lastSelectedRepo.sandbox_status || "not_setup",
        } as (typeof repos)[0])
        return
      }

      // Look in all repos by id or full_name
      // Only compare IDs when lastSelectedRepo.id is non-empty (old localStorage data might have empty id)
      const stillExists = repos.find(
        (r) =>
          (lastSelectedRepo.id && r.id === lastSelectedRepo.id) ||
          r.full_name === lastSelectedRepo.full_name,
      )
      if (stillExists) {
        setResolvedRepo(stillExists)
        return
      }
    }

    if (repos.length === 0) {
      setResolvedRepo(null)
      return
    }

    // Auto-save first repo if none saved (prefer ready repos, then any)
    if (!lastSelectedRepo && repos.length > 0) {
      const firstRepo = readyRepos[0] || repos[0]
      setLastSelectedRepo({
        id: firstRepo.id,
        name: firstRepo.name,
        full_name: firstRepo.full_name,
        sandbox_status: firstRepo.sandbox_status as
          | "ready"
          | "not_setup"
          | "in_progress"
          | "error"
          | undefined,
      })
    }

    setResolvedRepo(readyRepos[0] || repos[0] || null)
  }, [lastSelectedRepo, repos, readyRepos, setLastSelectedRepo])

  // Desktop: fetch branches from local git repository
  const branchesQuery = trpc.changes.getBranches.useQuery(
    { worktreePath: validatedProject?.path || "" },
    {
      enabled: !!validatedProject?.path,
      staleTime: 30_000, // Cache for 30 seconds
    },
  )

  const fetchRemoteMutation = trpc.changes.fetchRemote.useMutation()

  // Manual refresh branches
  const handleRefreshBranches = useCallback(() => {
    if (validatedProject?.path) {
      fetchRemoteMutation.mutate(
        { worktreePath: validatedProject.path },
        {
          onSuccess: () => {
            branchesQuery.refetch()
          },
          onError: (error) => {
            console.error("Failed to fetch remote branches:", error)
          },
        },
      )
    }
  }, [validatedProject?.path, fetchRemoteMutation, branchesQuery])

  // Stable ref for handleRefreshBranches to avoid re-running effects on every render
  const handleRefreshBranchesRef = useRef(handleRefreshBranches)
  handleRefreshBranchesRef.current = handleRefreshBranches

  // Transform branch data to match web app format
  const branches = useMemo(() => {
    if (!branchesQuery.data) return []

    const { local, remote, defaultBranch } = branchesQuery.data
    const result: Array<{
      name: string
      type: "local" | "remote"
      protected: boolean
      isDefault: boolean
      committedAt: string | null
      authorName: null
    }> = []

    // Add local branches
    for (const { branch, lastCommitDate } of local) {
      result.push({
        name: branch,
        type: "local",
        protected: false,
        isDefault: branch === defaultBranch,
        committedAt: lastCommitDate
          ? new Date(lastCommitDate).toISOString()
          : null,
        authorName: null,
      })
    }

    // Add remote branches
    for (const name of remote) {
      result.push({
        name: name,
        type: "remote",
        protected: false,
        isDefault: name === defaultBranch,
        committedAt: null,
        authorName: null,
      })
    }

    // Sort: default first, then local, then remote, alphabetically
    return result.sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1
      if (!a.isDefault && b.isDefault) return 1
      if (a.type !== b.type) return a.type === "local" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [branchesQuery.data])

  // Filter branches based on search
  const filteredBranches = useMemo(() => {
    if (!branchSearch.trim()) return branches
    const search = branchSearch.toLowerCase()
    return branches.filter((b) => b.name.toLowerCase().includes(search))
  }, [branches, branchSearch])

  // Virtualizer for branch list - only active when popover is open
  const branchVirtualizer = useVirtualizer({
    count: filteredBranches.length,
    getScrollElement: () => branchListRef.current,
    estimateSize: () => 28, // Each item is h-7 (28px)
    overscan: 5,
    enabled: branchPopoverOpen, // Only virtualize when popover is open
  })

  // Force virtualizer to re-measure when popover opens
  useEffect(() => {
    if (branchPopoverOpen) {
      // Small delay to ensure ref is attached
      const timer = setTimeout(() => {
        branchVirtualizer.measure()
      }, 0)
      return () => clearTimeout(timer)
    }
  }, [branchPopoverOpen])

  // Format relative time for branches (reuse shared utility)
  const formatRelativeTime = (dateString: string | null): string => {
    if (!dateString) return ""
    return formatTimeAgo(dateString)
  }

  // Set default branch when project/branches change (only if no saved branch for this project)
  useEffect(() => {
    if (
      branchesQuery.data?.defaultBranch &&
      validatedProject?.id &&
      !selectedBranch
    ) {
      // Find the default branch in the branches list to get its type
      // Prefer local over remote if both exist
      const defaultBranchObj = branches.find(
        (b) => b.name === branchesQuery.data.defaultBranch && b.isDefault && b.type === "local",
      ) || branches.find(
        (b) => b.name === branchesQuery.data.defaultBranch && b.isDefault && b.type === "remote",
      )
      // Fallback to "local" if branch not found in list (shouldn't happen but prevents empty selector)
      const branchType = defaultBranchObj?.type || "local"
      setSelectedBranch(
        branchesQuery.data.defaultBranch,
        branchType,
      )
    }
  }, [
    branchesQuery.data?.defaultBranch,
    validatedProject?.id,
    selectedBranch,
    setSelectedBranch,
    branches,
  ])

  // Auto-focus input when NewChatForm is shown (when clicking "New Chat")
  // Skip on mobile to prevent keyboard from opening automatically
  useEffect(() => {
    if (isMobileFullscreen) return // Don't autofocus on mobile

    // Small delay to ensure DOM is ready and animations complete
    const timeoutId = setTimeout(() => {
      editorRef.current?.focus()
    }, 150)

    return () => clearTimeout(timeoutId)
  }, [isMobileFullscreen]) // Run on mount and when mobile state changes

  // Track last saved text to avoid unnecessary updates
  const lastSavedTextRef = useRef<string>("")

  // Track previous draft ID to detect when switching away from a draft
  const prevSelectedDraftIdRef = useRef<string | null>(null)

  // Restore draft when a specific draft is selected from sidebar
  // Or clear editor when "New Workspace" is clicked (selectedDraftId becomes null)
  useEffect(() => {
    const hadDraftBefore = prevSelectedDraftIdRef.current !== null
    prevSelectedDraftIdRef.current = selectedDraftId

    if (!selectedDraftId) {
      // No draft selected - only clear if we had a draft before (user clicked "New Workspace")
      // Don't clear if user is currently typing (currentDraftIdRef has a value)
      if (hadDraftBefore) {
        currentDraftIdRef.current = null
        lastSavedTextRef.current = ""
        if (editorRef.current) {
          editorRef.current.clear()
          setHasContent(false)
        }

        // Fetch remote branches in background when starting new workspace
        if (validatedProject?.path) {
          handleRefreshBranchesRef.current()
        }
      }
      return
    }

    const globalDrafts = loadGlobalDrafts()
    const draft = globalDrafts[selectedDraftId]
    if (draft?.text) {
      currentDraftIdRef.current = selectedDraftId
      lastSavedTextRef.current = draft.text // Initialize to prevent immediate re-save

      // Try to set value immediately if editor is ready
      if (editorRef.current) {
        editorRef.current.setValue(draft.text)
        setHasContent(true)
      } else {
        // Fallback: wait for editor to initialize (rare case)
        const timeoutId = setTimeout(() => {
          editorRef.current?.setValue(draft.text)
          setHasContent(true)
        }, 50)
        return () => clearTimeout(timeoutId)
      }
    }
  }, [selectedDraftId, validatedProject?.path])

  // Mark draft as visible when component unmounts (user navigates away)
  // This ensures the draft only appears in the sidebar after leaving the form
  useEffect(() => {
    return () => {
      // On unmount, mark current draft as visible so it appears in sidebar
      if (currentDraftIdRef.current) {
        markDraftVisible(currentDraftIdRef.current)
      }
    }
  }, [])

  // Filter all repos by search (combined list) and sort by preview status
  const filteredRepos = repos
    .filter(
      (repo) =>
        repo.name.toLowerCase().includes(repoSearchQuery.toLowerCase()) ||
        repo.full_name.toLowerCase().includes(repoSearchQuery.toLowerCase()),
    )
    .sort((a, b) => {
      // 1. Repos with preview (sandbox_status === "ready") come first
      const aHasPreview = a.sandbox_status === "ready"
      const bHasPreview = b.sandbox_status === "ready"
      if (aHasPreview && !bHasPreview) return -1
      if (!aHasPreview && bHasPreview) return 1

      // 2. Sort by last commit date (pushed_at) - most recent first
      const aDate = a.pushed_at ? new Date(a.pushed_at).getTime() : 0
      const bDate = b.pushed_at ? new Date(b.pushed_at).getTime() : 0
      return bDate - aDate
    })

  // Create chat mutation (real tRPC)
  const utils = trpc.useUtils()
  const createChatMutation = trpc.chats.create.useMutation({
    onSuccess: (data, variables) => {
      // Save the selected agent command for the first conversation
      const firstConversationId = data.conversations?.[0]?.id
      if (firstConversationId && variables.agentCommand) {
        // Import dynamically to avoid circular dependency
        import("../lib/conversation-agent-storage").then(({ conversationAgentStorage }) => {
          conversationAgentStorage.set(firstConversationId, variables.agentCommand!)
        })
      }

      if (collaborationMode === "group") {
        const groupAgents =
          boundGroupAgents.length > 0
            ? boundGroupAgents
            : resolveGroupMentionAgents(groupAgentIds, [])
        saveGroupAgents(data.id, groupAgents)
        void dispatchInitialGroupMessage({
          chatId: data.id,
          conversationId: data.conversations?.[0]?.id,
          workspaceId: data.worktreePath || undefined,
          agents: groupAgents,
          messageParts: variables.initialMessageParts,
        }).finally(() => {
          utils.chats.list.invalidate()
          utils.chats.get.invalidate({ id: data.id })
        })
      }
      else {
        utils.chats.list.invalidate()
        utils.chats.get.invalidate({ id: data.id })
      }
      void utils.ergatai.workspaceStatus.invalidate()
      if (collaborationMode !== "group") {
        setChatAgentLogos((current) => ({
          ...current,
          [data.id]: chatAgentLogos,
        }))
      }
      else {
        setChatAgentLogos((current) => ({
          ...current,
          [data.id]: chatAgentLogos,
        }))
      }
      // Clear editor, images, files, pasted texts, and file contents cache only on success
      editorRef.current?.clear()
      clearImages()
      clearFiles()
      clearPastedTexts()
      fileContentsRef.current.clear()
      clearCurrentDraft()
      setSelectedChatId(data.id)
      // Track this chat and its first conversation as just created for typewriter effect
      const ids = [data.id]
      if (data.conversations?.[0]?.id) {
        ids.push(data.conversations[0].id)
      }
      setJustCreatedIds((prev) => new Set([...prev, ...ids]))
    },
    onError: (error) => {
      toast.error(error.message)
    },
  })

  const renderWorkModeSelector = useCallback(
    () =>
      validatedProject ? (
        <WorkModeSelector
          value={workMode}
          onChange={setWorkMode}
          disabled={createChatMutation.isPending}
        />
      ) : null,
    [
      createChatMutation.isPending,
      setWorkMode,
      validatedProject,
      workMode,
    ],
  )

  const trpcUtils = trpc.useUtils()

  const handleSend = useCallback(async () => {
    // Get value from uncontrolled editor
    let message = editorRef.current?.getValue() || ""

    // Allow send if there's text, images, files, or pasted text files
    const hasText = message.trim().length > 0
    const hasImages = images.filter((img) => !img.isLoading && img.url).length > 0
    const hasFiles = files.filter((f) => !f.isLoading).length > 0
    const hasPastedTexts = pastedTexts.length > 0

    if ((!hasText && !hasImages && !hasFiles && !hasPastedTexts) || !selectedWorkspace) {
      return
    }

    // Build message parts array (images first, then text, then hidden file contents)
    type MessagePart =
      | { type: "text"; text: string }
      | {
          type: "data-image"
          data: {
            url: string
            mediaType?: string
            filename?: string
            base64Data?: string
          }
        }
      | {
          type: "file-content"
          filePath: string
          content: string
        }

    const parts: MessagePart[] = images
      .filter((img) => !img.isLoading && img.url)
      .map((img) => ({
        type: "data-image" as const,
        data: {
          url: img.url!,
          mediaType: img.mediaType,
          filename: img.filename,
          base64Data: img.base64Data,
        },
      }))

    // Add pasted text as pasted mentions (format: pasted:size:preview|filepath)
    // Using | as separator since filepath can contain colons
    let finalMessage = message.trim()
    if (pastedTexts.length > 0) {
      const pastedMentions = pastedTexts
        .map((pt) => {
          // Sanitize preview to remove special characters that break mention parsing
          const sanitizedPreview = pt.preview.replace(/[:\[\]|]/g, "")
          const prefix = pt.kind === "chatHistory" ? MENTION_PREFIXES.CHAT_HISTORY : MENTION_PREFIXES.PASTED
          return `@[${prefix}${pt.size}:${sanitizedPreview}|${pt.filePath}]`
        })
        .join(" ")
      finalMessage = pastedMentions + (finalMessage ? " " + finalMessage : "")
    }

    if (finalMessage) {
      parts.push({ type: "text" as const, text: finalMessage })
    }

    // Add cached file contents as hidden parts (sent to agent but not displayed in UI)
    // These are from dropped text files - content is embedded so agent sees it immediately
    if (fileContentsRef.current.size > 0) {
      for (const [mentionId, content] of fileContentsRef.current.entries()) {
        // Extract file path from mentionId (file:local:path or file:external:path)
        const filePath = mentionId.replace(/^file:(local|external):/, "")
        parts.push({
          type: "file-content" as const,
          filePath,
          content,
        })
      }
    }

    // Create chat with selected project, branch, and initial message
    createChatMutation.mutate({
      projectId: selectedWorkspace.id,
      workspaceId: selectedWorkspaceId || undefined,
      name: message.trim().slice(0, 50), // Use first 50 chars as chat name
      model: selectedChatModel || undefined, // Only send model if explicitly selected
      initialMessageParts: parts.length > 0 ? parts : undefined,
      baseBranch:
        workMode === "worktree" ? selectedBranch || undefined : undefined,
      branchType:
        workMode === "worktree" ? selectedBranchType : undefined,
      useWorktree: workMode === "worktree",
      mode: agentMode,
      collaborationMode,
      agentCommand: selectedAgent.id, // Pass selected agent command
    })
    // Editor, images, files, and pasted texts are cleared in onSuccess callback
  }, [
    selectedWorkspace,
    validatedProject?.path,
    createChatMutation,
    hasContent,
    selectedBranch,
    selectedBranchType,
    workMode,
    images,
    files,
    pastedTexts,
    selectedChatModel,
    agentMode,
    trpcUtils,
    selectedWorkspaceId,
  ])

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
  }, [])

  // Save draft to localStorage when content changes
  const handleContentChange = useCallback(
    (hasContent: boolean) => {
      setHasContent(hasContent)
      const text = editorRef.current?.getValue() || ""

      // Skip if text hasn't changed
      if (text === lastSavedTextRef.current) {
        return
      }
      lastSavedTextRef.current = text

      const globalDrafts = loadGlobalDrafts()

      if (text.trim() && validatedProject) {
        // If no current draft ID, create a new one
        if (!currentDraftIdRef.current) {
          currentDraftIdRef.current = generateDraftId()
        }

        const key = currentDraftIdRef.current
        globalDrafts[key] = {
          text,
          updatedAt: Date.now(),
          project: {
            id: validatedProject.id,
            name: validatedProject.name,
            path: validatedProject.path,
            gitOwner: validatedProject.gitOwner,
            gitRepo: validatedProject.gitRepo,
            gitProvider: validatedProject.gitProvider,
          },
        }
        saveGlobalDrafts(globalDrafts)
      } else if (currentDraftIdRef.current) {
        // Text is empty - delete the current draft
        deleteNewChatDraft(currentDraftIdRef.current)
        currentDraftIdRef.current = null
      }
    },
    [validatedProject],
  )

  // Clear current draft when chat is created
  const clearCurrentDraft = useCallback(() => {
    if (!currentDraftIdRef.current) return

    deleteNewChatDraft(currentDraftIdRef.current)
    currentDraftIdRef.current = null
    setSelectedDraftId(null)
  }, [setSelectedDraftId])

  // Memoized callbacks to prevent re-renders
  const handleMentionTrigger = useCallback(
    ({ searchText, rect }: { searchText: string; rect: DOMRect }) => {
      if (validatedProject) {
        setMentionScope("agents")
        setMentionSearchText(searchText)
        setMentionPosition({ top: rect.top, left: rect.left })
        // Reset subpage state when opening dropdown
        setShowingFilesList(false)
        setShowingSkillsList(false)
        setShowingAgentsList(false)
        setShowingToolsList(false)
        setShowMentionDropdown(true)
      }
    },
    [validatedProject],
  )

  const handleCloseTrigger = useCallback(() => {
    setShowMentionDropdown(false)
    // Reset subpage state when closing
    setShowingFilesList(false)
    setShowingSkillsList(false)
    setShowingAgentsList(false)
    setShowingToolsList(false)
  }, [])

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
            editorRef.current?.clear()
            return
          case "plan":
            if (agentMode !== "plan") {
              setAgentMode("plan")
            }
            return
          case "agent":
            if (agentMode === "plan") {
              setAgentMode("agent")
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
        }
      }

      // For all other commands (builtin prompts):
      // insert the command and let user add arguments or press Enter to send
      editorRef.current?.setValue(`/${command.name} `)
    },
    [agentMode],
  )

  // Paste handler for images, plain text, and large text (saved as files)
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => handlePasteEvent(e, handleAddAttachments, addPastedText),
    [handleAddAttachments, addPastedText],
  )

  // Drag and drop handlers
  const [isDragOver, setIsDragOver] = useState(false)

  // Focus state for ring
  const [isFocused, setIsFocused] = useState(false)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  // Text file extensions that should have content read and attached
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

  const MAX_FILE_SIZE_FOR_CONTENT = 100 * 1024 // 100KB - files larger than this only get path mention

  // Image extensions that should be handled as attachments (base64)
  const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      const droppedFiles = Array.from(e.dataTransfer.files)

      // Separate images from other files
      const imageFiles: File[] = []
      const otherFiles: File[] = []

      for (const file of droppedFiles) {
        const ext = file.name.includes(".") ? "." + file.name.split(".").pop()?.toLowerCase() : ""
        if (IMAGE_EXTENSIONS.has(ext)) {
          imageFiles.push(file)
        } else {
          otherFiles.push(file)
        }
      }

      // Handle images via existing attachment system (base64)
      if (imageFiles.length > 0) {
        handleAddAttachments(imageFiles)
      }

      // Process other files - for text files, read content and add as file mention
      for (const file of otherFiles) {
        // Get file path using Electron's webUtils API (more reliable than file.path)
        const filePath: string | undefined = window.webUtils?.getPathForFile?.(file) || (file as File & { path?: string }).path

        let mentionId: string
        let mentionPath: string

        // Check if file is inside the project
        if (
          validatedProject?.path &&
          filePath &&
          filePath.startsWith(validatedProject.path)
        ) {
          // Project file: use relative path with file:local: prefix
          const relativePath = filePath
            .slice(validatedProject.path.length)
            .replace(/^\//, "")
          mentionId = `file:local:${relativePath}`
          mentionPath = relativePath
        } else if (filePath) {
          // External file: use absolute path with file:external: prefix
          mentionId = `file:external:${filePath}`
          mentionPath = filePath
        } else {
          // Fallback: use filename only
          mentionId = `file:external:${file.name}`
          mentionPath = file.name
        }

        const fileName = file.name
        const ext = fileName.includes(".") ? "." + fileName.split(".").pop()?.toLowerCase() : ""
        // Files without extension are likely directories or special files - skip content reading
        const hasExtension = ext !== ""
        const isTextFile = hasExtension && TEXT_FILE_EXTENSIONS.has(ext)
        const isSmallEnough = file.size <= MAX_FILE_SIZE_FOR_CONTENT

        // For text files that are small enough, read content and store it
        // Show file chip, content will be added to prompt on send
        if (isTextFile && isSmallEnough && filePath) {
          // Add file chip for visual representation
          editorRef.current?.insertMention({
            id: mentionId,
            label: fileName,
            path: mentionPath,
            repository: "local",
            type: "file",
          })

          // Read and cache content (will be added to prompt on send)
          try {
            const content = await trpcUtils.files.readFile.fetch({ filePath })
            fileContentsRef.current.set(mentionId, content)
          } catch (err) {
            // If reading fails, chip is still there - agent can try to read via path
            console.error(`[handleDrop] Failed to read file content ${filePath}:`, err)
          }
        } else {
          // For binary files, large files - add as mention only
          // mentionPath contains full absolute path for external files
          editorRef.current?.insertMention({
            id: mentionId,
            label: fileName,
            path: mentionPath,
            repository: "local",
            type: "file",
          })
        }
      }

      // Focus after state update - use double rAF to wait for React render
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          editorRef.current?.focus()
        })
      })
    },
    [validatedProject?.path, handleAddAttachments, trpcUtils],
  )

  // Context items for images, files, and pasted text files
  const contextItems =
    images.length > 0 || files.length > 0 || pastedTexts.length > 0 ? (
      <div className="flex flex-wrap items-center gap-[6px]">
        {(() => {
          // Build allImages array for gallery navigation
          const allImages = images
            .filter((img) => img.url && !img.isLoading)
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
              url={img.url}
              isLoading={img.isLoading}
              onRemove={() => removeImage(img.id)}
              allImages={allImages}
              imageIndex={idx}
            />
          ))
        })()}
        {files.map((f) => (
          <AgentFileItem
            key={f.id}
            id={f.id}
            filename={f.filename}
            url={f.url || ""}
            size={f.size}
            isLoading={f.isLoading}
            onRemove={() => removeFile(f.id)}
          />
        ))}
        {pastedTexts.map((pt) => (
          <AgentPastedTextItem
            key={pt.id}
            filePath={pt.filePath}
            filename={pt.filename}
            size={pt.size}
            preview={pt.preview}
            onRemove={() => removePastedText(pt.id)}
          />
        ))}
      </div>
    ) : null

  // Handle container click to focus editor
  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if (
      e.target === e.currentTarget ||
      !(e.target as HTMLElement).closest("button, [contenteditable]")
    ) {
      editorRef.current?.focus()
    }
  }, [])

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* Header - Simple burger on mobile, AgentsHeaderControls on desktop */}
      <div className="flex-shrink-0 flex items-center justify-between bg-background p-1.5">
        <div className="flex-1 min-w-0 flex items-center gap-2">
          {isMobileFullscreen ? (
            // Simple burger button for mobile - just opens chats list
            <Button
              variant="ghost"
              size="icon"
              onClick={onBackToChats}
              className="h-7 w-7 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] flex-shrink-0 rounded-md"
              aria-label="All projects"
            >
              <AlignJustify className="h-4 w-4" />
            </Button>
          ) : (
            <>
              {conversationsSidebarMode === "tabs" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setConversationsSidebarMode("sidebar")}
                      className="h-6 w-6 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] flex-shrink-0 rounded-md flex items-center justify-center"
                      aria-label="Open chats pane"
                    >
                      <IconOpenSidebarRight className="h-4 w-4 scale-x-[-1]" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Open chats pane</TooltipContent>
                </Tooltip>
              )}
            </>
          )}
        </div>
        {canUseRightSidebar && (
          <div className="flex items-center gap-1">
            {activeRightSidebar !== "terminal" && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleOpenTerminal}
                className="h-6 w-6 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] text-foreground flex-shrink-0 rounded-md"
                aria-label="Open terminal"
              >
                <TerminalSquare className="h-4 w-4" />
              </Button>
            )}
            {activeRightSidebar !== "details" && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleOpenDetails}
                className="h-6 w-6 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] text-foreground flex-shrink-0 rounded-md"
                aria-label="Open details"
              >
                <IconOpenSidebarRight className="h-4 w-4" />
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-1 items-center justify-center overflow-y-auto relative">
        <div className="w-full max-w-2xl space-y-4 md:space-y-6 relative z-10 px-4">
          {/* Title - only show when project is selected */}
          {validatedProject ? (
            <div className="text-center">
              <h1 className="text-2xl md:text-4xl font-medium tracking-tight">
                What do you want to get done?
              </h1>
            </div>
          ) : null}

          {/* Input Area or Select Repo State */}
          {!validatedProject ? (
            <div className="flex justify-center">
              <WorkspaceSelector matchTriggerWidth />
            </div>
          ) : (
            // Workspace ready - show input form
            <div
              className="relative w-full"
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div
                className="relative w-full cursor-text"
                onClick={handleContainerClick}
              >
                <PromptInput
                  className={cn(
                    "border bg-input-background relative z-10 p-2 rounded-xl transition-[border-color,box-shadow] duration-150",
                    isDragOver && "ring-2 ring-primary/50 border-primary/50",
                    isFocused && !isDragOver && "ring-2 ring-primary/50",
                  )}
                  maxHeight={240}
                  onSubmit={handleSend}
                  contextItems={contextItems}
                >
                  <PromptInputContextItems />
                  <div className="relative">
                    <AgentsMentionsEditor
                      ref={editorRef}
                      onTrigger={handleMentionTrigger}
                      onCloseTrigger={handleCloseTrigger}
                      onSlashTrigger={handleSlashTrigger}
                      onCloseSlashTrigger={handleCloseSlashTrigger}
                      onContentChange={handleContentChange}
                      onSubmit={handleSend}
                      onShiftTab={toggleMode}
                      placeholder="Plan, @ for agent, / for commands"
                      className={cn(
                        "bg-transparent max-h-[240px] overflow-y-auto p-1",
                        isMobileFullscreen ? "min-h-[56px]" : "min-h-[44px]",
                      )}
                      onPaste={handlePaste}
                      disabled={createChatMutation.isPending}
                      onFocus={() => setIsFocused(true)}
                      onBlur={() => setIsFocused(false)}
                    />
                  </div>
                  <PromptInputActions className="w-full">
                    <div className="flex items-center gap-0.5 flex-1 min-w-0">
                      {/* Mode toggle (Agent/Plan) */}

                      <div className="group/model-controls flex items-center gap-0.5">
                        <CoreAgentSelector
                          value={selectedAgent.id as "claude-code" | "codex"}
                          compact={collaborationMode === "group"}
                          groupAgentIds={groupAgentIds}
                          onChangeGroupAgents={setGroupAgentIds}
                          onChange={(agent) => {
                            setGroupAgentIds((current) =>
                              current.includes(agent.id)
                                ? current
                                : [...current, agent.id],
                            )
                            // Update selectedAgent for any agent (including custom profiles like mock-agent)
                            const matchedAgent = enabledAgents.find((item) => item.id === agent.id)
                            if (matchedAgent) {
                              setSelectedAgent(matchedAgent)
                              setLastSelectedAgentId(agent.id)
                            } else if (agent.id === "codex") {
                              setSelectedAgent(enabledAgents.find((item) => item.id === "codex") || fallbackAgent)
                              setLastSelectedAgentId("codex")
                            } else if (agent.id === "claude-code") {
                              setSelectedAgent(claudeAgent)
                              setLastSelectedAgentId("claude-code")
                            }
                          }}
                        />
                      </div>
                      <PermissionModeSelector />
                    </div>

                    <div className="flex items-center gap-0.5 ml-auto flex-shrink-0">
                      {renderWorkModeSelector()}
                      {/* Hidden file input */}
                      <input
                        type="file"
                        ref={fileInputRef}
                        hidden
                        multiple
                        onChange={(e) => {
                          const inputFiles = Array.from(e.target.files || [])
                          handleAddAttachments(inputFiles)
                          e.target.value = "" // Reset to allow same file selection
                        }}
                      />
                      {/* Voice wave indicator or Attachment button */}
                      {isVoiceRecording ? (
                        <VoiceWaveIndicator isRecording={isVoiceRecording} audioLevel={voiceAudioLevel} />
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 rounded-sm outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={images.length >= 5 && files.length >= 10}
                        >
                          <AttachIcon className="h-4 w-4" />
                        </Button>
                      )}
                      <div className="ml-1">
                        <AgentSendButton
                          isStreaming={false}
                          isSubmitting={
                            createChatMutation.isPending ||
                            isUploading
                          }
                          disabled={Boolean(
                            !hasContent || !selectedWorkspace || isUploading,
                          )}
                          onClick={handleSend}
                          mode={agentMode}
                          hasContent={hasContent}
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

                {/* Project, Work Mode, and Branch selectors - directly under input */}
                <div className="mt-1.5 md:mt-2 ml-[5px] flex items-center gap-2">

                  {/* Branch selector - only visible when worktree mode is selected */}
                  {validatedProject && workMode === "worktree" && (
                    <Popover
                      open={branchPopoverOpen}
                      onOpenChange={(open) => {
                        if (!open) {
                          setBranchSearch("") // Clear search on close
                        }
                        setBranchPopoverOpen(open)
                      }}
                    >
                      <PopoverTrigger asChild>
                        <button
                          className="flex items-center gap-1.5 px-2 py-1 text-sm text-muted-foreground hover:text-foreground transition-[background-color,color] duration-150 ease-out rounded-md hover:bg-muted/50 outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70"
                          disabled={branchesQuery.isLoading}
                        >
                          <BranchIcon className="w-4 h-4" />
                          <span className="opacity-70">Branch</span>
                          <span className="truncate max-w-[100px]">
                            {selectedBranch ||
                              branchesQuery.data?.defaultBranch ||
                              "main"}
                          </span>
                          <IconChevronDown className="w-3 h-3 opacity-50" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-80 p-0" align="start">
                        {/* Search input with Create button */}
                        <div className="flex items-center gap-1.5 h-7 px-1.5 mx-1 my-1 rounded-md bg-muted/50">
                          <SearchIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <input
                            type="text"
                            placeholder="Search branches..."
                            value={branchSearch}
                            onChange={(e) => setBranchSearch(e.target.value)}
                            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                            autoFocus
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-1.5 flex items-center gap-1 text-xs shrink-0"
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              setCreateBranchDialogOpen(true)
                              setBranchPopoverOpen(false)
                            }}
                          >
                            <Plus className="h-3 w-3" />
                            Create
                          </Button>
                        </div>

                        {/* Virtualized branch list */}
                        {filteredBranches.length === 0 ? (
                          <div className="py-6 text-center text-sm text-muted-foreground">
                            No branches found.
                          </div>
                        ) : (
                          <div
                            ref={branchListRef}
                            className="overflow-auto py-1 scrollbar-hide"
                            style={{
                              height: Math.min(
                                filteredBranches.length * 32 + 8,
                                300,
                              ),
                            }}
                          >
                            <div
                              style={{
                                height: `${branchVirtualizer.getTotalSize()}px`,
                                width: "100%",
                                position: "relative",
                              }}
                            >
                              {branchVirtualizer
                                .getVirtualItems()
                                .map((virtualItem) => {
                                  const branch =
                                    filteredBranches[virtualItem.index]
                                  const isSelected =
                                    (selectedBranch === branch.name &&
                                      selectedBranchType === branch.type) ||
                                    (!selectedBranch && branch.isDefault && branch.type === "local")
                                  return (
                                    <button
                                      key={`${branch.type}-${branch.name}`}
                                      onClick={() => {
                                        setSelectedBranch(branch.name, branch.type)
                                        setBranchPopoverOpen(false)
                                        setBranchSearch("")
                                      }}
                                      className={cn(
                                        "flex items-center gap-1.5 w-[calc(100%-8px)] mx-1 px-1.5 text-sm text-left absolute left-0 top-0 rounded-md cursor-default select-none outline-none transition-colors",
                                        isSelected
                                          ? "dark:bg-neutral-800 text-foreground"
                                          : "dark:hover:bg-neutral-800 hover:text-foreground",
                                      )}
                                      style={{
                                        height: `${virtualItem.size}px`,
                                        transform: `translateY(${virtualItem.start}px)`,
                                      }}
                                    >
                                      <BranchIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                                      <span className="truncate flex-1">
                                        {branch.name}
                                      </span>
                                      <span
                                        className={cn(
                                          "text-[10px] px-1.5 py-0.5 rounded shrink-0",
                                          branch.type === "local"
                                            ? "bg-blue-500/10 text-blue-500"
                                            : "bg-orange-500/10 text-orange-500",
                                        )}
                                      >
                                        {branch.type}
                                      </span>
                                      {branch.committedAt && (
                                        <span className="text-xs text-muted-foreground/70 shrink-0">
                                          {formatRelativeTime(
                                            branch.committedAt,
                                          )}
                                        </span>
                                      )}
                                      {branch.isDefault && (
                                        <span className="text-[10px] text-muted-foreground/70 bg-muted px-1.5 py-0.5 rounded shrink-0">
                                          default
                                        </span>
                                      )}
                                      {isSelected && (
                                        <CheckIcon className="h-4 w-4 shrink-0 ml-auto" />
                                      )}
                                    </button>
                                  )
                                })}
                            </div>
                          </div>
                        )}
                      </PopoverContent>
                    </Popover>
                  )}

                  {/* Create Branch Dialog */}
                  {validatedProject && (
                    <CreateBranchDialog
                      open={createBranchDialogOpen}
                      onOpenChange={setCreateBranchDialogOpen}
                      projectPath={validatedProject.path}
                      branches={branches}
                      defaultBranch={
                        branchesQuery.data?.defaultBranch || "main"
                      }
                      onBranchCreated={(branchName) => {
                        setSelectedBranch(branchName, "local")
                      }}
                    />
                  )}
                </div>

                {/* Worktree config banner - moved to corner banner below */}

                {/* File mention dropdown */}
                {/* Desktop: use projectPath for local file search */}
                <AgentsFileMention
                  isOpen={showMentionDropdown && !!validatedProject}
                  onClose={() => {
                    setShowMentionDropdown(false)
                    // Reset subpage state when dropdown closes
                    setShowingFilesList(false)
                    setShowingSkillsList(false)
                    setShowingAgentsList(false)
                    setShowingToolsList(false)
                  }}
                  onSelect={handleMentionSelect}
                  searchText={mentionSearchText}
                  position={mentionPosition}
                  projectPath={validatedProject?.path}
                  showingFilesList={showingFilesList}
                  showingSkillsList={showingSkillsList}
                  showingAgentsList={showingAgentsList}
                  showingToolsList={showingToolsList}
                  scope={mentionScope}
                  boundAgents={collaborationMode === "group" ? boundGroupAgents : undefined}
                />

                {/* Slash command dropdown */}
                <AgentsSlashCommand
                  isOpen={showSlashDropdown}
                  onClose={handleCloseSlashTrigger}
                  onSelect={handleSlashSelect}
                  searchText={slashSearchText}
                  position={slashPosition}
                  chatId={selectedChatId ?? undefined}
                  mode={agentMode}
                  disabledCommands={["clear"]}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Worktree config banner - fixed bottom-right corner */}
      {showWorktreeBanner && (
        <div className="absolute bottom-4 right-4 max-w-sm p-3 pb-4 bg-muted/50 backdrop-blur-sm rounded-lg border border-border space-y-3 shadow-lg z-50">
          <p className="text-sm text-muted-foreground">
            Configure a worktree setup script to install dependencies or copy
            environment variables.
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleConfigureWorktree}
            >
              Settings
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const prompt = COMMAND_PROMPTS["worktree-setup"]
                if (prompt && validatedProject) {
                  createChatMutation.mutate({
                    projectId: validatedProject.id,
                    workspaceId: selectedWorkspaceId || undefined,
                    name: "Worktree Setup",
                    model: selectedChatModel || undefined,
                    initialMessageParts: [
                      { type: "text", text: prompt },
                    ],
                    useWorktree: false,
                    mode: "agent",
                  })
                }
              }}
            >
              Fill with AI
            </Button>
          </div>
        </div>
      )}
        </div>

        {canUseRightSidebar && activeRightSidebar === "details" && (
          <DetailsSidebar
            chatId={validatedProject!.id}
            worktreePath={validatedProject!.path}
            planPath={null}
            mode="agent"
            isTerminalSidebarOpen={false}
            isDiffSidebarOpen={false}
            diffDisplayMode="side-peek"
            canOpenDiff={false}
          />
        )}

        {canUseRightSidebar &&
          activeRightSidebar === "terminal" &&
          terminalDisplayMode === "side-peek" && (
            <TerminalSidebar
              chatId={validatedProject!.id}
              scopeKey={terminalScopeKey}
              cwd={validatedProject!.path}
              workspaceId={validatedProject!.id}
            />
          )}
      </div>

      {canUseRightSidebar &&
        activeRightSidebar === "terminal" &&
        terminalDisplayMode === "bottom" && (
          <ResizableBottomPanel
            isOpen
            onClose={() => setIsTerminalSidebarOpen(false)}
            heightAtom={terminalBottomHeightAtom}
            minHeight={150}
            maxHeight={500}
            className="bg-background border-t"
            style={{ borderTopWidth: "0.5px" }}
          >
            <TerminalBottomPanelContent
              chatId={validatedProject!.id}
              scopeKey={terminalScopeKey}
              cwd={validatedProject!.path}
              workspaceId={validatedProject!.id}
              onClose={() => setIsTerminalSidebarOpen(false)}
            />
          </ResizableBottomPanel>
        )}
    </div>
  )
}
