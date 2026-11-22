/**
 * Unified agent session API (Phase 3).
 *
 * This is the single renderer-side entry point for resolving/spawning agents,
 * sending prompts, and switching the durable conversation model. All callers
 * should go through these helpers instead of invoking `trpcClient.ergatai.*`
 * directly, so the backend's `AgentLaunchService` remains the single source of
 * truth for agent lifecycle and model selection.
 */

import { trpcClient } from "../../../lib/trpc"

export interface SpawnAgentRequest {
  command: string
  workspaceId?: string
  workspace_id?: string
  conversationId?: string
  conversation_id?: string
  instruction?: string
  workDir?: string
  work_dir?: string
  env?: Record<string, string>
  providerConnectionId?: string
  provider_connection_id?: string
  model?: string
  temporaryAgent?: boolean
  temporary_agent?: boolean
}

export async function spawnAgent(request: SpawnAgentRequest): Promise<string> {
  const response = await trpcClient.ergatai.spawnAgent.mutate(request as any)
  const result = response as Record<string, unknown>
  const agentId = (result.agent_id ?? result.agentId) as string | undefined
  if (!agentId) {
    throw new Error("Ergatai backend did not return an agent ID")
  }
  return agentId
}

export interface EnsureAgentForConversationInput {
  conversationId: string
  profile?: string
  mode?: "ensure" | "spawn_new" | "resume_only"
  model?: string
  modelMode?: "seed" | "override"
  thinking?: string
  providerConnectionId?: string
  allowNativeDefault?: boolean
}

export interface EnsureAgentResult {
  agent_id: string
  action?: "reused" | "resumed" | "spawned"
  conversation_id?: string
  model?: { selection?: { id?: string } } | null
  model_source?: string
  provider_connection_id?: string | null
}

export async function ensureAgentForConversation(
  input: EnsureAgentForConversationInput,
): Promise<EnsureAgentResult> {
  const response = await trpcClient.ergatai.ensureAgent.mutate({
    conversationId: input.conversationId,
    profile: input.profile,
    mode: input.mode,
    model: input.model,
    modelMode: input.modelMode,
    thinking: input.thinking,
    providerConnectionId: input.providerConnectionId,
    allowNativeDefault: input.allowNativeDefault,
  })
  if (!response?.agent_id) {
    throw new Error("Ergatai backend did not return an agent ID from ensureAgent")
  }
  return response as EnsureAgentResult
}

export interface PromptConversationInput {
  agentId: string
  message: string
  conversationId?: string
  images?: Array<{ base64Data: string; mediaType: string; filename?: string }>
  files?: Array<{
    base64Data: string
    mediaType?: string
    filename: string
    size?: number
  }>
  clientRequestId?: string
  interrupt?: boolean
  waitForStream?: boolean
  fromAgentId?: string
  targetAgentCommand?: string
  forceNewSession?: boolean
  messageType?: "request" | "response" | "broadcast"
  correlationId?: string
}

export async function promptConversation(input: PromptConversationInput): Promise<any> {
  if (input.fromAgentId) {
    return trpcClient.ergatai.sendMessage.mutate({
      agentId: input.agentId,
      message: input.message,
      from: input.fromAgentId,
      messageType: input.messageType ?? "request",
      targetAgentCommand: input.targetAgentCommand,
      forceNewSession: input.forceNewSession,
      correlationId: input.correlationId,
      conversationId: input.conversationId,
      clientRequestId: input.clientRequestId,
    })
  }
  return trpcClient.ergatai.promptAgent.mutate({
    agentId: input.agentId,
    message: input.message,
    conversationId: input.conversationId,
    images: input.images,
    files: input.files,
    waitForStream: input.waitForStream,
    clientRequestId: input.clientRequestId,
    interrupt: input.interrupt,
  })
}

export interface SelectConversationModelInput {
  agentId?: string
  conversationId?: string
  model: string
  thinking?: string | null
}

export async function selectConversationModel(input: SelectConversationModelInput): Promise<any> {
  if (!input.agentId) {
    // No live agent: rely on the durable conversation setting being persisted
    // by the caller; nothing to apply live. Return a recorded marker.
    return { recorded: true }
  }
  return trpcClient.ergatai.setAgentModel.mutate({
    agentId: input.agentId,
    model: input.model,
    conversationId: input.conversationId,
  })
}
