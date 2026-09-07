import { useTranslation } from "react-i18next";
import type { ChangeEvent, FormEvent, KeyboardEvent, ClipboardEvent, RefObject } from "react";
import { ArrowUp, FolderOpen, GitBranch, Plus, Shield, Square } from "lucide-react";
import { cn } from "../../lib/utils";
import { AttachmentCard } from "./message-blocks";
import { permissionModes, type AttachedFile, type PermissionMode } from "./types";

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
  const activePermission = permissionModes.find((mode) => mode.value === permission);

  return (
    <form
      onSubmit={supportsFormSubmit ? onSubmit : undefined}
      className="rounded-2xl border border-border bg-surface shadow-sm"
    >
      <div className="flex h-9 items-center gap-2 border-b border-border-subtle px-2.5">
        <button
          type="button"
          className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted transition-colors hover:bg-hover hover:text-text"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {t("composer.workspace")}
        </button>
        <button
          type="button"
          className="ml-auto flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted transition-colors hover:bg-hover hover:text-text"
        >
          <GitBranch className="h-3.5 w-3.5" />
          {t("composer.branch")}
        </button>
      </div>
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
        <div className="flex-1" />
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
