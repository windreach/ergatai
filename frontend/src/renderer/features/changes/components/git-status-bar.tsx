import { memo } from "react"
import { ArrowDown, ArrowUp, GitBranch } from "lucide-react"
import { toast } from "sonner"
import { trpc } from "../../../lib/trpc"
import { cn } from "../../../lib/utils"
import { usePushAction } from "../hooks/use-push-action"

interface GitStatusBarProps {
	worktreePath: string
}

/**
 * Compact git status bar: branch name, ahead/behind remote counts,
 * Push / Pull buttons. Rendered above the Git panel.
 */
export const GitStatusBar = memo(function GitStatusBar({
	worktreePath,
}: GitStatusBarProps) {
	const trpcUtils = trpc.useUtils()
	const { data: status, isLoading } = trpc.changes.getStatus.useQuery(
		{ worktreePath, defaultBranch: "main" },
		{ enabled: !!worktreePath },
	)

	const refetch = () => {
		trpcUtils.changes.getStatus.invalidate({ worktreePath })
	}

	const { push, isPending: isPushPending } = usePushAction({
		worktreePath,
		hasUpstream: status?.hasUpstream ?? true,
		onSuccess: () => {
			toast.success("Pushed to remote")
			refetch()
		},
	})

	const pullMutation = trpc.changes.pull.useMutation({
		onSuccess: () => {
			toast.success("Pulled from remote")
			refetch()
		},
		onError: (error: { message: string }) =>
			toast.error(`Pull failed: ${error.message}`),
	})

	const branch = status?.branch ?? null
	const pushCount = status?.pushCount ?? 0
	const pullCount = status?.pullCount ?? 0
	const isPullPending = pullMutation.isPending
	const canPush = !isLoading && !isPushPending
	const canPull = !isLoading && !isPullPending

	return (
		<div className="flex items-center gap-2 px-2 h-8 border-b border-border/50 shrink-0 text-xs">
			{/* Branch */}
			<div className="flex items-center gap-1 min-w-0 flex-1">
				<GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="font-medium truncate">{branch ?? "..."}</span>
				{!status?.hasUpstream && branch && (
					<span className="shrink-0 text-[10px] text-muted-foreground/70">
						(no upstream)
					</span>
				)}
			</div>

			{/* Ahead / behind remote */}
			{(pushCount > 0 || pullCount > 0) && (
				<div className="shrink-0 flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
					{pushCount > 0 && (
						<span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
							<ArrowUp className="size-3" />
							{pushCount}
						</span>
					)}
					{pullCount > 0 && (
						<span className="flex items-center gap-0.5 text-muted-foreground">
							<ArrowDown className="size-3" />
							{pullCount}
						</span>
					)}
				</div>
			)}

			{/* Actions */}
			<div className="shrink-0 flex items-center gap-1">
				<button
					type="button"
					onClick={() => pullMutation.mutate({ worktreePath, autoStash: true })}
					disabled={!canPull || pullCount === 0}
					className={cn(
						"h-6 px-2 rounded-md flex items-center gap-1 transition-colors",
						"hover:bg-foreground/5 text-muted-foreground hover:text-foreground",
						"disabled:opacity-40 disabled:pointer-events-none",
					)}
					title={pullCount > 0 ? `Pull ${pullCount} commit${pullCount !== 1 ? "s" : ""}` : "Up to date"}
				>
					<ArrowDown className="size-3" />
					Pull
				</button>
				<button
					type="button"
					onClick={push}
					disabled={!canPush || (pushCount === 0 && status?.hasUpstream)}
					className={cn(
						"h-6 px-2 rounded-md flex items-center gap-1 transition-colors",
						"hover:bg-foreground/5 text-muted-foreground hover:text-foreground",
						"disabled:opacity-40 disabled:pointer-events-none",
					)}
					title={pushCount > 0 ? `Push ${pushCount} commit${pushCount !== 1 ? "s" : ""}` : "Nothing to push"}
				>
					<ArrowUp className="size-3" />
					Push
				</button>
			</div>
		</div>
	)
})
