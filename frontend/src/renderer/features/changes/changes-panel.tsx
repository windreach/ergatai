import i18n from "@/lib/i18n"
import type { ChangeCategory, ChangedFile } from "../../../shared/changes-types";
import { ChangesView } from "./changes-view";
import { trpc } from "../../lib/trpc";
import { toast } from "sonner";
import type { ConversationFilterItem } from "./components/changes-file-filter";
import type { CommitInfo } from "./components/history-view";

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
	const mergeMutation = trpc.changes.mergeChatBranch.useMutation({
		onSuccess: (result) => {
			if (result.status === "merged") {
				toast.success("Merged into base branch", { position: "top-center" });
			} else if (result.status === "nothing_to_merge") {
				toast.info("Nothing to merge", { position: "top-center" });
			} else if (result.status === "needs_manual_merge") {
				toast.error(
					result.reason === "conflict"
						? `Merge conflict: ${(result.conflictedFiles ?? []).join(", ")}`
						: `Merge needs manual resolution: ${result.reason ?? ""}`,
					{ position: "top-center", duration: 8000 },
				);
			} else if (result.status === "error") {
				toast.error(result.error || "Merge failed", { position: "top-center" });
			}
		},
		onError: (error) => {
			toast.error(error.message || "Merge failed", { position: "top-center" });
		},
	});

	const chatBranch = chatQuery.data?.branch ?? null;
	const baseBranch = chatQuery.data?.baseBranch ?? null;

	if (!worktreePath) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4">
				No worktree path available
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{chatBranch && baseBranch && (
				<div className="flex items-center justify-end px-2 py-1 border-b border-border/50">
					<button
						type="button"
						className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline disabled:opacity-50"
						disabled={mergeMutation.isPending}
						onClick={() => {
							mergeMutation.mutate({
								worktreePath,
								chatBranch,
								baseBranch,
							});
						}}
					>
						{mergeMutation.isPending ? "Merging..." : "Merge to base"}
					</button>
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
