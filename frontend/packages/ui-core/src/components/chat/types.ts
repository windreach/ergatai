import type { UIMessage } from "ai";

export type ChatPart = UIMessage["parts"][number];

export interface AttachedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  previewUrl?: string;
}

export type PermissionMode = "manual" | "auto" | "full";
export type MessageFeedback = "up" | "down";

export interface MessageAnchor {
  id: string;
  text: string;
}

export interface PendingApproval {
  id: string;
  toolName: string;
  reason?: string;
  input: unknown;
}

export interface ToolGroup {
  parts: ChatPart[];
}

export const maxAttachmentCount = 8;
export const maxAttachmentSize = 10 * 1024 * 1024;

export const permissionModes: { value: PermissionMode; labelKey: string }[] = [
  { value: "manual", labelKey: "chat.permissionManual" },
  { value: "auto", labelKey: "chat.permissionAuto" },
  { value: "full", labelKey: "chat.permissionFull" },
];
