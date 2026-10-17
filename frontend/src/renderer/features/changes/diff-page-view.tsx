import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { useAtomValue } from "jotai"
import { Check } from "lucide-react"
import { trpc } from "../../lib/trpc"
import { useChangesStore } from "../../lib/stores/changes-store"
import { useFileChangeListener } from "../../lib/hooks/use-file-change-listener"
import type { ChangedFile } from "../../../shared/changes-types"
import { getStatusIndicator } from "./utils/status"
import { cn } from "../../lib/utils"
import { AgentDiffView } from "../agents/ui/agent-diff-view"
import { viewedFilesAtomFamily } from "../agents/atoms"

interface DiffPageViewProps {
	worktreePath?: string
	chatId?: string
	sandboxId?: string
	isMobile?: boolean
}

const FILE_ROW_HEIGHT = 28
const MAX_VISIBLE_FILES = 8

const DiffFileRow = memo(function DiffFileRow({
	file,
	isSelected,
	isViewed,
	onSelect,
}: {
	file: ChangedFile
	isSelected: boolean
	isViewed: boolean
	onSelect: () => void
}) {
	const fileName = file.path.split("/").pop() || file.path
	const dirPath = file.path.includes("/")
		? file.path.substring(0, file.path.lastIndexOf("/"))
		: ""

	return (
		<div
			className={cn(
				"flex items-center gap-2 px-2 cursor-pointer transition-colors",
				"hover:bg-foreground/5",
				isSelected && "bg-foreground/10 hover:bg-foreground/10",
			)}
			style={{ height: FILE_ROW_HEIGHT }}
			onClick={onSelect}
		>
			<span className="shrink-0 flex items-center">{getStatusIndicator(file.status)}</span>
			<div className="flex-1 min-w-0 flex items-baseline overflow-hidden">
				{dirPath && (
					<span
						className={cn(
							"text-xs truncate flex-shrink min-w-0",
							isViewed ? "text-muted-foreground/50" : "text-muted-foreground",
						)}
					>
						{dirPath}/
					</span>
				)}
				<span
					className={cn(
						"text-xs font-medium flex-shrink-0 whitespace-nowrap",
						isViewed && "text-muted-foreground/60",
					)}
				>
					{fileName}
				</span>
			</div>
			{isViewed && (
				<span className="shrink-0 flex items-center text-primary" title="已查看">
					<Check className="size-3" strokeWidth={2.5} />
				</span>
			)}
			<div className="shrink-0 flex items-center gap-1.5 text-xs font-mono">
				{file.additions > 0 && (
					<span className="text-emerald-600 dark:text-emerald-400">
						+{file.additions}
					</span>
				)}
				{file.deletions > 0 && (
					<span className="text-red-600 dark:text-red-400">
						-{file.deletions}
					</span>
				)}
			</div>
		</div>
	)
})

/**
 * Standalone Diff page: file list on top (max ~8 visible, scrollable),
 * selected file's diff below.
 */
export function DiffPageView({
	worktreePath,
	chatId,
	sandboxId,
	isMobile = false,
}: DiffPageViewProps) {
	useFileChangeListener(worktreePath)

	const { baseBranch } = useChangesStore()
	const { data: branchData } = trpc.changes.getBranches.useQuery(
		{ worktreePath: worktreePath || "" },
		{ enabled: !!worktreePath },
	)
	const effectiveBaseBranch = baseBranch ?? branchData?.defaultBranch ?? "main"

	const { data: status } = trpc.changes.getStatus.useQuery(
		{ worktreePath: worktreePath || "", defaultBranch: effectiveBaseBranch },
		{
			enabled: !!worktreePath,
			refetchOnWindowFocus: true,
		},
	)

	const files = useMemo(() => {
		if (!status) return [] as ChangedFile[]
		const seen = new Set<string>()
		const list: ChangedFile[] = []
		for (const file of [...status.staged, ...status.unstaged, ...status.untracked]) {
			if (seen.has(file.path)) continue
			seen.add(file.path)
			list.push(file)
		}
		list.sort((a, b) => a.path.localeCompare(b.path))
		return list
	}, [status])

	const [selectedPath, setSelectedPath] = useState<string | null>(null)

	// Shared selection with the Git tab (ChangesView writes here on file click)
	const storeSelectedPath = useChangesStore((s) =>
		worktreePath ? (s.selectedFiles[worktreePath]?.file.path ?? null) : null,
	)
	const selectFile = useChangesStore((s) => s.selectFile)
	const fileCategory = useMemo(() => {
		const map = new Map<string, "staged" | "unstaged">()
		if (status) {
			for (const f of status.staged) map.set(f.path, "staged")
			for (const f of status.unstaged) if (!map.has(f.path)) map.set(f.path, "unstaged")
			for (const f of status.untracked) if (!map.has(f.path)) map.set(f.path, "unstaged")
		}
		return map
	}, [status])

	// Follow selection made in the Git tab
	useEffect(() => {
		if (storeSelectedPath) setSelectedPath(storeSelectedPath)
	}, [storeSelectedPath])

	const handleSelect = useCallback(
		(file: ChangedFile) => {
			setSelectedPath(file.path)
			if (worktreePath) {
				selectFile(worktreePath, file, fileCategory.get(file.path) ?? "unstaged", null)
			}
		},
		[worktreePath, selectFile, fileCategory],
	)

	// Viewed state (shared with AgentDiffView below) keyed by "oldPath->newPath"
	const viewedFiles = useAtomValue(viewedFilesAtomFamily(chatId || ""))
	// Only keys with viewed=true count (un-marking keeps the entry as viewed:false)
	const viewedKeys = useMemo(
		() =>
			new Set(
				Object.entries(viewedFiles)
					.filter(([, state]) => state?.viewed)
					.map(([key]) => key),
			),
		[viewedFiles],
	)
	const isFileViewed = useCallback(
		(file: ChangedFile) => {
			if (viewedKeys.size === 0) return false
			return (
				viewedKeys.has(`${file.path}->${file.path}`) ||
				viewedKeys.has(`/dev/null->${file.path}`) ||
				viewedKeys.has(`${file.path}->/dev/null`) ||
				(file.oldPath ? viewedKeys.has(`${file.oldPath}->${file.path}`) : false)
			)
		},
		[viewedKeys],
	)

	// Auto-select first file, fall back when selected file disappears
	useEffect(() => {
		if (files.length === 0) {
			if (selectedPath !== null) setSelectedPath(null)
			return
		}
		if (!selectedPath || !files.some((f) => f.path === selectedPath)) {
			setSelectedPath(files[0].path)
		}
	}, [files, selectedPath])

	if (!worktreePath) {
		return null
	}

	const listMaxHeight = FILE_ROW_HEIGHT * MAX_VISIBLE_FILES

	return (
		<div className="flex flex-col h-full overflow-hidden bg-background">
			{/* File list - top section, scrollable when more than 8 files */}
			{files.length > 0 ? (
				<div
					className="flex-shrink-0 overflow-y-auto border-b"
					style={{ maxHeight: listMaxHeight }}
				>
					{files.map((file) => (
						<DiffFileRow
							key={file.path}
							file={file}
							isSelected={selectedPath === file.path}
							isViewed={isFileViewed(file)}
							onSelect={() => handleSelect(file)}
						/>
					))}
				</div>
			) : (
				<div className="flex-shrink-0 flex items-center justify-center py-8 text-muted-foreground text-sm">
					No changes
				</div>
			)}

			{/* Diff - bottom section */}
			<div className="flex-1 min-h-0">
				{selectedPath && chatId ? (
					<AgentDiffView
						chatId={chatId}
						sandboxId={sandboxId ?? ""}
						worktreePath={worktreePath}
						initialSelectedFile={selectedPath}
						showFooter={false}
						isMobile={isMobile}
					/>
				) : null}
			</div>
		</div>
	)
}
