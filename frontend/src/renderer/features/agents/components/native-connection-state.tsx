import i18n from "@/lib/i18n"
"use client"

import { Button } from "@/components/ui/button"
import { IconSpinner } from "@/icons"

interface NativeConnectionConfig {
  sourcePath: string
  baseUrl?: string | null
  defaultModel?: string | null
  hasApiKey: boolean
}

interface NativeConnectionStateProps {
  isLoading: boolean
  isError: boolean
  errorMessage?: string
  isFetching: boolean
  onRetry: () => void
  config?: NativeConnectionConfig | null
  isImporting: boolean
  isImportError: boolean
  importErrorMessage?: string
  onImport: () => void
}

export function NativeConnectionState({
  isLoading,
  isError,
  errorMessage,
  isFetching,
  onRetry,
  config,
  isImporting,
  isImportError,
  importErrorMessage,
  onImport,
}: NativeConnectionStateProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-3">
        <IconSpinner className="h-4 w-4" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="space-y-1.5 rounded-lg border border-dashed border-destructive/40 bg-destructive/5 px-3 py-2.5">
        <p className="text-xs font-medium text-foreground">
          {i18n.t("Could not detect native configuration")}
        </p>
        <p className="text-[11px] leading-4 text-muted-foreground">
          {i18n.t(
            "The backend may be outdated (restart it) or the config file is unreadable.",
          )}{" "}
          {errorMessage ?? ""}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          disabled={isFetching}
          onClick={onRetry}
        >
          {isFetching ? <IconSpinner className="mr-1 h-3 w-3" /> : null}
          {i18n.t("Retry")}
        </Button>
      </div>
    )
  }

  if (!config) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
        {i18n.t("No providers yet.")}
      </p>
    )
  }

  const summary =
    [
      config.baseUrl,
      config.defaultModel,
      config.hasApiKey ? "API key found" : "No API key found",
    ]
      .filter(Boolean)
      .join(" · ") || i18n.t("No endpoints or models configured")

  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-foreground">
          {isImporting
            ? i18n.t("Importing native configuration…")
            : isImportError
              ? i18n.t("Import failed")
              : i18n.t("Native configuration detected")}
        </p>
        {!isImporting && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={onImport}
          >
            {i18n.t("Import as default")}
          </Button>
        )}
        {isImporting && <IconSpinner className="h-3.5 w-3.5" />}
      </div>
      {isImportError && (
        <p className="text-[11px] leading-4 text-destructive">
          {importErrorMessage ??
            i18n.t("Could not import the detected configuration.")}
        </p>
      )}
      <p
        className="truncate font-mono text-[11px] text-muted-foreground"
        title={config.sourcePath}
      >
        {config.sourcePath}
      </p>
      <p
        className="truncate text-[11px] text-muted-foreground"
        title={summary}
      >
        {summary}
      </p>
    </div>
  )
}
