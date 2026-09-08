import { memo } from 'react';
import type { TaskRefPart } from '@ergatai/platform-core';
import { cn } from '../../../lib/utils';

interface TaskRefCardProps {
  part: TaskRefPart;
  onTaskClick?: (taskId: string) => void;
  className?: string;
}

/**
 * 任务引用卡片
 * 显示关联的任务信息，点击可跳转到任务详情
 */
export const TaskRefCard = memo(function TaskRefCard({
  part,
  onTaskClick,
  className,
}: TaskRefCardProps) {
  const { taskRef } = part;

  const statusColors = {
    pending: 'bg-amber-500/10 text-amber-600',
    running: 'bg-blue-500/10 text-blue-600',
    completed: 'bg-green-500/10 text-green-600',
    failed: 'bg-red-500/10 text-red-600',
  };

  const statusLabels = {
    pending: '待处理',
    running: '进行中',
    completed: '已完成',
    failed: '失败',
  };

  return (
    <button
      type="button"
      onClick={() => onTaskClick?.(taskRef.taskId)}
      className={cn(
        'block w-fit rounded-lg border border-border-subtle bg-surface px-3 py-2 text-left transition-all',
        'hover:border-primary/50 hover:shadow-sm',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">关联任务</span>
        <span className={cn('rounded-full px-2 py-0.5 text-xs', statusColors[taskRef.status])}>
          {statusLabels[taskRef.status]}
        </span>
      </div>
      <div className="mt-1 font-medium text-text">{taskRef.title}</div>
    </button>
  );
});
