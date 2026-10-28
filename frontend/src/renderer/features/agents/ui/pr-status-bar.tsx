import { trpc } from "../../../lib/trpc"
import { GitPullRequest } from "lucide-react"
import { IconSpinner } from "../../../components/ui/icons"

interface PrStatusBarProps {
  chatId: string
  prUrl: string
  prNumber: number
}

type PrState = "open" | "draft" | "merged" | "closed"
type ReviewDecision = "approved" | "changes_requested" | "pending"

const VALID_PR_STATES = new Set<PrState>(["open", "draft", "merged", "closed"])
const VALID_REVIEW_DECISIONS = new Set<ReviewDecision>(["approved", "changes_requested", "pending"])

function isValidPrState(state: string): state is PrState {
  return VALID_PR_STATES.has(state as PrState)
}

function isValidReviewDecision(decision: string): decision is ReviewDecision {
  return VALID_REVIEW_DECISIONS.has(decision as ReviewDecision)
}

function getStatusLabel(state: PrState, reviewDecision?: ReviewDecision): string {
  if (state === "merged") return "Merged"
  if (state === "closed") return "Closed"
  if (state === "draft") return "Draft"
  if (reviewDecision === "approved") return "Ready to merge"
  if (reviewDecision === "changes_requested") return "Changes requested"
  return "Open"
}

export function PrStatusBar({ chatId, prUrl, prNumber }: PrStatusBarProps) {
  // Poll PR status every 30 seconds
  const { data: status, isLoading, error, isError } = trpc.chats.getPrStatus.useQuery(
    { chatId },
    { refetchInterval: 30000, enabled: !!prNumber }
  )

  const pr = status?.pr

  const handleOpenPr = () => {
    window.desktopApi?.openExternal(prUrl)
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-muted/30 border-b border-border/50">
      {/* PR Link */}
      <button
        onClick={handleOpenPr}
        className="flex items-center gap-1.5 text-sm font-medium hover:underline text-foreground cursor-pointer"
      >
        <GitPullRequest className="h-4 w-4" />
        <span>PR #{prNumber}</span>
      </button>

      {/* Status */}
      {isLoading ? (
        <IconSpinner className="h-3.5 w-3.5" />
      ) : isError ? (
        <span className="text-xs font-mono text-destructive">
          Failed to load status
        </span>
      ) : pr ? (
        <span className="text-xs font-mono text-muted-foreground">
          {getStatusLabel(
            isValidPrState(pr.state) ? pr.state : "open",
            isValidReviewDecision(pr.reviewDecision) ? pr.reviewDecision : undefined
          )}
        </span>
      ) : null}
    </div>
  )
}
