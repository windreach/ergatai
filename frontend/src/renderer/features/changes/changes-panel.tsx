// Modified from 1Code (Apache-2.0) by Ergatai — see MODIFICATIONS.md
import { useState } from "react"
import { ChevronDown, GitMerge, RefreshCw, X } from "lucide-react"
import type { ChangeCategory, ChangedFile } from "../../../shared/changes-types";
import { ChangesView } from "./changes-view";
import { trpc } from "../../lib/trpc";
import { Button } from "../../components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { cn } from "../../lib/utils";
import type { ConversationFilterItem } from "./components/changes-file-filter";
import type { CommitInfo } from "./components/history-view";

type BaseActionStatus = {
	tone: "success" | "error" | "info";
	message: string;
	details?: string[];
};

function formatConflictDetails(files: string[] | undefined): string[] | undefined {
	if (!files || files.length === 0) return undefined;
	const shown = files.slice(0, 5);
	return files.length > shown.length
		? [...shown, `+${files.length - shown.length} more`]
		: shown;
}

type MergeStrategy = "ff-only" | "no-ff" | "squash";

/** Each option maps 1:1 onto a git merge invocation. No hidden behaviour. */
const MERGE_STRATEGIES: Array<{
	value: MergeStrategy;
	label: string;
	description: string;
}> = [
	{
		value: "ff-only",
		label: "Fast-forward only",
		description: "Only if the base branch has no new commits",
	},
	{
		value: "no-ff",
		label: "Merge commit",
		description: "Always create a merge commit",
	},
	{
		value: "squash",
		label: "Squash",
		description: "Combine all commits into one commit",
	},
];

function describeMerge(
	strategy: MergeStrategy | undefined,
	chatBranch: string | null,
	baseBranch: string | null,
): string {
	const target = `${chatBranch ?? "branch"} into ${baseBranch ?? "base"}`;
	if (strategy === "ff-only") return `Fast-forwarded ${target}`;
	if (strategy === "squash") return `Squash-merged ${target}`;
	return `Merged ${target}`;
}

function describeMergeBlocker(
	reason: string | undefined,
	baseBranch: string | null,
	error: string | undefined,
): string {
	switch (reason) {
		case "base_dirty":
			return `${baseBranch ?? "Base"} has uncommitted changes — commit or stash them first`;
		case "repo_busy":
			return `${baseBranch ?? "Base"} has a merge or rebase in progress`;
		case "not_fast_forwardable":
			return `${baseBranch ?? "Base"} has new commits — choose "Merge commit" instead`;
		case "worktree_busy":
			return "This worktree has a merge or rebase in progress";
		default:
			return error || `Merge failed (${reason ?? "unknown"})`;
	}
}

interface ChangesPanelProps {
	worktreePath: string;
	/** Controlled active tab for ChangesView */
	activeTab?: "changes" | "history";
	/** Currently selected file path for highlighting */
	selectedFilePath?: string | null;
	/** Callback when a file is selected */
	onFileSelect?: (
		file: ChangedFile,
		category: ChangeCategory,
	) => void;
	/** Callback when a file is double-clicked (pinned) */
	onFileOpenPinned?: (
		file: ChangedFile,
		category: ChangeCategory,
	) => void;
	/** Callback to create a PR (sends prompt to chat) */
	onCreatePr?: () => void;
	/** Called after a successful commit to reset diff view state */
	onCommitSuccess?: () => void;
	/** Called after discarding/deleting changes to refresh diff */
	onDiscardSuccess?: () => void;
	/** Available conversations for filtering */
	conversations?: ConversationFilterItem[];
	/** Currently selected conversation ID for filtering (passed from Review button) */
	initialConversationFilter?: string | null;
	/** Chat ID for AI-generated commit messages */
	chatId?: string;
	/** Selected commit hash for History tab */
	selectedCommitHash?: string | null;
	/** Callback when commit is selected in History tab */
	onCommitSelect?: (commit: CommitInfo | null) => void;
	/** Callback when file is selected in commit History */
	onCommitFileSelect?: (file: ChangedFile, commitHash: string) => void;
	/** Callback when active tab changes (Changes/History) */
	onActiveTabChange?: (tab: "changes" | "history") => void;
	/** Number of commits ahead of upstream (for unpushed indicator) */
	pushCount?: number;
}

export function ChangesPanel({
	worktreePath,
	activeTab,
	selectedFilePath,
	onFileSelect,
	onFileOpenPinned,
	onCreatePr,
	onCommitSuccess,
	onDiscardSuccess,
	conversations,
	initialConversationFilter,
	chatId,
	selectedCommitHash,
	onCommitSelect,
	onCommitFileSelect,
	onActiveTabChange,
	pushCount,
}: ChangesPanelProps) {
	const chatQuery = trpc.chats.get.useQuery(
		{ id: chatId! },
		{ enabled: !!chatId },
	);
	const [baseActionStatus, setBaseActionStatus] =
		useState<BaseActionStatus | null>(null);

	const chatBranch = chatQuery.data?.branch ?? null;
	const baseBranch = chatQuery.data?.baseBranch ?? null;

	const mergeMutation = trpc.changes.mergeChatBranch.useMutation({
		onSuccess: (result) => {
			if (result.status === "merged") {
				setBaseActionStatus({
					tone: "success",
					message: `${describeMerge(result.strategy, chatBranch, baseBranch)} (not pushed)`,
				});
			} else if (result.status === "nothing_to_merge") {
				setBaseActionStatus({
					tone: "info",
					message: `Nothing to merge from ${chatBranch ?? "branch"} into ${baseBranch ?? "base"}`,
				});
			} else if (result.status === "needs_manual_merge") {
				setBaseActionStatus({
					tone: "error",
					message:
						result.reason === "conflict"
							? `Merge conflict in ${result.conflictedFiles?.length ?? 0} file(s)`
							: describeMergeBlocker(
									result.reason,
									baseBranch,
									result.error,
								),
					details: formatConflictDetails(result.conflictedFiles),
				});
			} else if (result.status === "error") {
				setBaseActionStatus({
					tone: "error",
					message: result.error || "Merge failed",
				});
			}
		},
		onError: (error) => {
			setBaseActionStatus({
				tone: "error",
				message: error.message || "Merge failed",
			});
		},
	});

	const syncMutation = trpc.changes.syncWorktreeToBase.useMutation({
		onSuccess: (result) => {
			if (result.status === "synced") {
				setBaseActionStatus({
					tone: "success",
					message: `Synced ${result.filesChanged ?? 0} file(s) to ${baseBranch ?? "base"} working tree (not committed)`,
				});
			} else if (result.status === "nothing_to_sync") {
				setBaseActionStatus({
					tone: "info",
					message: `${baseBranch ?? "Base"} working tree is already up to date`,
				});
			} else if (result.status === "needs_manual_merge") {
				setBaseActionStatus({
					tone: "error",
					message: `Sync needs manual resolution: ${result.reason ?? "conflict"}`,
					details: formatConflictDetails(result.conflictedFiles),
				});
			} else if (result.status === "error") {
				setBaseActionStatus({
					tone: "error",
					message: result.error || "Sync failed",
				});
			}
		},
		onError: (error) => {
			setBaseActionStatus({
				tone: "error",
				message: error.message || "Sync failed",
			});
		},
	});

	// A branch only has something to merge into a *different* base branch.
	// Showing the action when both are the same invites a no-op at best and
	// races with the user's own edits on that branch at worst.
	const canMergeIntoBase =
		!!chatBranch && !!baseBranch && chatBranch !== baseBranch;
	const isBaseActionPending = mergeMutation.isPending || syncMutation.isPending;

	if (!worktreePath) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4">
				No worktree path available
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{canMergeIntoBase && (
				<div className="border-b border-border/50">
					<div className="flex items-center justify-between gap-2 px-2 py-1">
						<span
							className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
							title={`${chatBranch} → ${baseBranch}`}
						>
							{chatBranch} → {baseBranch}
						</span>
						<div className="flex shrink-0 items-center gap-1">
							<Button
								variant="ghost"
								size="sm"
								className="h-6 gap-1.5 px-2 text-xs"
								disabled={isBaseActionPending}
								onClick={() => {
									syncMutation.mutate({
										worktreePath,
										chatBranch,
										baseBranch,
									});
								}}
								title={`Copy uncommitted changes from ${chatBranch} into the ${baseBranch} working tree. Nothing is committed or pushed.`}
							>
								<RefreshCw
									className={cn(
										"size-3.5 shrink-0",
										syncMutation.isPending && "animate-spin",
									)}
								/>
								<span className="truncate">
									{syncMutation.isPending ? "Syncing..." : "Sync changes"}
								</span>
							</Button>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="ghost"
										size="sm"
										className="h-6 min-w-0 gap-1.5 px-2 text-xs"
										disabled={isBaseActionPending}
										title={`Merge this branch into ${baseBranch}. Nothing is pushed.`}
									>
										<GitMerge className="size-3.5 shrink-0" />
										<span className="truncate">
											{mergeMutation.isPending
												? "Merging..."
												: `Merge into ${baseBranch}`}
										</span>
										<ChevronDown className="size-3 shrink-0" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="w-72">
									{MERGE_STRATEGIES.map((strategy) => (
										<DropdownMenuItem
											key={strategy.value}
											disabled={isBaseActionPending}
											onClick={() => {
												mergeMutation.mutate({
													worktreePath,
													chatBranch,
													baseBranch,
													strategy: strategy.value,
												});
											}}
										>
											<div className="flex-1">
												<div className="text-xs">{strategy.label}</div>
												<div className="text-[10px] text-muted-foreground">
													{strategy.description}
												</div>
											</div>
										</DropdownMenuItem>
									))}
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					</div>
					{baseActionStatus && (
						<div
							className={cn(
								"flex items-start gap-1.5 px-2 pb-1.5 text-[11px] leading-snug",
								baseActionStatus.tone === "error"
									? "text-red-500"
									: baseActionStatus.tone === "success"
										? "text-emerald-600 dark:text-emerald-400"
										: "text-muted-foreground",
							)}
						>
							<div className="min-w-0 flex-1">
								<p className="truncate" title={baseActionStatus.message}>
									{baseActionStatus.message}
								</p>
								{baseActionStatus.details && (
									<p
										className="truncate opacity-80"
										title={baseActionStatus.details.join(", ")}
									>
										{baseActionStatus.details.join(", ")}
									</p>
								)}
							</div>
							<button
								type="button"
								className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
								onClick={() => setBaseActionStatus(null)}
								aria-label="Dismiss"
							>
								<X className="size-3" />
							</button>
						</div>
					)}
				</div>
			)}
			<ChangesView
				worktreePath={worktreePath}
				activeTab={activeTab}
				selectedFilePath={selectedFilePath}
				onFileSelect={onFileSelect}
				onFileOpenPinned={onFileOpenPinned}
				onCreatePr={onCreatePr}
				onCommitSuccess={onCommitSuccess}
				onDiscardSuccess={onDiscardSuccess}
				conversations={conversations}
				initialConversationFilter={initialConversationFilter}
				chatId={chatId}
				selectedCommitHash={selectedCommitHash}
				onCommitSelect={onCommitSelect}
				onCommitFileSelect={onCommitFileSelect}
				onActiveTabChange={onActiveTabChange}
				pushCount={pushCount}
			/>
		</div>
	);
}
