import { CheckSquare, AlertCircle, CheckCircle } from "lucide-react";

interface ReviewItem {
  id: string;
  file: string;
  line: number;
  comment: string;
  status: "pending" | "approved" | "rejected";
  severity: "info" | "warning" | "error";
}

export function ReviewPanel() {
  // Mock data
  const reviews: ReviewItem[] = [
    {
      id: "1",
      file: "src/App.tsx",
      line: 15,
      comment: "这里需要添加错误处理",
      status: "pending",
      severity: "warning",
    },
    {
      id: "2",
      file: "src/utils/store.ts",
      line: 42,
      comment: "类型定义正确",
      status: "approved",
      severity: "info",
    },
    {
      id: "3",
      file: "src/components/Layout.tsx",
      line: 28,
      comment: "潜在的内存泄漏问题",
      status: "pending",
      severity: "error",
    },
  ];

  const getSeverityIcon = (severity: ReviewItem["severity"]) => {
    switch (severity) {
      case "info":
        return <CheckCircle className="h-4 w-4 text-blue-500" />;
      case "warning":
        return <AlertCircle className="h-4 w-4 text-yellow-500" />;
      case "error":
        return <AlertCircle className="h-4 w-4 text-red-500" />;
    }
  };

  const getStatusColor = (status: ReviewItem["status"]) => {
    switch (status) {
      case "pending":
        return "border-yellow-500/30 bg-yellow-500/5";
      case "approved":
        return "border-green-500/30 bg-green-500/5";
      case "rejected":
        return "border-red-500/30 bg-red-500/5";
    }
  };

  const getStatusLabel = (status: ReviewItem["status"]) => {
    switch (status) {
      case "pending":
        return "待审查";
      case "approved":
        return "已通过";
      case "rejected":
        return "已拒绝";
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2">
        <div className="flex items-center gap-2">
          <CheckSquare className="h-4 w-4 text-muted" />
          <span className="text-sm font-medium text-text">代码审查</span>
        </div>
        <span className="text-xs text-muted">
          {reviews.filter((r) => r.status === "pending").length} 待处理
        </span>
      </div>

      {/* Review List */}
      <div className="flex-1 overflow-y-auto p-4">
        {reviews.map((review) => (
          <div
            key={review.id}
            className={`mb-3 rounded-lg border p-3 ${getStatusColor(review.status)}`}
          >
            <div className="mb-2 flex items-start justify-between">
              <div className="flex items-center gap-2">
                {getSeverityIcon(review.severity)}
                <span className="text-sm font-medium text-text">
                  {review.file}:{review.line}
                </span>
              </div>
              <span className="text-xs text-muted">{getStatusLabel(review.status)}</span>
            </div>
            <p className="mb-3 text-sm text-text">{review.comment}</p>
            {review.status === "pending" && (
              <div className="flex gap-2">
                <button className="flex-1 rounded bg-green-500/10 px-3 py-1 text-xs font-medium text-green-500 hover:bg-green-500/20">
                  通过
                </button>
                <button className="flex-1 rounded bg-red-500/10 px-3 py-1 text-xs font-medium text-red-500 hover:bg-red-500/20">
                  拒绝
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="border-t border-border-subtle p-3">
        <div className="flex gap-2">
          <button className="flex-1 rounded bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90">
            全部通过
          </button>
          <button className="flex-1 rounded border border-border-subtle px-3 py-1.5 text-xs font-medium text-text hover:bg-bg">
            提交审查
          </button>
        </div>
      </div>
    </div>
  );
}
