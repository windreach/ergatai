import { useMemo } from "react"
import { diffLines } from "diff"
import { cn } from "../../lib/utils"

const MAX_PREVIEW_LINES = 80
const MAX_PREVIEW_CHARS = 200_000

type PreviewLine = {
  type: "added" | "removed" | "context"
  content: string
  oldLine?: number
  newLine?: number
}

type PermissionPreview = {
  filePath?: string
  lines: PreviewLine[]
  addedLines: number
  removedLines: number
  hiddenLines: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function pickString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string") return value
  }
  return undefined
}

function getFilePath(input: Record<string, unknown>): string | undefined {
  const direct = pickString(input, ["path", "filePath", "file_path", "filename"])
  if (direct) return direct

  const locations = input._locations
  if (Array.isArray(locations)) {
    const first = asRecord(locations[0])
    const locationPath = first ? pickString(first, ["path"]) : undefined
    if (locationPath) return locationPath
  }

  return undefined
}

function splitChangeLines(value: string): string[] {
  const lines = value.split("\n")
  // Unified diff values end with a newline; drop the trailing empty entry.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop()
  }
  return lines
}

function buildDiffLines(oldText: string, newText: string): PreviewLine[] {
  const lines: PreviewLine[] = []
  let oldLine = 1
  let newLine = 1

  for (const change of diffLines(oldText, newText)) {
    for (const content of splitChangeLines(change.value)) {
      if (change.added) {
        lines.push({ type: "added", content, newLine })
        newLine++
      } else if (change.removed) {
        lines.push({ type: "removed", content, oldLine })
        oldLine++
      } else {
        lines.push({ type: "context", content, oldLine, newLine })
        oldLine++
        newLine++
      }
    }
  }

  return lines
}

/**
 * Build a compact unified-diff preview for file-editing tool inputs.
 * Supports both camelCase (OpenCode) and snake_case (Claude Code) keys.
 */
export function buildPermissionPreview(
  input: unknown,
  toolName?: string | null,
): PermissionPreview | null {
  const record = asRecord(input)
  if (!record) return null

  const oldText = pickString(record, ["oldString", "old_string"])
  const newText = pickString(record, [
    "newString",
    "new_string",
    "newText",
    "new_text",
    "content",
  ])

  if (newText === undefined) return null

  const isEdit = oldText !== undefined
  const isWrite = !isEdit && getFilePath(record) != null
  const looksLikeEditTool = /edit|write|create|replace|patch/i.test(toolName ?? "")

  // Only treat `content` as file content when the input looks like a file
  // operation; otherwise fall through to the raw JSON view.
  if (!isEdit && !isWrite && !looksLikeEditTool) return null

  if ((oldText?.length ?? 0) + newText.length > MAX_PREVIEW_CHARS) return null

  const allLines = buildDiffLines(oldText ?? "", newText)

  const addedLines = allLines.filter((line) => line.type === "added").length
  const removedLines = allLines.filter((line) => line.type === "removed").length
  const lines = allLines.slice(0, MAX_PREVIEW_LINES)

  return {
    filePath: getFilePath(record),
    lines,
    addedLines,
    removedLines,
    hiddenLines: allLines.length - lines.length,
  }
}

function PreviewRow({ line }: { line: PreviewLine }) {
  const marker =
    line.type === "added" ? "+" : line.type === "removed" ? "-" : " "

  return (
    <div
      className={cn(
        "flex min-w-max",
        line.type === "removed" && "bg-red-500/10 dark:bg-red-500/15",
        line.type === "added" && "bg-green-500/10 dark:bg-green-500/15",
      )}
    >
      <span className="w-8 shrink-0 select-none px-1 text-right text-muted-foreground/50">
        {line.oldLine ?? ""}
      </span>
      <span className="w-8 shrink-0 select-none px-1 text-right text-muted-foreground/50">
        {line.newLine ?? ""}
      </span>
      <span
        className={cn(
          "w-4 shrink-0 select-none text-center",
          line.type === "removed" && "text-red-600 dark:text-red-400",
          line.type === "added" && "text-green-600 dark:text-green-400",
          line.type === "context" && "text-muted-foreground/50",
        )}
      >
        {marker}
      </span>
      <span
        className={cn(
          "whitespace-pre pr-2",
          line.type === "removed" && "text-red-700 dark:text-red-300",
          line.type === "added" && "text-green-700 dark:text-green-300",
          line.type === "context" && "text-muted-foreground",
        )}
      >
        {line.content || " "}
      </span>
    </div>
  )
}

export function PermissionToolPreview({
  input,
  toolName,
}: {
  input: unknown
  toolName?: string | null
}) {
  const preview = useMemo(
    () => buildPermissionPreview(input, toolName),
    [input, toolName],
  )

  if (!preview) {
    return (
      <pre className="mx-2 max-h-32 overflow-auto rounded-md border border-border/60 bg-background/50 p-2 text-[12px] font-mono whitespace-pre-wrap break-all">
        {typeof input === "string" ? input : JSON.stringify(input, null, 2)}
      </pre>
    )
  }

  return (
    <div className="mx-2 overflow-hidden rounded-md border border-border/60 bg-background/50">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2 py-1">
        <span className="truncate font-mono text-[11px] text-foreground/80">
          {preview.filePath ?? "Diff"}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          {preview.addedLines > 0 && (
            <span className="text-green-600 dark:text-green-400">
              +{preview.addedLines}
            </span>
          )}
          {preview.addedLines > 0 && preview.removedLines > 0 && " "}
          {preview.removedLines > 0 && (
            <span className="text-red-600 dark:text-red-400">
              -{preview.removedLines}
            </span>
          )}
        </span>
      </div>
      <div className="max-h-48 overflow-auto py-0.5 text-[11px] leading-[1.5] font-mono">
        {preview.lines.map((line, index) => (
          // react-doctor-disable-next-line no-array-index-as-key
          <PreviewRow key={`${line.type}-${index}`} line={line} />
        ))}
      </div>
      {preview.hiddenLines > 0 && (
        <div className="border-t border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
          … {preview.hiddenLines} more line
          {preview.hiddenLines === 1 ? "" : "s"}
        </div>
      )}
    </div>
  )
}
