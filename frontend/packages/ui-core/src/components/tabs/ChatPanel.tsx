import { useEffect, useRef, useState, type ChangeEvent, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useChat } from "@ai-sdk/react";
import type { UIMessage, FileUIPart } from "ai";
import {
  ArrowDown,
  Shield,
  X,
  CircleX,
  FilePlus,
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
import { chatTransport } from "@ergatai/platform-core";
import { clearChatMessages, loadChatMessages, saveChatMessages } from "@ergatai/platform-core";
import {
  ChatLightbox,
  ReasoningBlock,
  ToolGroupBlock,
  UserFileCard,
} from "../chat/message-blocks";
import {
  maxAttachmentCount,
  maxAttachmentSize,
  type AttachedFile,
  type MessageFeedback,
  type PermissionMode,
} from "../chat/types";
import { ChatComposer } from "../chat/ChatComposer";
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
} from "../chat/utils";


export function ChatPanel({ agentName, conversationId }: { agentName?: string; conversationId?: string }) {
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
  const [branches, setBranches] = useState<Record<string, UIMessage[][]>>({});
  const [activeBranches, setActiveBranches] = useState<Record<string, number>>({});
  const messageAnchorRefs = useRef(new Map<string, HTMLElement>());
  const [hydratedConversationId, setHydratedConversationId] = useState<string | null>(null);
  const activeConversationId = conversationId ?? "default";
  const chatHydrated = hydratedConversationId === activeConversationId;
  const { messages, sendMessage, setMessages, status, stop, regenerate, error, clearError, addToolApprovalResponse } = useChat({
    id: conversationId ?? "default",
    transport: chatTransport,
    sendAutomaticallyWhen: ({ messages: currentMessages }) => {
      const lastMessage = currentMessages[currentMessages.length - 1];
      const parts = lastMessage?.parts ?? [];
      return parts.some((part) => (part as Record<string, unknown>).state === "approval-responded");
    },
  });

  const sending = status === "submitted" || status === "streaming";
  const isEmpty = messages.length === 0 && !sending;
  const messageAnchors = useMemo(() => userMessageAnchors(messages), [messages]);
  const pendingApproval = findPendingApproval(messages);

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

    return () => {
      cancelled = true;
    };
  }, [activeConversationId, setMessages, t]);

  useEffect(() => {
    if (sending || !chatHydrated) return;
    void saveChatMessages(activeConversationId, messages).catch(() => {
      setAttachmentError(t("chat.storageFailed"));
    });
  }, [activeConversationId, chatHydrated, messages, sending, t]);

  useEffect(() => {
    if (isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, sending]);

  useEffect(() => {
    if (!lightboxUrl) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setLightboxUrl(null);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [lightboxUrl]);

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

  function send(text: string) {
    if (!text.trim() || sending) return;
    sendMessage({ text: text.trim() }, { body: { permission } });
  }

  function handleStop() {
    stop();
  }

  function regenerateMessage(messageId: string) {
    if (sending) return;
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

  function startNewConversation() {
    if (sending) return;
    stop();
    setMessages([]);
    setBranches({});
    setActiveBranches({});
    setFeedback({});
    void clearChatMessages(activeConversationId).catch(() => {
      setAttachmentError(t("chat.storageFailed"));
    });
  }

  function toggleFeedback(messageId: string, value: MessageFeedback) {
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

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-chat">
      <button
        type="button"
        onClick={startNewConversation}
        disabled={isEmpty && messages.length === 0}
        className="absolute right-4 top-10 z-30 flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-[12px] text-muted shadow-sm transition-colors hover:text-text disabled:opacity-40"
      >
        <FilePlus className="h-3.5 w-3.5" />
        {t("sidebar.newChat")}
      </button>
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
                        {msg.parts.map((part, i) => {
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
	                      {versionCount(msg.id) > 1 && (
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
                      <button type="button" onClick={() => startEditing(msg)} disabled={sending} title={t("chat.edit")} aria-label={t("chat.edit")} className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-text disabled:opacity-40">
                        <Pencil className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div key={msg.id} className="group message-item animate-fade-in-up">
                    <div className="space-y-2">
                      {groupParts(msg.parts).map((item, i) => {
                        if ("parts" in item) return <ToolGroupBlock key={i} group={item} />;
                        if (item.type === "step-start") return null;
                        if (isReasoningPart(item)) return <ReasoningBlock key={i} text={item.text} />;
                        if (isTextPart(item)) return <MarkdownContent key={i} content={item.text} className="text-[14px] leading-[1.7] text-text" />;
                        return null;
                      })}
                    </div>
	                    <div className="mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
	                      {versionCount(msg.id) > 1 && (
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
                      <button type="button" onClick={() => regenerateMessage(msg.id)} disabled={sending} title={t("chat.regenerate")} aria-label={t("chat.regenerate")} className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-text disabled:opacity-40">
                        <RotateCcw className="h-3 w-3" />
                      </button>
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
            {messageAnchors.length > 0 && (
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

      {lightboxUrl && (
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
