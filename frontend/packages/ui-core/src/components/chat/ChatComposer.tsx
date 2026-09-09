import { useTranslation } from "react-i18next";
import type { ChangeEvent, FormEvent, KeyboardEvent, ClipboardEvent, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, FolderOpen, Plus, Shield, Square, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";
import { AttachmentCard } from "./message-blocks";
import { permissionModes, type AttachedFile, type PermissionMode } from "./types";
import type { WorkspaceInfo } from "@ergatai/platform-core";

interface ChatComposerProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  permissionRef: RefObject<HTMLDivElement | null>;
  attachments: AttachedFile[];
  permission: PermissionMode;
  permissionOpen: boolean;
  sending: boolean;
  autoFocus?: boolean;
  supportsFormSubmit?: boolean;
  workspaces?: WorkspaceInfo[];
  selectedWorkspaceId?: string | null;
  onWorkspaceSelect?: (workspaceId: string) => void;
  onRemoveAttachment: (id: string) => void;
  onPermissionChange: (permission: PermissionMode) => void;
  onPermissionOpenChange: (open: boolean) => void;
  onStop?: () => void;
  onSend?: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onInput?: (event: FormEvent<HTMLTextAreaElement>) => void;
  onFileSelect?: (event: ChangeEvent<HTMLInputElement>) => void;
}

export function ChatComposer({
  textareaRef,
  fileInputRef,
  permissionRef,
  attachments,
  permission,
  permissionOpen,
  sending,
  autoFocus,
  supportsFormSubmit,
  selectedWorkspaceId,
  onWorkspaceSelect,
  onRemoveAttachment,
  onPermissionChange,
  onPermissionOpenChange,
  onStop,
  onSend,
  onSubmit,
  onKeyDown,
  onPaste,
  onInput,
  onFileSelect,
}: ChatComposerProps) {
  const { t } = useTranslation();
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState("");
  const [browseEntries, setBrowseEntries] = useState<string[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const activePermission = permissionModes.find((mode) => mode.value === permission);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (workspaceRef.current && !workspaceRef.current.contains(e.target as Node)) setWorkspaceOpen(false);
      if (permissionRef.current && !permissionRef.current.contains(e.target as Node)) onPermissionOpenChange(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const listDirectories = (path: string) => {
    setBrowseLoading(true);
    void fetch(`/api/fs?path=${encodeURIComponent(path)}`)
      .then((res) => res.ok ? res.json() : Promise.reject(new Error("Failed to list")))
      .then((data: { path: string; directories: string[] }) => {
        setBrowsePath(data.path);
        setBrowseEntries(data.directories);
      })
      .catch(() => setBrowseEntries([]))
      .finally(() => setBrowseLoading(false));
  };

  const openFolderBrowser = () => {
    setWorkspaceOpen(true);
    listDirectories(browsePath || "~");
  };

  const navigateTo = (path: string) => {
    listDirectories(path);
  };

  const confirmSelection = () => {
    onWorkspaceSelect?.(browsePath);
    setWorkspaceOpen(false);
  };

  return (
    <form
      onSubmit={supportsFormSubmit ? onSubmit : undefined}
      className="rounded-2xl border border-border bg-surface shadow-sm"
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attachments.map((file) => (
            <AttachmentCard
              key={file.id}
              file={file}
              onRemove={() => onRemoveAttachment(file.id)}
            />
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onInput={onInput}
        placeholder={t("chat.placeholder")}
        rows={1}
        autoFocus={autoFocus}
        className="w-full bg-transparent px-4 pt-3 pb-1 text-[14px] text-text placeholder:text-faint resize-none focus:outline-none leading-relaxed min-h-[40px] max-h-[200px]"
      />
      <div className="flex items-center gap-0.5 px-2.5 pb-2.5">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-text transition-colors duration-150"
        >
          <Plus className="h-4 w-4" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={onFileSelect}
          className="hidden"
        />
        {(
          <div className="relative" ref={workspaceRef}>
            <button
              type="button"
              onClick={() => { if (workspaceOpen) { setWorkspaceOpen(false); } else { openFolderBrowser(); } }}
              className="flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] text-muted transition-colors hover:bg-hover hover:text-text"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              <span className="max-w-28 truncate">{selectedWorkspaceId ?? browsePath ?? t("composer.workspace")}</span>
              <ChevronDown className="h-3 w-3 opacity-50" />
            </button>
            {workspaceOpen && (
              <div className="absolute bottom-full left-0 z-20 mb-1.5 w-72 rounded-lg border border-border bg-surface shadow-lg animate-fade-in overflow-hidden">
                <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => navigateTo(browsePath.replace(/\/[^/]+\/?$/, "") || "/")}
                    disabled={browsePath === "/"}
                    className={cn("h-5 w-5 flex items-center justify-center rounded text-[11px]", browsePath === "/" ? "text-faint" : "text-muted hover:bg-hover hover:text-text")}
                  >
                    ←
                  </button>
                  <input
                    value={browsePath}
                    onChange={(e) => setBrowsePath(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); navigateTo(browsePath); } }}
                    className="flex-1 bg-transparent text-[12px] text-text placeholder:text-faint focus:outline-none"
                    placeholder="/path/to/folder"
                  />
                </div>
                <div className="max-h-48 overflow-y-auto py-0.5">
                  {browseLoading ? (
                    <p className="px-3 py-2 text-[12px] text-faint">加载中…</p>
                  ) : browseEntries.length === 0 ? (
                    <p className="px-3 py-2 text-[12px] text-faint">无子目录</p>
                  ) : (
                    browseEntries.map((entry) => (
                      <button
                        key={entry}
                        type="button"
                        onClick={() => navigateTo(`${browsePath.replace(/\/$/, "")}/${entry}`)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-muted transition-colors hover:bg-hover hover:text-text"
                      >
                        <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate text-left">{entry}</span>
                      </button>
                    ))
                  )}
                </div>
                <div className="border-t border-border px-2 py-1.5">
                  <button
                    type="button"
                    onClick={confirmSelection}
                    className="w-full rounded-md bg-accent px-2 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-hover"
                  >
                    选择此文件夹
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        <div className="flex-1" />
        <div className="relative" ref={permissionRef}>
          <button
            type="button"
            onClick={() => onPermissionOpenChange(!permissionOpen)}
            className={cn(
              "flex items-center gap-1 h-7 rounded-lg px-2 text-[12px] transition-colors duration-150",
              permission === "full"
                ? "text-danger hover:bg-hover"
                : "text-muted hover:bg-hover hover:text-text",
            )}
          >
            <Shield className="h-3.5 w-3.5" />
            {activePermission ? t(activePermission.labelKey) : ""}
          </button>
          {permissionOpen && (
            <div className="absolute bottom-full right-0 mb-1.5 rounded-lg border border-border bg-surface shadow-lg py-1 w-28 animate-fade-in z-10">
              {permissionModes.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  onClick={() => {
                    onPermissionChange(mode.value);
                    onPermissionOpenChange(false);
                  }}
                  className={cn(
                    "flex w-full items-center px-3 py-1.5 text-[12px] transition-colors duration-150",
                    permission === mode.value
                      ? "text-accent font-medium"
                      : "text-muted hover:bg-hover hover:text-text",
                  )}
                >
                  {t(mode.labelKey)}
                </button>
              ))}
            </div>
          )}
        </div>
        {sending ? (
          <button
            type="button"
            onClick={onStop}
            className="ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-danger text-white hover:opacity-85 transition-all duration-150"
          >
            <Square className="h-3 w-3 fill-current" />
          </button>
        ) : supportsFormSubmit ? (
          <button
            type="submit"
            className="ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-text text-bg hover:opacity-80 transition-all duration-150"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            className="ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-text text-bg hover:opacity-80 transition-all duration-150"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </form>
  );
}
