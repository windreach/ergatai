import type { InteractionEvent } from "./protocol"

export type PolicyRoute =
  | "lightweight_chat"
  | "single_agent_run"
  | "supervisor_session"
  | "group_session"
  | "dag_import"

export type NormalizedInteraction =
  | {
      type: "message_submitted"
      chatId: string
      text: string
      mentions: string[]
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
  | {
      type: "workspace_selected"
      workspaceId: string
    }
  | {
      type: "run_cancelled"
      runId: string
      workspaceId?: string
    }

export function normalizeInteraction(
  event: InteractionEvent,
): NormalizedInteraction {
  switch (event.type) {
    case "message_submitted":
      return {
        type: event.type,
        chatId: event.chatId,
        text: event.text.trim(),
        mentions: deduplicate(event.mentions ?? []),
        workspaceId: event.workspaceId,
      }
    case "workspace_selected":
      return event
    case "agent_mentioned":
    case "approval_granted":
    case "approval_rejected":
    case "artifact_selected":
    case "run_cancelled":
      return {
        ...event,
        workspaceId: event.workspaceId,
      }
    default:
      return event
  }
}

export function routeInteraction(
  interaction: NormalizedInteraction,
  options: {
    collaborationMode: "supervisor" | "group"
    hasPersistedDagSession?: boolean
  },
): PolicyRoute {
  if (
    interaction.type !== "message_submitted" &&
    interaction.type !== "agent_mentioned"
  ) {
    return "lightweight_chat"
  }

  if (options.hasPersistedDagSession) {
    return "dag_import"
  }
  if (
    interaction.type === "agent_mentioned" ||
    interaction.mentions.length > 0
  ) {
    return "group_session"
  }

  if (options.collaborationMode === "group") {
    return "group_session"
  }
  if (isComplexTask(interaction.text)) {
    return "supervisor_session"
  }
  if (requiresRun(interaction.text)) {
    return "single_agent_run"
  }
  return "lightweight_chat"
}

function isComplexTask(text: string): boolean {
  return (
    /\b(and then|step\s*\d|first.*then|implement|refactor|migrate|investigate|architecture|across)\b/i.test(
      text,
    ) || text.length > 500
  )
}

function requiresRun(text: string): boolean {
  return (
    /\b(fix|build|create|write|run|test|review|deploy|generate|update|delete)\b/i.test(
      text,
    )
  )
}

function deduplicate(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)))
}
