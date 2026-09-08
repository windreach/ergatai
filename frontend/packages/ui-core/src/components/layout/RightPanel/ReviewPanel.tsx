import { AlertCircle, CheckCircle, FileDiff, ShieldCheck } from "lucide-react";
import { useConversationStore } from "../../../core/workspace/conversationStore";

type ApprovalState = "pending" | "approved" | "rejected";

interface ReviewItem {
  approvalId: string;
  messageId: string;
  taskId: string;
  title: string;
  filePath: string;
  reason: string;
  state: ApprovalState;
  senderName: string;
}

function getStatusStyle(status: ApprovalState) {
  if (status === "pending") return "border-yellow-500/30 bg-yellow-500/5";
  if (status === "approved") return "border-green-500/30 bg-green-500/5";
  return "border-red-500/30 bg-red-500/5";
}

function getStatusLabel(status: ApprovalState) {
  if (status === "pending") return "待审批";
  if (status === "approved") return "已批准";
  return "已拒绝";
}

function StatusIcon({ status }: { status: ApprovalState }) {
  if (status === "pending") return <AlertCircle className="h-4 w-4 text-yellow-600" />;
  if (status === "approved") return <CheckCircle className="h-4 w-4 text-green-600" />;
  return <AlertCircle className="h-4 w-4 text-red-600" />;
}

export function ReviewPanel() {
  const messages = useConversationStore((state) => state.messages);
  const respondToApproval = useConversationStore((state) => state.respondToApproval);

  const reviews = messages.flatMap<ReviewItem>((message) =>
    message.parts.flatMap((part) =>
      part.type === "approval"
        ? [{
            approvalId: part.approval.approvalId,
            messageId: message.id,
            taskId: (part.approval.metadata as Record<string, unknown> | undefined)?.taskId as string ?? '',
            title: part.approval.title,
            filePath: (part.approval.metadata as Record<string, unknown> | undefined)?.filePath as string ?? '',
            reason: part.approval.description ?? '',
            state: part.approval.status,
            senderName: message.senderName,
          }]
        : [],
    ),
  );
  const pendingCount = reviews.filter((review) => review.state === "pending").length;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-text">审批中心</span>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs ${pendingCount ? "bg-orange-500/10 text-orange-600" : "bg-muted/10 text-muted"}`}>
          {pendingCount} 待处理
        </span>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {reviews.map((review) => (
          <article key={review.approvalId} className={`rounded-xl border p-3 ${getStatusStyle(review.state)}`}>
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <StatusIcon status={review.state} />
                <span className="truncate font-mono text-xs text-text">{review.filePath}</span>
              </div>
              <span className="flex-shrink-0 text-xs text-muted">{getStatusLabel(review.state)}</span>
            </div>

            <h3 className="text-sm font-medium text-text">{review.title}</h3>
            <p className="mt-1 text-xs text-muted">{review.reason}</p>
            <p className="mt-1 text-xs text-faint">请求人：{review.senderName}</p>

            {review.state === "pending" && (
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => respondToApproval(review.messageId, review.approvalId, true)}
                  className="flex-1 rounded-md bg-green-500/10 px-3 py-1.5 text-xs font-medium text-green-600 transition-colors hover:bg-green-500/20"
                >
                  批准
                </button>
                <button
                  type="button"
                  onClick={() => respondToApproval(review.messageId, review.approvalId, false)}
                  className="flex-1 rounded-md bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/20"
                >
                  拒绝
                </button>
              </div>
            )}
          </article>
        ))}

        {reviews.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-muted">
            当前对话没有审批请求
          </div>
        )}
      </div>

      <footer className="border-t border-border-subtle p-3">
        {pendingCount ? (
          <button
            type="button"
            onClick={() => {
              reviews
                .filter((review) => review.state === "pending")
                .forEach((review) => respondToApproval(review.messageId, review.approvalId, true));
            }}
            className="w-full rounded-md bg-primary px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-primary/90"
          >
            全部批准
          </button>
        ) : (
          <div className="flex items-center justify-center gap-2 text-xs text-muted">
            <FileDiff className="h-3.5 w-3.5" />
            没有待处理审批
          </div>
        )}
      </footer>
    </div>
  );
}
