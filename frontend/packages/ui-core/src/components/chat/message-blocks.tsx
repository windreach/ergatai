import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileUIPart } from "ai";
import {
  Brain,
  ChevronDown,
  CircleCheck,
  CircleX,
  FileIcon,
  Loader,
  Shield,
  X,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import type { AttachedFile, ChatPart, ToolGroup } from "./types";

export function ReasoningBlock({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-[12px] text-muted hover:text-text transition-colors duration-150">
        <Brain className="h-3.5 w-3.5" />
        <span>{t("chat.reasoning")}</span>
        <ChevronDown className="h-3 w-3 transition-transform duration-150 group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 ml-5 pl-3 border-l-2 border-border text-[13px] text-muted leading-relaxed italic">
          {text}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ToolStateIcon({ state }: { state: string }) {
  if (state === "output-available") return <CircleCheck className="h-3.5 w-3.5 text-success shrink-0" />;
  if (state === "output-error") return <CircleX className="h-3.5 w-3.5 text-danger shrink-0" />;
  if (state === "approval-requested" || state === "approval-responded") return <Shield className="h-3.5 w-3.5 text-warning shrink-0" />;
  return <Loader className="h-3.5 w-3.5 text-accent shrink-0 animate-spin" />;
}

export function UserFileCard({ part }: { part: FileUIPart }) {
  const { t } = useTranslation();
  const isImage = part.mediaType?.startsWith("image/");
  if (isImage) {
    return (
      <img
        src={part.url}
        alt={part.filename ?? "image"}
        onClick={() => window.open(part.url, "_blank", "noopener,noreferrer")}
        className="max-h-[220px] max-w-full cursor-zoom-in rounded-lg object-cover"
      />
    );
  }
  return (
    <a
      href={part.url}
      download={part.filename}
      className="flex min-w-44 items-center gap-2 rounded-lg bg-elevated px-2.5 py-2 text-[12px] text-text transition-colors hover:bg-hover"
    >
      <FileIcon className="h-4 w-4 shrink-0 text-muted" />
      <span className="truncate">{part.filename ?? t("chat.attachment")}</span>
    </a>
  );
}

export function AttachmentCard({ file, onRemove }: { file: AttachedFile; onRemove: () => void }) {
  const isImage = file.type.startsWith("image/") || !!file.previewUrl;

  return (
    <div className="relative rounded-lg border border-border bg-elevated overflow-hidden w-16">
      {isImage && file.previewUrl ? (
        <img src={file.previewUrl} alt={file.name} className="w-full h-14 object-cover rounded-t-lg" />
      ) : (
        <div className="w-full h-14 flex items-center justify-center bg-hover/50">
          <FileIcon className="h-6 w-6 text-muted" />
        </div>
      )}
      <div className="px-1.5 py-1">
        <p className="text-[10px] font-medium text-text truncate leading-tight">{file.name}</p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors duration-150"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

function ToolBlock({ part }: { part: ChatPart }) {
  const { t } = useTranslation();
  const [showDetails, setShowDetails] = useState(false);
  const toolName = part.type.replace("tool-", "");
  const state = (part as Record<string, unknown>).state as string ?? "input-streaming";
  const input = (part as Record<string, unknown>).input;
  const output = (part as Record<string, unknown>).output;
  const errorText = (part as Record<string, unknown>).errorText as string | undefined;
  const approval = (part as Record<string, unknown>).approval as { id?: string; approved?: boolean; requestReason?: string; reason?: string } | undefined;
  const stateLabel = state === "output-available"
    ? t("chat.toolDone")
    : state === "output-error"
      ? t("chat.toolError")
      : state === "approval-requested"
        ? t("chat.approvalRequested")
        : state === "approval-responded"
          ? (approval?.approved ? t("chat.approved") : t("chat.denied"))
          : t("chat.toolRunning");

  const inputSummary = input != null
    ? typeof input === "string"
      ? input
      : Object.entries(input as Record<string, unknown>).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join(", ")
    : "";

  return (
    <div className="rounded-lg bg-elevated/50 px-2.5 py-1.5 text-[12px] animate-fade-in min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <button type="button" onClick={() => setShowDetails((current) => !current)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ToolStateIcon state={state} />
          <span className="font-mono font-medium text-text shrink-0">{toolName}</span>
          {inputSummary && <span className="font-mono text-muted truncate min-w-0">{inputSummary}</span>}
          {errorText && <span className="text-danger text-[11px] truncate min-w-0">{errorText}</span>}
        </button>
        <span className="text-[10px] text-faint uppercase tracking-wide shrink-0">{stateLabel}</span>
      </div>
      {showDetails && (
        <div className="mt-2 space-y-2">
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wide text-faint">{t("chat.toolInput")}</p>
            <pre className="max-h-40 overflow-auto rounded-md bg-surface p-2 font-mono text-[11px] text-muted">{JSON.stringify(input ?? null, null, 2)}</pre>
          </div>
          {output != null && (
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wide text-faint">{t("chat.toolOutput")}</p>
              <pre className="max-h-52 overflow-auto rounded-md bg-surface p-2 font-mono text-[11px] text-muted">{typeof output === "string" ? output : JSON.stringify(output, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolGroupBlock({ group }: { group: ToolGroup }) {
  const { t } = useTranslation();
  const allDone = group.parts.every((part) => {
    const state = (part as Record<string, unknown>).state as string;
    return ["output-available", "output-error", "output-denied", "approval-responded"].includes(state);
  });
  const hasError = group.parts.some((part) => (part as Record<string, unknown>).state === "output-error");
  const needsApproval = group.parts.some((part) => (part as Record<string, unknown>).state === "approval-requested");
  const running = !allDone;

  return (
    <Collapsible defaultOpen={running || needsApproval}>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-[12px] text-muted hover:text-text transition-colors duration-150">
        {running ? (
          <Loader className="h-3.5 w-3.5 text-accent animate-spin" />
        ) : hasError ? (
          <CircleX className="h-3.5 w-3.5 text-danger" />
        ) : (
          <CircleCheck className="h-3.5 w-3.5 text-success" />
        )}
        <span>{t("chat.usedTools", { count: group.parts.length })}</span>
        <ChevronDown className="h-3 w-3 transition-transform duration-150 group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 ml-5 space-y-1.5">
          {group.parts.map((part, index) => <ToolBlock key={index} part={part} />)}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ChatLightbox({
  url,
  scale,
  onClose,
  onScaleChange,
}: {
  url: string;
  scale: number;
  onClose: () => void;
  onScaleChange: (scale: number) => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 animate-fade-in cursor-pointer"
      onClick={onClose}
      onWheel={(event) => {
        event.preventDefault();
        onScaleChange(Math.min(5, Math.max(0.2, scale - event.deltaY * 0.002)));
      }}
    >
      <img
        src={url}
        alt="preview"
        style={{ transform: `scale(${scale})`, transition: "transform 0.1s ease" }}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl cursor-default"
        onClick={(event) => event.stopPropagation()}
      />
      {scale !== 1 && (
        <button
          onClick={(event) => {
            event.stopPropagation();
            onScaleChange(1);
          }}
          className={cn(
            "absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 text-white text-xs px-3 py-1 hover:bg-white/20 transition-colors duration-150",
          )}
        >
          {(scale * 100).toFixed(0)}% · {t("chat.resetZoom")}
        </button>
      )}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors duration-150"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );
}
