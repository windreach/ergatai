import type { FileUIPart, ReasoningUIPart, TextUIPart, UIMessage } from "ai";
import type { ChatPart, MessageAnchor, PendingApproval, ToolGroup } from "./types";

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

export function conversationSignature(messages: UIMessage[]): string {
  return messages.map((message) => `${message.id}:${messageText(message).length}`).join("|");
}

export function groupParts(parts: ChatPart[]): (ChatPart | ToolGroup)[] {
  const result: (ChatPart | ToolGroup)[] = [];
  let currentGroup: ChatPart[] | null = null;

  for (const part of parts) {
    if (isToolPart(part)) {
      if (!currentGroup) {
        currentGroup = [];
        result.push({ parts: currentGroup });
      }
      currentGroup.push(part);
    } else {
      currentGroup = null;
      result.push(part);
    }
  }

  return result;
}

export function isTextPart(part: ChatPart): part is TextUIPart {
  return part.type === "text";
}

export function isFilePart(part: ChatPart): part is FileUIPart {
  return part.type === "file";
}

export function isReasoningPart(part: ChatPart): part is ReasoningUIPart {
  return part.type === "reasoning";
}

export function isToolPart(part: ChatPart): boolean {
  return part.type.startsWith("tool-");
}

export function messageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is TextUIPart => isTextPart(part))
    .map((part) => part.text)
    .join("\n\n");
}

export function userMessageAnchors(messages: UIMessage[]): MessageAnchor[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => ({ id: message.id, text: messageText(message) }));
}

export function findPendingApproval(messages: UIMessage[]): PendingApproval | null {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== "assistant") return null;

  for (let index = lastMessage.parts.length - 1; index >= 0; index -= 1) {
    const part = lastMessage.parts[index];
    const record = part as Record<string, unknown>;
    if (record.state !== "approval-requested") continue;
    const approval = record.approval as { id?: string; requestReason?: string; reason?: string } | undefined;
    const approvalId = approval?.id ?? (record.approvalId as string | undefined);
    if (!approvalId) continue;
    return {
      id: approvalId,
      toolName: part.type === "dynamic-tool"
        ? String(record.toolName ?? "tool")
        : part.type.replace("tool-", ""),
      reason: approval?.requestReason ?? approval?.reason,
      input: record.input,
    };
  }
  return null;
}
