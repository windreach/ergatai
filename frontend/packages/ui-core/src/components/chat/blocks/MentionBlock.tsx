import { memo } from 'react';
import type { MentionPart } from '@ergatai/platform-core';
import { cn } from '../../../lib/utils';

interface MentionBlockProps {
  part: MentionPart;
  onAgentClick?: (agentId: string) => void;
  className?: string;
}

/**
 * Mention 组件 - 渲染 @agent 提及
 * 用于群聊中标记和快速跳转到特定 agent
 */
export const MentionBlock = memo(function MentionBlock({
  part,
  onAgentClick,
  className,
}: MentionBlockProps) {
  return (
    <button
      type="button"
      onClick={() => onAgentClick?.(part.mention.agentId)}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-sm font-medium transition-colors',
        'bg-primary/10 text-primary hover:bg-primary/20',
        className,
      )}
    >
      <span>@</span>
      <span>{part.mention.agentName}</span>
    </button>
  );
});
