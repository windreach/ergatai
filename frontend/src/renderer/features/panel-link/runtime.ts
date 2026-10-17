import type { PanelLinkCommand, PanelLinkRuntimeEvent } from "./types"

export function normalizePanelLinkRuntimeEvent(
  event: PanelLinkRuntimeEvent,
): PanelLinkCommand {
  switch (event.type) {
    case "agent-status-changed":
      return {
        type: "sync-panel-target",
        panelId: "side-chat",
        source: "runtime",
        target: {
          kind: "agent",
          id: `${event.chatId}:${event.agentId}`,
          agentId: event.agentId,
          chatId: event.chatId,
          workspaceId: event.workspaceId,
          metadata: {
            status: event.status,
            requestId: event.requestId,
          },
        },
      }

    case "active-file-changed":
      return {
        type: "sync-panel-target",
        panelId: "diff",
        source: "runtime",
        target: {
          kind: "file",
          id: event.path,
          path: event.path,
          chatId: event.chatId,
          workspaceId: event.workspaceId,
        },
      }

    case "terminal-focused":
      return {
        type: "sync-panel-target",
        panelId: "terminal",
        source: "runtime",
        target: {
          kind: "terminal",
          id: event.terminalId,
          chatId: event.chatId,
          workspaceId: event.workspaceId,
        },
      }

    case "side-chat-changed":
      return {
        type: "sync-panel-target",
        panelId: "side-chat",
        source: "runtime",
        target: {
          kind: "chat",
          id: event.sideChatId,
          agentId: event.agentId,
          chatId: event.chatId,
          workspaceId: event.workspaceId,
        },
      }
  }
}
