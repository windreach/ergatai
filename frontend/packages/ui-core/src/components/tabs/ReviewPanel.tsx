import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  Columns2,
  FileDiff,
  RefreshCw,
  Rows2,
  X,
} from "lucide-react";
import { cn } from "../../lib/utils";
import {
  reviewBackend,
  type ReviewDecision,
  type ReviewDetail,
  type ReviewSummary,
} from "@ergatai/platform-core";

const DiffEditor = lazy(() => import("../monaco/DiffEditor"));

export function ReviewPanel() {
  const { t } = useTranslation();
  const [reviews, setReviews] = useState<ReviewSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [splitView, setSplitView] = useState(false);
  const [prefersLight, setPrefersLight] = useState(() => window.matchMedia("(prefers-color-scheme: light)").matches);

  const detailLoading = !detail || detail.id !== selectedId;
  const activeFile = detail?.files.find((file) => file.id === selectedFileId) ?? detail?.files[0] ?? null;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setPrefersLight(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadReviews() {
      try {
        const items = await reviewBackend.list();
        if (cancelled) return;
        setReviews(items);
        setSelectedId((current) => current ?? items[0]?.id ?? null);
        setError(null);
      } catch (loadError) {
        if (!cancelled) {
          setReviews([]);
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    }

    void loadReviews();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    const reviewId = selectedId;

    async function loadDetail() {
      try {
        const loaded = await reviewBackend.get(reviewId);
        if (cancelled) return;
        setDetail(loaded);
        setSelectedFileId(loaded.files[0]?.id ?? null);
        setError(null);
      } catch (loadError) {
        if (!cancelled) {
          setDetail(null);
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    }

    void loadDetail();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const refresh = useCallback(async () => {
    try {
      const items = await reviewBackend.list();
      setReviews(items);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }, []);

  const submitDecision = useCallback(async (decision: Exclude<ReviewDecision, "pending">) => {
    if (!detail || actionBusy) return;
    setActionBusy(true);
    try {
      const updated = await reviewBackend.decide(detail.id, decision);
      setDetail(updated);
      setReviews((current) => current?.map((item) => (
        item.id === updated.id ? { ...item, decision: updated.decision } : item
      )) ?? null);
      setError(null);
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : String(decisionError));
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, detail]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-chat">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle bg-surface px-3">
        <select
          value={selectedId ?? ""}
          onChange={(event) => setSelectedId(event.target.value)}
          aria-label={t("review.currentRound")}
          className="h-7 max-w-[220px] appearance-none rounded-lg bg-transparent px-1 text-[12px] text-muted outline-none hover:bg-hover"
        >
          {reviews?.map((item) => (
            <option key={item.id} value={item.id} className="bg-surface text-text">
              {item.title}
            </option>
          ))}
        </select>
        {detail && (
          <div className="flex shrink-0 items-center gap-1 font-mono text-[12px]">
            <span className="text-success">+{detail.additions}</span>
            <span className="text-danger">-{detail.deletions}</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSplitView((current) => !current)}
            aria-label={splitView ? t("review.unifiedView") : t("review.splitView")}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-text"
          >
            {splitView ? <Rows2 className="h-3.5 w-3.5" /> : <Columns2 className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label={t("files.refresh")}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-text"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {error && (
          <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-[12px] text-danger">{error}</div>
        )}
        {!reviews ? (
          <p className="p-4 text-[12px] text-faint">{t("review.loading")}</p>
        ) : reviews.length === 0 ? (
          <p className="p-4 text-[12px] text-faint">{t("review.empty")}</p>
        ) : null}

        {selectedId && detailLoading ? (
          <p className="p-4 text-[12px] text-faint">{t("review.loading")}</p>
        ) : detail && activeFile ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 border-b border-border-subtle bg-surface px-4 py-1.5 text-[11px] text-faint">
              {t("review.unmodified", { count: Math.max(
                activeFile.oldText.split("\n").length,
                activeFile.newText.split("\n").length,
              ) })}
            </div>
            <div className="min-h-0 flex-1">
              <Suspense fallback={<div className="h-full" />}>
                  <DiffEditor
                    id={activeFile.id}
                    original={activeFile.oldText}
                  modified={activeFile.newText}
                  language={activeFile.language}
                  theme={prefersLight ? "ergatai-light" : "ergatai-dark"}
                  splitView={splitView}
                />
              </Suspense>
            </div>
          </div>
        ) : selectedId ? null : null}
      </div>

      {detail && detail.files.length > 0 && (
        <div className="max-h-[calc(4*2.25rem_+_3px)] shrink-0 divide-y divide-border-subtle overflow-y-auto overscroll-contain border-t border-border-subtle bg-surface">
          {detail.files.map((file) => (
            <button
              key={file.id}
              type="button"
              onClick={() => setSelectedFileId(file.id)}
              className={cn(
                "flex h-9 w-full shrink-0 items-center gap-2 px-4 text-left font-mono text-[12px] transition-colors",
                file.id === activeFile?.id ? "bg-hover text-text" : "text-muted hover:bg-hover/70 hover:text-text",
              )}
            >
              <FileDiff className={cn("h-3.5 w-3.5 shrink-0", file.id === activeFile?.id ? "text-accent" : "text-faint")} />
              <span className="min-w-0 flex-1 truncate">{file.path}</span>
              <span className="shrink-0 font-mono text-[11px] text-success">+{file.additions}</span>
              <span className="shrink-0 font-mono text-[11px] text-danger">-{file.deletions}</span>
            </button>
          ))}
        </div>
      )}

      <footer className="shrink-0 border-t border-border-subtle p-3">
        <div className="flex items-center justify-center gap-[10%]">
          <button
            type="button"
            onClick={() => void submitDecision("rejected")}
            disabled={!detail || actionBusy}
            title={t("review.reject")}
            aria-label={t("review.reject")}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-danger/40 text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X className="h-4.5 w-4.5" />
          </button>
          <button
            type="button"
            onClick={() => void submitDecision("approved")}
            disabled={!detail || actionBusy}
            title={t("review.approve")}
            aria-label={t("review.approve")}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-success/40 text-success transition-colors hover:bg-success/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Check className="h-4.5 w-4.5" />
          </button>
        </div>
      </footer>
    </div>
  );
}
