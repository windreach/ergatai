export function setOptOut() {}

export function initAnalytics() {}

export function capture(_eventName: string, _properties?: Record<string, unknown>) {}

export function identify() {}

export function reset() {}

export async function shutdown() {}

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
