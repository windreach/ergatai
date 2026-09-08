import { memo } from 'react';
import type { ActivityCardPart } from '@ergatai/platform-core';
import { cn } from '../../../lib/utils';

interface ActivityCardProps {
  part: ActivityCardPart;
  className?: string;
}

/**
 * 活动卡片
 * 展示 agent 实时活动状态（运行中/完成/警告等）
 */
export const ActivityCard = memo(function ActivityCard({
  part,
  className,
}: ActivityCardProps) {
  const { activityCard } = part;

  const statusColors = {
    info: 'bg-blue-500/10 text-blue-600',
    success: 'bg-green-500/10 text-green-600',
    warning: 'bg-amber-500/10 text-amber-600',
    error: 'bg-red-500/10 text-red-600',
  };

  const statusLabels = {
    info: '运行中',
    success: '已完成',
    warning: '警告',
    error: '错误',
  };

  return (
    <div
      className={cn(
        'w-full max-w-[680px] overflow-hidden rounded-xl border border-border-subtle bg-surface',
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
        <h3 className="text-sm font-medium text-text">{activityCard.title}</h3>
        <span className={cn('rounded-full px-2 py-0.5 text-xs', statusColors[activityCard.status])}>
          {statusLabels[activityCard.status]}
        </span>
      </div>

      {/* Description */}
      {activityCard.description && (
        <div className="px-4 py-3 text-sm text-text">
          {activityCard.description}
        </div>
      )}
    </div>
  );
});
