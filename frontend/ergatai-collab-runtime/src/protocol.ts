export const COLLAB_RUNTIME_PROTOCOL_VERSION = 1

export type CollaborationMode = "supervisor" | "group"

export type ArtifactReference = {
  id: string
  kind: "workspace" | "file" | "git_snapshot" | "external"
  managedBy: "rust"
}

export type InteractionEvent =
  | {
      type: "message_submitted"
      chatId: string
      text: string
      mentions?: string[]
      workspaceId?: string
    }
  | {
      type: "agent_mentioned"
      chatId: string
      agentId: string
      workspaceId?: string
    }
  | {
      type: "approval_granted"
      runId: string
      approvalId: string
      workspaceId?: string
    }
  | {
      type: "approval_rejected"
      runId: string
      approvalId: string
      workspaceId?: string
    }
  | {
      type: "artifact_selected"
      artifactId: string
      workspaceId?: string
    }
  | { type: "workspace_selected"; workspaceId: string }
  | { type: "run_cancelled"; runId: string; workspaceId?: string }

export type RuntimeCommandType =
  | "hello"
  | "health"
  | "apply_interaction"
  | "resume_session"
  | "approve"
  | "reject"
  | "cancel"
  | "shutdown"

export type RuntimeCommand =
  | { type: "hello" }
  | { type: "health" }
  | {
      type: "apply_interaction"
      interaction: InteractionEvent
      collaborationMode?: CollaborationMode
    }
  | { type: "resume_session"; sessionId: string }
  | { type: "approve"; runId: string; approvalId: string }
  | { type: "reject"; runId: string; approvalId: string }
  | { type: "cancel"; sessionId?: string; runId?: string }
  | { type: "shutdown" }

export type RuntimeEvent =
  | {
      type: "ready"
      protocolVersion: number
      runtimeVersion: string
    }
  | {
      type: "session_created"
      sessionId: string
      chatId: string
      mode: CollaborationMode
      route: string
    }
  | {
      type: "run_created"
      sessionId: string
      runId: string
      chatId: string
      title: string
    }
  | {
      type: "agent_assigned"
      sessionId: string
      runId: string
      chatId: string
      agentId: string
    }
  | {
      type: "progress_updated"
      sessionId: string
      runId: string
      chatId: string
      summary: string
      status: "running" | "awaiting_approval" | "completed" | "cancelled" | "failed"
    }
  | {
      type: "approval_required"
      sessionId: string
      chatId: string
      runId: string
      approvalId: string
      summary: string
    }
  | {
      type: "artifact_ready"
      runId: string
      artifactId: string
      reference?: ArtifactReference
    }
  | {
      type: "run_cancelled"
      sessionId: string
      runId: string
      chatId: string
    }
  | {
      type: "session_cancelled"
      sessionId: string
      chatId: string
    }
  | { type: "session_completed"; sessionId: string; chatId: string }
  | { type: "session_failed"; sessionId: string; chatId: string; reason: string }
  | { type: "protocol_error"; reason: string }

export type RuntimeResult =
  | {
      type: "hello"
      protocolVersion: number
      runtimeVersion: string
    }
  | {
      type: "health"
      status: "ok"
      protocolVersion: number
      uptimeMs: number
      activeSessions: number
    }
  | { type: "accepted" }
  | {
      type: "interaction_routed"
      route: string
      sessionId?: string
      runId?: string
    }

export interface RuntimeRequest {
  id: string
  protocolVersion: number
  token: string
  command: RuntimeCommand
}

export type RuntimeResponse =
  | {
      id: string
      protocolVersion: number
      ok: true
      result: RuntimeResult
    }
  | {
      id: string
      protocolVersion: number
      ok: false
      error: {
        code:
          | "unauthorized"
          | "unsupported_protocol"
          | "invalid_command"
          | "not_implemented"
          | "internal_error"
        message: string
      }
    }

export type RuntimeFrame =
  | { kind: "request"; data: RuntimeRequest }
  | { kind: "response"; data: RuntimeResponse }
  | { kind: "event"; data: RuntimeEvent }
