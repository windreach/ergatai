export type ConversationStatus = "draft" | "in-progress" | "needs-input" | "done"

interface WorkspaceStatusDependencies {
  workspacesLoading: Set<string>
  workspacesWithPendingQuestions: Set<string>
  workspacesWithPendingApprovals: Set<string>
}

export function deriveWorkspaceStatus(
  chatId: string,
  deps: WorkspaceStatusDependencies
): ConversationStatus {
  const { workspacesLoading, workspacesWithPendingQuestions, workspacesWithPendingApprovals } = deps

  // 1. Needs Input - has pending question or plan approval (highest priority - user action required)
  if (workspacesWithPendingQuestions.has(chatId) || workspacesWithPendingApprovals.has(chatId)) {
    return "needs-input"
  }

  // 2. In Progress - any conversation is loading
  if (workspacesLoading.has(chatId)) {
    return "in-progress"
  }

  // 3. Done - everything else (workspaces are never "draft" - they always have at least one conversation)
  return "done"
}
