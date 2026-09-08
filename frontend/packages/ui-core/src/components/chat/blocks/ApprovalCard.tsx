import { memo } from 'react';
import type { ApprovalPart } from '@ergatai/platform-core';
import { cn } from '../../../lib/utils';

interface ApprovalCardProps {
  part: ApprovalPart;
  onApprovalAction?: (approvalId: string, action: 'approve' | 'reject') => void;
  className?: string;
}

/**
 * 审批卡片
 * 展示审批请求，支持批准/拒绝操作
 */
export const ApprovalCard = memo(function ApprovalCard({
  part,
  onApprovalAction,
  className,
}: ApprovalCardProps) {
  const { approval } = part;

  const statusColors = {
    pending: 'bg-orange-500/10 text-orange-600',
    approved: 'bg-green-500/10 text-green-600',
    rejected: 'bg-red-500/10 text-red-600',
  };

  const statusLabels = {
    pending: '待审批',
    approved: '已批准',
    rejected: '已拒绝',
  };

  return (
    <div
      className={cn(
        'w-full max-w-[520px] rounded-xl border',
        approval.status === 'pending'
          ? 'border-orange-500/30 bg-orange-500/5'
          : 'border-border-subtle bg-surface',
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3">
        <h3 className="text-sm font-medium text-text">{approval.title}</h3>
        <span className={cn('rounded-full px-2 py-0.5 text-xs', statusColors[approval.status])}>
          {statusLabels[approval.status]}
        </span>
      </div>

      {/* Description */}
      {approval.description && (
        <div className="px-4 pb-3 text-sm text-muted">
          {approval.description}
        </div>
      )}

      {/* Actions */}
      {approval.status === 'pending' && (
        <div className="flex gap-2 px-4 pb-3">
          <button
            type="button"
            onClick={() => onApprovalAction?.(approval.approvalId, 'approve')}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-primary/90"
          >
            批准
          </button>
          <button
            type="button"
            onClick={() => onApprovalAction?.(approval.approvalId, 'reject')}
            className="rounded-md border border-red-500/30 px-2.5 py-1 text-xs text-red-500 transition-colors hover:bg-red-500/10"
          >
            拒绝
          </button>
        </div>
      )}
    </div>
  );
});
