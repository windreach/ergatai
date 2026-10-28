import { app } from "electron"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { randomToken } from "../../shared/id"

let cachedUserId: string | null = null

export function setOptOut() {}

export function setSubscriptionPlan() {}

export function setConnectionMethod(_method?: string) {}

export function initAnalytics() {}

export function capture(_eventName: string, _properties?: Record<string, unknown>) {}

export function identify() {}

export function getCurrentUserId(): string | null {
  if (cachedUserId) return cachedUserId

  try {
    const userIdPath = join(app.getPath("userData"), ".analytics-user-id")
    if (existsSync(userIdPath)) {
      cachedUserId = readFileSync(userIdPath, "utf-8").trim()
      return cachedUserId
    }

    // Generate a new random user ID and persist it
    cachedUserId = randomToken(16)
    writeFileSync(userIdPath, cachedUserId, { mode: 0o600 })
    return cachedUserId
  } catch {
    return "local-user"
  }
}

export function reset() {}

export async function shutdown() {}

export function trackAppOpened() {}

export function trackAuthCompleted(_userId?: string, _email?: string) {}

export function trackProjectOpened(project: Record<string, unknown>) {
  capture("project_opened", project)
}

export function trackWorkspaceCreated(workspace: Record<string, unknown>) {
  capture("workspace_created", workspace)
}

export function trackWorkspaceArchived(workspaceId: string) {
  capture("workspace_archived", { workspaceId })
}

export function trackWorkspaceDeleted(workspaceId: string) {
  capture("workspace_deleted", { workspaceId })
}

export function trackMessageSent(data: Record<string, unknown>) {
  capture("message_sent", data)
}

export function trackPRCreated(data: Record<string, unknown>) {
  capture("pr_created", data)
}

export function trackCommitCreated(data: Record<string, unknown>) {
  capture("commit_created", data)
}

export function trackConversationCreated(data: Record<string, unknown>) {
  capture("conversation_created", data)
}
