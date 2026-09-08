/**
 * 统一 ChatPanel 组件
 *
 * 合并了 tabs/ChatPanel (AI SDK 全功能) 和 chat/ChatPanel (多模式 + 双数据源) 的所有功能。
 *
 * 数据源优先级:
 * 1. conversationStore → 宿主提供的消息源
 * 2. aiSdkTransport → 自定义 useChat 钩子
 * 3. 默认 → useChat + chatTransport + IndexedDB 持久化
 *
 * 三种模式: single / group / sidebar，通过 ChatPanelFeatures 控制功能开关。
 */

import { useEffect, useRef, useState, type ChangeEvent, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useChat } from "@ai-sdk/react";
import type { UIMessage, FileUIPart } from "ai";
import {
  ArrowDown,
  Shield,
  X,
  CircleX,
  RotateCcw,
  Copy,
  Check,
  Pencil,
  ThumbsUp,
  ThumbsDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { MarkdownContent } from "../MarkdownContent";
import {
  chatTransport,
  type UnifiedMessagePart,
  type AgentSummary,
  type WorkspaceInfo,
  fetchAgents,
  fetchWorkspaces,
  fetchGitBranches,
} from "@ergatai/platform-core";
import { loadChatMessages, saveChatMessages } from "@ergatai/platform-core";
import {
  ChatLightbox,
  ReasoningBlock,
  ToolGroupBlock,
  UserFileCard,
} from "./message-blocks";
import {
  maxAttachmentCount,
  maxAttachmentSize,
  type AttachedFile,
  type MessageFeedback,
  type PermissionMode,
} from "./types";
import { ChatComposer } from "./ChatComposer";
import { ChatHeader } from "./ChatHeader";
import {
  conversationSignature,
  fileToDataUrl,
  findPendingApproval,
  groupParts,
  isFilePart,
  isReasoningPart,
  isTextPart,
  messageText,
  userMessageAnchors,
} from "./utils";
import type { ChatPanelProps, ChatPanelFeatures } from "./ChatPanel.types";
import { getFeaturesForMode } from "./ChatPanel.types";
import { PartRenderer } from "./components/PartRenderer";
import { useConversationStoreChatState } from "./hooks/useChatState";

// ─── Main exported component ─────────────────────────────────────────────────

export function ChatPanel(props: ChatPanelProps) {
  const {
    mode = "single",
    features: customFeatures,
    conversationId,
    agentName,
    agentId,
    conversationStore,
    aiSdkTransport,
    className,
    maxHeight,
  } = props;

  const features: ChatPanelFeatures = useMemo(
    () => ({ ...getFeaturesForMode(mode), ...customFeatures }),
    [mode, customFeatures],
  );

  // conversationStore path (no AI SDK)
  if (conversationStore && !aiSdkTransport) {
    return (
      <StoreBackedChatPanel
        {...props}
        mode={mode}
        features={features}
        className={className}
        maxHeight={maxHeight}
      />
    );
  }

  // AI SDK path (default, or when aiSdkTransport is explicitly provided)
  return (
    <AiSdkBackedChatPanel
      {...props}
      mode={mode}
      features={features}
      conversationId={conversationId ?? "default"}
      agentName={agentName ?? agentId}
      className={className}
      maxHeight={maxHeight}
    />
  );
}

// Re-export as UnifiedChatPanel for backward compat
export { ChatPanel as UnifiedChatPanel };

// ─── AI SDK backed path ──────────────────────────────────────────────────────

function AiSdkBackedChatPanel({
  mode: _mode,
  features,
  conversationId,
  agentName,
  aiSdkTransport,
  headerLeading,
  onConversationSaved,
  className,
  maxHeight,
}: ChatPanelProps & { features: ChatPanelFeatures; conversationId: string; agentName?: string }) {
  const { t } = useTranslation();
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [isAwayFromBottom, setIsAwayFromBottom] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [permission, setPermission] = useState<PermissionMode>("manual");
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const permissionRef = useRef<HTMLDivElement>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [lightboxScale, setLightboxScale] = useState(1);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, MessageFeedback>>({});
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [gitBranches, setGitBranches] = useState<string[]>([]);
  const [branches, setBranches] = useState<Record<string, UIMessage[][]>>({});
  const [activeBranches, setActiveBranches] = useState<Record<string, number>>({});
  const messageAnchorRefs = useRef(new Map<string, HTMLElement>());
  const [hydratedConversationId, setHydratedConversationId] = useState<string | null>(null);

  const activeConversationId = conversationId ?? "default";
  const chatHydrated = hydratedConversationId === activeConversationId;

  // Fetch header data
  useEffect(() => {
    let cancelled = false;
    void fetchAgents().then((list) => {
      if (cancelled) return;
      setAgents(list);
      setSelectedAgentId((prev) => prev ?? list[0]?.id ?? null);
    }).catch(() => {});
    void fetchWorkspaces().then((list) => {
      if (cancelled) return;
      setWorkspaces(list);
      setSelectedWorkspaceId((prev) => prev ?? list[0]?.id ?? null);
    }).catch(() => {});
    void fetchGitBranches().then((info) => {
      if (cancelled) return;
      setGitBranch(info.current);
      setGitBranches(info.branches);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // useChat — either from the provided transport or the default chatTransport
  const defaultChat = useChat({
    id: activeConversationId,
    transport: chatTransport,
    sendAutomaticallyWhen: ({ messages: currentMessages }) => {
      const lastMessage = currentMessages[currentMessages.length - 1];
      const parts = lastMessage?.parts ?? [];
      return parts.some((part) => (part as Record<string, unknown>).state === "approval-responded");
    },
  });

  const chat = aiSdkTransport ? aiSdkTransport.useChat() : defaultChat;

  const { messages, sendMessage, setMessages, status, stop, regenerate, error, clearError, addToolApprovalResponse } = chat;
  const sending = status === "submitted" || status === "streaming";
  const isEmpty = messages.length === 0 && !sending;
  const messageAnchors = useMemo(() => features.scrollNavigation ? userMessageAnchors(messages) : [], [messages, features.scrollNavigation]);
  const pendingApproval = features.approvals ? findPendingApproval(messages) : null;

  // IndexedDB persistence
  useEffect(() => {
    let cancelled = false;
    void loadChatMessages(activeConversationId)
      .then((loadedMessages) => {
        if (cancelled) return;
        setMessages(loadedMessages);
        setHydratedConversationId(activeConversationId);
      })
      .catch(() => {
        if (!cancelled) {
          setHydratedConversationId(activeConversationId);
          setAttachmentError(t("chat.storageFailed"));
        }
      });
    return () => { cancelled = true; };
  }, [activeConversationId, setMessages, t]);

  useEffect(() => {
    if (sending || !chatHydrated) return;
    void saveChatMessages(activeConversationId, messages)
      .then(() => onConversationSaved?.(activeConversationId))
      .catch(() => {
        setAttachmentError(t("chat.storageFailed"));
      });
  }, [activeConversationId, chatHydrated, messages, onConversationSaved, sending, t]);

  // Auto-scroll
  useEffect(() => {
    if (isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, sending]);

  // Lightbox keyboard handler
  useEffect(() => {
    if (!lightboxUrl) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setLightboxUrl(null);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [lightboxUrl]);

  // Permission dropdown outside click
  const closePermission = useCallback((e: MouseEvent) => {
    if (permissionRef.current && !permissionRef.current.contains(e.target as Node)) {
      setPermissionOpen(false);
    }
  }, []);

  useEffect(() => {
    if (!permissionOpen) return;
    document.addEventListener("mousedown", closePermission);
    return () => document.removeEventListener("mousedown", closePermission);
  }, [permissionOpen, closePermission]);

  // ─── Handlers ────────────────────────────────────────────────────────────

  function handleScroll() {
    const el = scrollContainerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    isAtBottomRef.current = isAtBottom;
    setIsAwayFromBottom(!isAtBottom);
    updateActiveMessage();
  }

  function scrollToBottom() {
    isAtBottomRef.current = true;
    setIsAwayFromBottom(false);
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  function send(text: string) {
    if (!text.trim() || sending) return;
    sendMessage({ text: text.trim() }, { body: { permission } });
  }

  function handleStop() {
    stop();
  }

  function regenerateMessage(messageId: string) {
    if (sending || !features.regeneration) return;
    const messageIndex = messages.findIndex((message) => message.id === messageId);
    if (messageIndex === -1 || messages[messageIndex].role !== "assistant") return;
    const snapshots = branches[messageId] ?? [];
    const existingIndex = snapshots.findIndex((snapshot) => conversationSignature(snapshot) === conversationSignature(messages));
    const nextSnapshots = existingIndex >= 0 ? snapshots : [...snapshots, messages];
    setBranches((current) => ({ ...current, [messageId]: nextSnapshots }));
    setActiveBranches((current) => ({ ...current, [messageId]: nextSnapshots.length }));
    setFeedback((current) => {
      const next = { ...current };
      for (const message of messages.slice(messageIndex)) {
        delete next[message.id];
      }
      return next;
    });
    regenerate({ messageId, body: { permission } });
  }

  async function copyMessage(message: UIMessage) {
    const text = messageText(message);
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopiedMessageId(message.id);
    window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? null : current), 1600);
  }

  function startEditing(message: UIMessage) {
    if (!features.messageEditing) return;
    setEditingMessageId(message.id);
    setEditingText(messageText(message));
  }

  function cancelEditing() {
    setEditingMessageId(null);
    setEditingText("");
  }

  function submitEditing(message: UIMessage) {
    const text = editingText.trim();
    if (!text || sending) return;
    const files = message.parts.filter((part): part is FileUIPart => isFilePart(part));
    const snapshots = branches[message.id] ?? [];
    const existingIndex = snapshots.findIndex((snapshot) => conversationSignature(snapshot) === conversationSignature(messages));
    const nextSnapshots = existingIndex >= 0 ? snapshots : [...snapshots, messages];
    setBranches((current) => ({ ...current, [message.id]: nextSnapshots }));
    setActiveBranches((current) => ({ ...current, [message.id]: nextSnapshots.length }));
    cancelEditing();
    if (files.length > 0) {
      sendMessage({ text, files, messageId: message.id }, { body: { permission } });
    } else {
      sendMessage({ text, messageId: message.id }, { body: { permission } });
    }
  }

  function switchBranch(messageId: string, index: number) {
    const snapshots = branches[messageId] ?? [];
    const currentIndex = snapshots.findIndex((snapshot) => conversationSignature(snapshot) === conversationSignature(messages));
    const normalizedSnapshots = currentIndex >= 0 ? snapshots : [...snapshots, messages];
    if (index < 0 || index >= normalizedSnapshots.length) return;
    setBranches((current) => ({ ...current, [messageId]: normalizedSnapshots }));
    setActiveBranches((current) => ({ ...current, [messageId]: index }));
    setMessages(normalizedSnapshots[index]);
  }

  function toggleFeedback(messageId: string, value: MessageFeedback) {
    if (!features.reactions) return;
    setFeedback((current) => {
      const next = { ...current };
      if (next[messageId] === value) {
        delete next[messageId];
      } else {
        next[messageId] = value;
      }
      return next;
    });
  }

  function respondToApproval(approvalId: string, approved: boolean) {
    addToolApprovalResponse({ id: approvalId, approved });
  }

  function updateActiveMessage() {
    const container = scrollContainerRef.current;
    if (!container) return;
    const threshold = container.getBoundingClientRect().top + container.clientHeight * 0.32;
    let currentId: string | null = null;
    for (const anchor of messageAnchors) {
      const element = messageAnchorRefs.current.get(anchor.id);
      if (element && element.getBoundingClientRect().top <= threshold) currentId = anchor.id;
    }
    setActiveMessageId(currentId);
  }

  function jumpToMessage(messageId: string) {
    const container = scrollContainerRef.current;
    const element = messageAnchorRefs.current.get(messageId);
    if (!container || !element) return;
    container.scrollTo({ top: Math.max(0, element.offsetTop - 28), behavior: "smooth" });
    setActiveMessageId(messageId);
    setHighlightedMessageId(messageId);
    window.setTimeout(() => {
      setHighlightedMessageId((current) => current === messageId ? null : current);
    }, 1500);
  }

  function openLightbox(url: string) {
    if (!features.lightbox) return;
    setLightboxScale(1);
    setLightboxUrl(url);
  }

  function submitInput() {
    const el = textareaRef.current;
    if (!el) return;
    const val = el.value.trim();
    if (!val && attachments.length === 0) return;
    const fileParts: FileUIPart[] = attachments.map((f) => ({
      type: "file" as const,
      mediaType: f.type || "application/octet-stream",
      filename: f.name,
      url: f.previewUrl!,
    }));
    if (fileParts.length > 0) {
      sendMessage({ text: val, files: fileParts }, { body: { permission } });
    } else {
      send(val);
    }
    el.value = "";
    el.style.height = "";
    setAttachments([]);
  }

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  async function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    if (!features.attachments) return;
    const files = e.target.files;
    if (!files) return;
    const selected = Array.from(files);
    const remaining = maxAttachmentCount - attachments.length;
    if (remaining <= 0) {
      setAttachmentError(t("chat.tooManyFiles", { count: maxAttachmentCount }));
      e.target.value = "";
      return;
    }
    const accepted = selected.slice(0, remaining);
    if (selected.length > remaining) setAttachmentError(t("chat.tooManyFiles", { count: maxAttachmentCount }));
    if (accepted.some((file) => file.size > maxAttachmentSize)) {
      setAttachmentError(t("chat.fileTooLarge", { size: 10 }));
      e.target.value = "";
      return;
    }
    try {
      const newFiles: AttachedFile[] = await Promise.all(accepted.map(async (file, index) => ({
        id: `f-${Date.now()}-${index}-${file.name}`,
        name: file.name,
        size: file.size,
        type: file.type,
        previewUrl: await fileToDataUrl(file),
      })));
      setAttachmentError(null);
      setAttachments((prev) => [...prev, ...newFiles]);
    } catch {
      setAttachmentError(t("chat.fileReadFailed"));
    }
    e.target.value = "";
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!features.attachments) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const images: { id: string; name: string; size: number; type: string; file: File }[] = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          images.push({
            id: `img-${Date.now()}-${file.name ?? "pasted"}`,
            name: file.name ?? `pasted-image.${item.type.split("/")[1]}`,
            size: file.size,
            type: file.type,
            file,
          });
        }
      }
    }
    if (images.length > 0) {
      e.preventDefault();
      const remaining = maxAttachmentCount - attachments.length;
      const accepted = images.slice(0, Math.max(0, remaining));
      if (images.length > remaining) setAttachmentError(t("chat.tooManyFiles", { count: maxAttachmentCount }));
      if (accepted.some(({ file }) => file.size > maxAttachmentSize)) {
        setAttachmentError(t("chat.fileTooLarge", { size: 10 }));
        return;
      }
      void (async () => {
        try {
          const hydrated: AttachedFile[] = await Promise.all(accepted.map(async ({ file, ...metadata }) => ({
            ...metadata,
            previewUrl: await fileToDataUrl(file),
          })));
          setAttachmentError(null);
          setAttachments((prev) => [...prev, ...hydrated]);
        } catch {
          setAttachmentError(t("chat.fileReadFailed"));
        }
      })();
    }
  }

  function clearAttachmentError() {
    setAttachmentError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitInput();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitInput();
    }
  }

  function versionCount(messageId: string) {
    return (branches[messageId]?.length ?? 0) + 1;
  }

  function activeVersion(messageId: string) {
    return activeBranches[messageId] ?? branches[messageId]?.length ?? 0;
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div
      className={cn("relative flex h-full min-h-0 flex-col overflow-hidden bg-chat", className)}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <ChatHeader
        leading={headerLeading}
        branch={gitBranch}
        branches={gitBranches}
        onBranchChange={setGitBranch}
        agents={agents}
        selectedAgentId={selectedAgentId}
        onAgentSelect={setSelectedAgentId}
      />
      {isEmpty ? (
        <div className="flex-1 flex flex-col items-center justify-center select-none">
          <h1 className="text-2xl font-semibold tracking-tight text-text mb-6">
            {agentName ?? t("tabs.chat")}
          </h1>
          <div className="w-full max-w-[560px] px-6">
            <ChatComposer
              textareaRef={textareaRef}
              fileInputRef={fileInputRef}
              permissionRef={permissionRef}
              attachments={attachments}
              permission={permission}
              permissionOpen={permissionOpen}
              sending={sending}
              autoFocus
              workspaces={workspaces}
              selectedWorkspaceId={selectedWorkspaceId}
              onWorkspaceSelect={setSelectedWorkspaceId}
              onRemoveAttachment={(id) => setAttachments((current) => current.filter((file) => file.id !== id))}
              onPermissionChange={setPermission}
              onPermissionOpenChange={setPermissionOpen}
              onSend={submitInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onInput={(event) => autoResize(event.currentTarget)}
              onFileSelect={handleFileSelect}
            />
          </div>
          {attachmentError && (
            <div className="mb-2 flex items-center justify-between rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-[12px] text-danger">
              <span>{attachmentError}</span>
              <button type="button" onClick={clearAttachmentError} aria-label={t("common.close")}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="relative flex min-h-0 flex-1">
            <div ref={scrollContainerRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <div className="relative mx-auto max-w-[680px] px-6 pt-8 pb-4 space-y-5">
                {messages.map((msg) =>
                  msg.role === "user" ? (
                    <div
                      key={msg.id}
                      ref={(element) => {
                        if (element) messageAnchorRefs.current.set(msg.id, element);
                        else messageAnchorRefs.current.delete(msg.id);
                      }}
                      className={cn(
                        "group message-item relative flex flex-col items-end animate-fade-in-up transition-opacity duration-300",
                        highlightedMessageId === msg.id && "opacity-100",
                      )}
                    >
                      {editingMessageId === msg.id ? (
                        <div className="w-full max-w-[85%] rounded-2xl border border-accent/50 bg-surface px-3 py-2.5 shadow-sm">
                          <textarea
                            value={editingText}
                            onChange={(event) => setEditingText(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault();
                                submitEditing(msg);
                              }
                              if (event.key === "Escape") cancelEditing();
                            }}
                            autoFocus
                            className="min-h-[64px] w-full resize-none bg-transparent text-[14px] leading-relaxed text-text focus:outline-none"
                          />
                          <div className="mt-2 flex justify-end gap-1.5">
                            <button type="button" onClick={cancelEditing} className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-text">
                              {t("chat.cancel")}
                            </button>
                            <button
                              type="button"
                              onClick={() => submitEditing(msg)}
                              disabled={!editingText.trim() || sending}
                              className="rounded-md bg-text px-2 py-1 text-[11px] font-medium text-bg disabled:opacity-40"
                            >
                              {t("chat.resubmit")}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className={cn(
                          "bg-bubble rounded-2xl rounded-br-md px-4 py-2.5 text-[14px] leading-relaxed max-w-[85%] space-y-2 transition-shadow duration-300",
                          highlightedMessageId === msg.id && "ring-2 ring-accent/40",
                        )}>
                          {msg.parts.map((part: UnifiedMessagePart, i: number) => {
                            if (isFilePart(part)) {
                              if (part.mediaType?.startsWith("image/")) {
                                return (
                                  <img
                                    key={i}
                                    src={part.url}
                                    alt={part.filename ?? "image"}
                                    onClick={() => openLightbox(part.url)}
                                    className="rounded-lg max-w-[200px] max-h-[150px] object-cover cursor-pointer hover:opacity-85 transition-opacity duration-150"
                                  />
                                );
                              }
                              return <UserFileCard key={i} part={part} />;
                            }
                            if (isTextPart(part)) return <p key={i}>{part.text}</p>;
                            return null;
                          })}
                        </div>
                      )}
                      <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                        {features.branching && versionCount(msg.id) > 1 && (
                          <div className="mr-1 flex items-center gap-0.5 rounded-md bg-surface px-1 text-[10px] text-muted">
                            <button type="button" onClick={() => switchBranch(msg.id, activeVersion(msg.id) - 1)} disabled={activeVersion(msg.id) === 0} aria-label={t("chat.previousVersion")} className="flex h-5 w-5 items-center justify-center rounded hover:bg-hover disabled:opacity-30">
                              <ChevronLeft className="h-3 w-3" />
                            </button>
                            <span>{activeVersion(msg.id) + 1}/{versionCount(msg.id)}</span>
                            <button type="button" onClick={() => switchBranch(msg.id, activeVersion(msg.id) + 1)} disabled={activeVersion(msg.id) >= versionCount(msg.id) - 1} aria-label={t("chat.nextVersion")} className="flex h-5 w-5 items-center justify-center rounded hover:bg-hover disabled:opacity-30">
                              <ChevronRight className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                        <button type="button" onClick={() => copyMessage(msg)} title={t("chat.copy")} aria-label={t("chat.copy")} className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-text">
                          {copiedMessageId === msg.id ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                        </button>
                        {features.messageEditing && (
                          <button type="button" onClick={() => startEditing(msg)} disabled={sending} title={t("chat.edit")} aria-label={t("chat.edit")} className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-text disabled:opacity-40">
                            <Pencil className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div key={msg.id} className="group message-item animate-fade-in-up">
                      <div className="space-y-2">
                        {groupParts(msg.parts as unknown as import('@ergatai/platform-core').UnifiedMessagePart[]).map((item, i) => {
                          if ("parts" in item) return <ToolGroupBlock key={i} group={item} />;
                          if ((item as unknown as { type: string }).type === "step-start") return null;
                          if (isReasoningPart(item)) return <ReasoningBlock key={i} text={(item as unknown as { text: string }).text} />;
                          if (isTextPart(item)) return <MarkdownContent key={i} content={item.text} className="text-[14px] leading-[1.7] text-text" />;
                          return null;
                        })}
                      </div>
                      <div className="mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                        {features.branching && versionCount(msg.id) > 1 && (
                          <div className="mr-1 flex items-center gap-0.5 rounded-md bg-surface px-1 text-[10px] text-muted">
                            <button type="button" onClick={() => switchBranch(msg.id, activeVersion(msg.id) - 1)} disabled={activeVersion(msg.id) === 0} aria-label={t("chat.previousVersion")} className="flex h-5 w-5 items-center justify-center rounded hover:bg-hover disabled:opacity-30">
                              <ChevronLeft className="h-3 w-3" />
                            </button>
                            <span>{activeVersion(msg.id) + 1}/{versionCount(msg.id)}</span>
                            <button type="button" onClick={() => switchBranch(msg.id, activeVersion(msg.id) + 1)} disabled={activeVersion(msg.id) >= versionCount(msg.id) - 1} aria-label={t("chat.nextVersion")} className="flex h-5 w-5 items-center justify-center rounded hover:bg-hover disabled:opacity-30">
                              <ChevronRight className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                        <button type="button" onClick={() => copyMessage(msg)} title={t("chat.copy")} aria-label={t("chat.copy")} className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-text">
                          {copiedMessageId === msg.id ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                        </button>
                        {features.reactions && (
                          <>
                            <button
                              type="button"
                              onClick={() => toggleFeedback(msg.id, "up")}
                              title={t("chat.like")}
                              aria-label={t("chat.like")}
                              className={cn("flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover", feedback[msg.id] === "up" ? "text-success" : "text-faint hover:text-text")}
                            >
                              <ThumbsUp className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleFeedback(msg.id, "down")}
                              title={t("chat.dislike")}
                              aria-label={t("chat.dislike")}
                              className={cn("flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover", feedback[msg.id] === "down" ? "text-danger" : "text-faint hover:text-text")}
                            >
                              <ThumbsDown className="h-3 w-3" />
                            </button>
                          </>
                        )}
                        {features.regeneration && (
                          <button type="button" onClick={() => regenerateMessage(msg.id)} disabled={sending} title={t("chat.regenerate")} aria-label={t("chat.regenerate")} className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-text disabled:opacity-40">
                            <RotateCcw className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  ),
                )}
                {sending && (
                  <div className="animate-fade-in-up">
                    <div className="flex items-center gap-2 py-1">
                      <div className="flex gap-1.5 items-center">
                        <span className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce [animation-delay:0ms]" />
                        <span className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce [animation-delay:150ms]" />
                        <span className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce [animation-delay:300ms]" />
                      </div>
                    </div>
                  </div>
                )}
                <div aria-live="polite" className="sr-only">{sending ? t("chat.agentStreaming") : status}</div>
                {error && (
                  <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger animate-fade-in">
                    <CircleX className="h-4 w-4 shrink-0" />
                    <span className="flex-1">{error.message}</span>
                    <button onClick={() => { clearError(); regenerate(); }} className="text-xs text-accent hover:underline">{t("chat.retry")}</button>
                    <button onClick={clearError} className="text-xs text-muted hover:text-text transition-colors duration-150">{t("common.close")}</button>
                  </div>
                )}
                {attachmentError && (
                  <div className="flex items-center justify-between rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-[12px] text-danger">
                    <span>{attachmentError}</span>
                    <button type="button" onClick={clearAttachmentError} aria-label={t("common.close")}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
            </div>
            {features.scrollNavigation && messageAnchors.length > 0 && (
              <div className="group/navigation absolute right-2.5 top-1/2 z-20 flex -translate-y-1/2 items-center">
                <div className="absolute right-full top-0 h-full w-2" />
                <div className="flex max-h-64 flex-col items-center justify-center gap-1.5 overflow-y-auto rounded-full border border-border-subtle bg-surface/80 px-1 py-1.5 shadow-sm backdrop-blur">
                  {messageAnchors.map((anchor) => (
                    <button
                      key={anchor.id}
                      type="button"
                      onClick={() => jumpToMessage(anchor.id)}
                      title={anchor.text || t("chat.imageMessage")}
                      aria-label={anchor.text || t("chat.imageMessage")}
                      className="flex h-3 w-4 items-center justify-center rounded-sm"
                    >
                      <span
                        className={cn(
                          "h-px w-3 transition-colors duration-150",
                          activeMessageId === anchor.id ? "bg-text" : "bg-border group-hover/navigation:bg-muted",
                        )}
                      />
                    </button>
                  ))}
                </div>
                <div className="absolute right-full top-1/2 mr-2 hidden max-h-80 w-72 -translate-y-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-xl group-hover/navigation:block group-focus-within/navigation:block">
                  <div className="max-h-80 overflow-y-auto py-1">
                    {messageAnchors.map((anchor) => (
                      <button
                        key={anchor.id}
                        type="button"
                        onClick={() => jumpToMessage(anchor.id)}
                        className={cn(
                          "block w-full truncate px-3 py-1.5 text-left text-[12px] transition-colors duration-150",
                          activeMessageId === anchor.id ? "bg-hover font-medium text-text" : "text-muted hover:bg-hover hover:text-text",
                        )}
                      >
                        {anchor.text || t("chat.imageMessage")}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="shrink-0 px-6 pb-5">
            <div className="relative max-w-[680px] mx-auto">
              {pendingApproval && (
                <div
                  role="alert"
                  className="mb-3 flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 shadow-md animate-fade-in"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-muted text-accent">
                    <Shield className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-medium leading-tight text-text">{t("chat.pendingApproval")}</p>
                    <p className="mt-0.5 truncate text-[11px] leading-tight text-muted">
                      <span className="font-mono text-text/80">{pendingApproval.toolName}</span>
                      {pendingApproval.reason ? ` · ${pendingApproval.reason}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => respondToApproval(pendingApproval.id, true)}
                      className="h-7 rounded-lg bg-accent px-3 text-[12px] font-medium text-white transition-colors hover:bg-accent-hover"
                    >
                      {t("chat.approve")}
                    </button>
                    <button
                      type="button"
                      onClick={() => respondToApproval(pendingApproval.id, false)}
                      className="h-7 rounded-lg border border-border px-3 text-[12px] text-muted transition-colors hover:bg-hover hover:text-text"
                    >
                      {t("chat.deny")}
                    </button>
                  </div>
                </div>
              )}
              {!isAwayFromBottom ? null : (
                <div className={cn(
                  "absolute bottom-full left-1/2 z-10 mb-3 -translate-x-1/2 rounded-full",
                  sending && "stream-glow",
                )}>
                  <button
                    type="button"
                    onClick={scrollToBottom}
                    title={t("chat.scrollToBottom")}
                    aria-label={t("chat.scrollToBottom")}
                    className="relative z-[1] flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-lg backdrop-blur transition-colors duration-150 hover:text-text"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                </div>
              )}
              <ChatComposer
                textareaRef={textareaRef}
                fileInputRef={fileInputRef}
                permissionRef={permissionRef}
                attachments={attachments}
                permission={permission}
                permissionOpen={permissionOpen}
                sending={sending}
                supportsFormSubmit
                workspaces={workspaces}
                selectedWorkspaceId={selectedWorkspaceId}
                onWorkspaceSelect={setSelectedWorkspaceId}
                onRemoveAttachment={(id) => setAttachments((current) => current.filter((file) => file.id !== id))}
                onPermissionChange={setPermission}
                onPermissionOpenChange={setPermissionOpen}
                onStop={handleStop}
                onSubmit={handleSubmit}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onInput={(event) => autoResize(event.currentTarget)}
                onFileSelect={handleFileSelect}
              />
            </div>
          </div>
        </>
      )}

      {lightboxUrl && features.lightbox && (
        <ChatLightbox
          url={lightboxUrl}
          scale={lightboxScale}
          onClose={() => setLightboxUrl(null)}
          onScaleChange={setLightboxScale}
        />
      )}
    </div>
  );
}

// ─── conversationStore backed path ───────────────────────────────────────────

function StoreBackedChatPanel({
  mode,
  features,
  conversationStore,
  agentName,
  agentId,
  participantIds,
  headerLeading,
  onMentionSelect,
  onTaskClick,
  onApprovalAction,
  className,
  maxHeight,
}: ChatPanelProps & { features: ChatPanelFeatures }) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const permissionRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [isAwayFromBottom, setIsAwayFromBottom] = useState(false);
  const [permission, setPermission] = useState<PermissionMode>("manual");
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [lightboxScale, setLightboxScale] = useState(1);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, MessageFeedback>>({});
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const messageAnchorRefs = useRef(new Map<string, HTMLElement>());

  const { messages, sendMessage: storeSendMessage, editMessage: storeEditMessage } = useConversationStoreChatState(conversationStore!);

  const sending = false; // conversationStore doesn't track sending state yet
  const isEmpty = messages.length === 0;
  const displayName = agentName ?? agentId;

  // Auto-scroll
  useEffect(() => {
    if (isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Lightbox keyboard handler
  useEffect(() => {
    if (!lightboxUrl) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setLightboxUrl(null);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [lightboxUrl]);

  // Permission dropdown outside click
  const closePermission = useCallback((e: MouseEvent) => {
    if (permissionRef.current && !permissionRef.current.contains(e.target as Node)) {
      setPermissionOpen(false);
    }
  }, []);

  useEffect(() => {
    if (!permissionOpen) return;
    document.addEventListener("mousedown", closePermission);
    return () => document.removeEventListener("mousedown", closePermission);
  }, [permissionOpen, closePermission]);

  // Message anchors for scroll navigation
  const messageAnchors = useMemo(() => {
    if (!features.scrollNavigation) return [];
    return messages
      .filter((msg) => msg.role === "user")
      .map((msg) => ({
        id: msg.id,
        text: msg.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { content?: string }).content ?? "")
          .join("\n\n"),
      }));
  }, [messages, features.scrollNavigation]);

  // ─── Handlers ────────────────────────────────────────────────────────────

  function handleScroll() {
    const el = scrollContainerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    isAtBottomRef.current = isAtBottom;
    setIsAwayFromBottom(!isAtBottom);
    updateActiveMessage();
  }

  function scrollToBottom() {
    isAtBottomRef.current = true;
    setIsAwayFromBottom(false);
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  async function copyMessage(message: typeof messages[number]) {
    const text = message.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { content?: string }).content ?? "")
      .join("\n\n");
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopiedMessageId(message.id);
    window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? null : current), 1600);
  }

  function startEditing(message: typeof messages[number]) {
    if (!features.messageEditing) return;
    setEditingMessageId(message.id);
    setEditingText(
      message.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { content?: string }).content ?? "")
        .join("\n\n"),
    );
  }

  function cancelEditing() {
    setEditingMessageId(null);
    setEditingText("");
  }

  function submitEditing(message: typeof messages[number]) {
    const text = editingText.trim();
    if (!text || sending) return;
    if (storeEditMessage) {
      void storeEditMessage(message.id, text);
    }
    cancelEditing();
  }

  function toggleFeedback(messageId: string, value: MessageFeedback) {
    if (!features.reactions) return;
    setFeedback((current) => {
      const next = { ...current };
      if (next[messageId] === value) {
        delete next[messageId];
      } else {
        next[messageId] = value;
      }
      return next;
    });
  }

  function updateActiveMessage() {
    const container = scrollContainerRef.current;
    if (!container) return;
    const threshold = container.getBoundingClientRect().top + container.clientHeight * 0.32;
    let currentId: string | null = null;
    for (const anchor of messageAnchors) {
      const element = messageAnchorRefs.current.get(anchor.id);
      if (element && element.getBoundingClientRect().top <= threshold) currentId = anchor.id;
    }
    setActiveMessageId(currentId);
  }

  function jumpToMessage(messageId: string) {
    const container = scrollContainerRef.current;
    const element = messageAnchorRefs.current.get(messageId);
    if (!container || !element) return;
    container.scrollTo({ top: Math.max(0, element.offsetTop - 28), behavior: "smooth" });
    setActiveMessageId(messageId);
    setHighlightedMessageId(messageId);
    window.setTimeout(() => {
      setHighlightedMessageId((current) => current === messageId ? null : current);
    }, 1500);
  }

  function submitInput() {
    const el = textareaRef.current;
    if (!el) return;
    const val = el.value.trim();
    if (!val) return;
    void storeSendMessage(val);
    el.value = "";
    el.style.height = "";
    setAttachments([]);
  }

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  async function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    if (!features.attachments) return;
    const files = e.target.files;
    if (!files) return;
    const selected = Array.from(files);
    const remaining = maxAttachmentCount - attachments.length;
    if (remaining <= 0) {
      setAttachmentError(t("chat.tooManyFiles", { count: maxAttachmentCount }));
      e.target.value = "";
      return;
    }
    const accepted = selected.slice(0, remaining);
    if (selected.length > remaining) setAttachmentError(t("chat.tooManyFiles", { count: maxAttachmentCount }));
    if (accepted.some((file) => file.size > maxAttachmentSize)) {
      setAttachmentError(t("chat.fileTooLarge", { size: 10 }));
      e.target.value = "";
      return;
    }
    try {
      const newFiles: AttachedFile[] = await Promise.all(accepted.map(async (file, index) => ({
        id: `f-${Date.now()}-${index}-${file.name}`,
        name: file.name,
        size: file.size,
        type: file.type,
        previewUrl: await fileToDataUrl(file),
      })));
      setAttachmentError(null);
      setAttachments((prev) => [...prev, ...newFiles]);
    } catch {
      setAttachmentError(t("chat.fileReadFailed"));
    }
    e.target.value = "";
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!features.attachments) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const images: { id: string; name: string; size: number; type: string; file: File }[] = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          images.push({
            id: `img-${Date.now()}-${file.name ?? "pasted"}`,
            name: file.name ?? `pasted-image.${item.type.split("/")[1]}`,
            size: file.size,
            type: file.type,
            file,
          });
        }
      }
    }
    if (images.length > 0) {
      e.preventDefault();
      const remaining = maxAttachmentCount - attachments.length;
      const accepted = images.slice(0, Math.max(0, remaining));
      if (images.length > remaining) setAttachmentError(t("chat.tooManyFiles", { count: maxAttachmentCount }));
      if (accepted.some(({ file }) => file.size > maxAttachmentSize)) {
        setAttachmentError(t("chat.fileTooLarge", { size: 10 }));
        return;
      }
      void (async () => {
        try {
          const hydrated: AttachedFile[] = await Promise.all(accepted.map(async ({ file, ...metadata }) => ({
            ...metadata,
            previewUrl: await fileToDataUrl(file),
          })));
          setAttachmentError(null);
          setAttachments((prev) => [...prev, ...hydrated]);
        } catch {
          setAttachmentError(t("chat.fileReadFailed"));
        }
      })();
    }
  }

  function clearAttachmentError() {
    setAttachmentError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitInput();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitInput();
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div
      className={cn("relative flex h-full min-h-0 flex-col overflow-hidden bg-chat", className)}
      style={maxHeight ? { maxHeight } : undefined}
    >
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border-subtle bg-surface px-5">
        {headerLeading}
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
          {mode === "group" ? "👥" : "💬"}
        </div>
        <div>
          <h2 className="text-sm font-medium text-text">
            {conversationStore?.conversation?.title ?? t("chat.title")}
          </h2>
          <p className="text-xs text-muted">
            {mode === "group"
              ? `${participantIds?.length ?? 0} participants`
              : displayName ?? "Direct chat"}
          </p>
        </div>
      </header>

      {/* Message List */}
      <div className="relative flex min-h-0 flex-1">
        <div ref={scrollContainerRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {isEmpty ? (
            <div className="flex h-full items-center justify-center py-12">
              <div className="text-center">
                <div className="mb-4 text-4xl">💬</div>
                <h3 className="mb-2 text-lg font-medium text-text">{t("chat.empty")}</h3>
                <p className="text-sm text-muted">{t("chat.emptyHint")}</p>
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-[680px] px-6 pt-8 pb-4 space-y-5">
              {messages.map((message) => (
                <div
                  key={message.id}
                  ref={message.role === "user" ? (element) => {
                    if (element) messageAnchorRefs.current.set(message.id, element);
                    else messageAnchorRefs.current.delete(message.id);
                  } : undefined}
                  className={cn(
                    "group message-item animate-fade-in-up",
                    message.role === "user" ? "flex flex-col items-end" : "",
                    highlightedMessageId === message.id && "opacity-100",
                  )}
                >
                  {editingMessageId === message.id ? (
                    <div className="w-full max-w-[85%] rounded-2xl border border-accent/50 bg-surface px-3 py-2.5 shadow-sm">
                      <textarea
                        value={editingText}
                        onChange={(event) => setEditingText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            submitEditing(message);
                          }
                          if (event.key === "Escape") cancelEditing();
                        }}
                        autoFocus
                        className="min-h-[64px] w-full resize-none bg-transparent text-[14px] leading-relaxed text-text focus:outline-none"
                      />
                      <div className="mt-2 flex justify-end gap-1.5">
                        <button type="button" onClick={cancelEditing} className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-text">
                          {t("chat.cancel")}
                        </button>
                        <button
                          type="button"
                          onClick={() => submitEditing(message)}
                          disabled={!editingText.trim() || sending}
                          className="rounded-md bg-text px-2 py-1 text-[11px] font-medium text-bg disabled:opacity-40"
                        >
                          {t("chat.resubmit")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className={cn(
                      "flex gap-3",
                      message.role === "user" ? "flex-row-reverse" : "",
                    )}>
                      {/* Avatar */}
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                        {message.role === "user" ? "U" : "A"}
                      </div>

                      {/* Message Content */}
                      <div className={cn(
                        "min-w-0 max-w-[min(760px,88%)]",
                        message.role === "user"
                          ? "rounded-2xl rounded-br-md bg-bubble px-4 py-2.5 text-[14px] leading-relaxed"
                          : "",
                      )}>
                        {/* Header */}
                        <div className={cn(
                          "mb-1 flex items-center gap-2 text-xs text-muted",
                          message.role === "user" ? "justify-end" : "",
                        )}>
                          <span className="font-medium text-text">
                            {message.role === "user" ? "You" : "Assistant"}
                          </span>
                          <span>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
                        </div>

                        {/* Parts */}
                        <div className={cn("space-y-2 text-left", message.role === "user" && "space-y-0")}>
                          {message.parts.map((part, index) => (
                            <PartRenderer
                              key={`${message.id}-${index}`}
                              part={part}
                              features={features}
                              onMentionClick={onMentionSelect}
                              onTaskClick={onTaskClick}
                              onApprovalAction={onApprovalAction}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Action bar */}
                  <div className={cn(
                    "mt-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100",
                    message.role === "user" ? "justify-end" : "",
                  )}>
                    <button type="button" onClick={() => copyMessage(message)} title={t("chat.copy")} aria-label={t("chat.copy")} className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-text">
                      {copiedMessageId === message.id ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                    </button>
                    {features.messageEditing && message.role === "user" && (
                      <button type="button" onClick={() => startEditing(message)} disabled={sending} title={t("chat.edit")} aria-label={t("chat.edit")} className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-text disabled:opacity-40">
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                    {features.reactions && message.role === "assistant" && (
                      <>
                        <button
                          type="button"
                          onClick={() => toggleFeedback(message.id, "up")}
                          title={t("chat.like")}
                          aria-label={t("chat.like")}
                          className={cn("flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover", feedback[message.id] === "up" ? "text-success" : "text-faint hover:text-text")}
                        >
                          <ThumbsUp className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleFeedback(message.id, "down")}
                          title={t("chat.dislike")}
                          aria-label={t("chat.dislike")}
                          className={cn("flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover", feedback[message.id] === "down" ? "text-danger" : "text-faint hover:text-text")}
                        >
                          <ThumbsDown className="h-3 w-3" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* Scroll navigation sidebar */}
        {features.scrollNavigation && messageAnchors.length > 0 && (
          <div className="group/navigation absolute right-2.5 top-1/2 z-20 flex -translate-y-1/2 items-center">
            <div className="absolute right-full top-0 h-full w-2" />
            <div className="flex max-h-64 flex-col items-center justify-center gap-1.5 overflow-y-auto rounded-full border border-border-subtle bg-surface/80 px-1 py-1.5 shadow-sm backdrop-blur">
              {messageAnchors.map((anchor) => (
                <button
                  key={anchor.id}
                  type="button"
                  onClick={() => jumpToMessage(anchor.id)}
                  title={anchor.text || t("chat.imageMessage")}
                  aria-label={anchor.text || t("chat.imageMessage")}
                  className="flex h-3 w-4 items-center justify-center rounded-sm"
                >
                  <span
                    className={cn(
                      "h-px w-3 transition-colors duration-150",
                      activeMessageId === anchor.id ? "bg-text" : "bg-border group-hover/navigation:bg-muted",
                    )}
                  />
                </button>
              ))}
            </div>
            <div className="absolute right-full top-1/2 mr-2 hidden max-h-80 w-72 -translate-y-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-xl group-hover/navigation:block group-focus-within/navigation:block">
              <div className="max-h-80 overflow-y-auto py-1">
                {messageAnchors.map((anchor) => (
                  <button
                    key={anchor.id}
                    type="button"
                    onClick={() => jumpToMessage(anchor.id)}
                    className={cn(
                      "block w-full truncate px-3 py-1.5 text-left text-[12px] transition-colors duration-150",
                      activeMessageId === anchor.id ? "bg-hover font-medium text-text" : "text-muted hover:bg-hover hover:text-text",
                    )}
                  >
                    {anchor.text || t("chat.imageMessage")}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Scroll-to-bottom button */}
      {!isAwayFromBottom ? null : (
        <div className="absolute bottom-24 left-1/2 z-10 -translate-x-1/2 rounded-full">
          <button
            type="button"
            onClick={scrollToBottom}
            title={t("chat.scrollToBottom")}
            aria-label={t("chat.scrollToBottom")}
            className="relative z-[1] flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-lg backdrop-blur transition-colors duration-150 hover:text-text"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Composer */}
      <div className="shrink-0 px-6 pb-5">
        <div className="relative max-w-[680px] mx-auto">
          {attachmentError && (
            <div className="mb-2 flex items-center justify-between rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-[12px] text-danger">
              <span>{attachmentError}</span>
              <button type="button" onClick={clearAttachmentError} aria-label={t("common.close")}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <ChatComposer
            textareaRef={textareaRef}
            fileInputRef={fileInputRef}
            permissionRef={permissionRef}
            attachments={attachments}
            permission={permission}
            permissionOpen={permissionOpen}
            sending={sending}
            supportsFormSubmit
            onRemoveAttachment={(id) => setAttachments((current) => current.filter((file) => file.id !== id))}
            onPermissionChange={setPermission}
            onPermissionOpenChange={setPermissionOpen}
            onSubmit={handleSubmit}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onInput={(event) => autoResize(event.currentTarget)}
            onFileSelect={handleFileSelect}
          />
        </div>
      </div>

      {/* Lightbox */}
      {lightboxUrl && features.lightbox && (
        <ChatLightbox
          url={lightboxUrl}
          scale={lightboxScale}
          onClose={() => setLightboxUrl(null)}
          onScaleChange={setLightboxScale}
        />
      )}
    </div>
  );
}
