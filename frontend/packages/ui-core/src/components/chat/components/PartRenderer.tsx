/**
 * Part 分发渲染器
 * 根据 part.type 分发到对应的渲染组件
 */

import type { UnifiedMessagePart } from '@ergatai/platform-core';
import {
  isTextPart,
  isReasoningPart,
  isToolInvocationPart,
  isMentionPart,
  isTaskRefPart,
  isActivityCardPart,
  isApprovalPart,
  isFilePart,
  isArtifactPart,
  isSystemNoticePart,
} from '@ergatai/platform-core';
import type { ChatPanelFeatures } from '../ChatPanel.types';
import { MarkdownContent } from '../../MarkdownContent';
import { MentionBlock, TaskRefCard, ActivityCard, ApprovalCard } from '../blocks';

interface PartRendererProps {
  part: UnifiedMessagePart;
  messageId: string;
  features: ChatPanelFeatures;
  onMentionClick?: (agentId: string) => void;
  onTaskClick?: (taskId: string) => void;
  onApprovalAction?: (approvalId: string, action: 'approve' | 'reject') => void;
}

export function PartRenderer({
  part,
  features,
  onMentionClick,
  onTaskClick,
  onApprovalAction,
}: Omit<PartRendererProps, 'messageId'>) {
  // 文本部分
  if (isTextPart(part)) {
    return (
      <MarkdownContent
        content={part.content}
        className="text-[14px] leading-[1.7] text-text"
      />
    );
  }

  // 推理部分
  if (isReasoningPart(part)) {
    // TODO: 迁移 ReasoningBlock 组件
    return (
      <div className="rounded-lg bg-elevated/50 px-3 py-2 text-[13px] text-muted italic">
        {part.content}
      </div>
    );
  }

  // 工具调用部分
  if (isToolInvocationPart(part)) {
    if (!features.regeneration) return null;
    // TODO: 迁移 ToolGroupBlock 组件
    return (
      <div className="rounded-lg bg-elevated/50 px-3 py-2 text-[12px]">
        <div className="font-mono font-medium text-text">
          {part.toolInvocation.toolName}
        </div>
        <div className="text-muted">
          State: {part.toolInvocation.state}
        </div>
      </div>
    );
  }

  // @提及部分
  if (isMentionPart(part)) {
    if (!features.mentions) return null;
    return <MentionBlock part={part} onAgentClick={onMentionClick} />;
  }

  // 任务引用部分
  if (isTaskRefPart(part)) {
    if (!features.taskReferences) return null;
    return <TaskRefCard part={part} onTaskClick={onTaskClick} />;
  }

  // 活动卡片部分
  if (isActivityCardPart(part)) {
    if (!features.activityCards) return null;
    return <ActivityCard part={part} />;
  }

  // 审批部分
  if (isApprovalPart(part)) {
    if (!features.approvals) return null;
    return <ApprovalCard part={part} onApprovalAction={onApprovalAction} />;
  }

  // 文件部分
  if (isFilePart(part)) {
    // TODO: 迁移 FileBlock 组件
    const isImage = part.file.mimeType.startsWith('image/');
    if (isImage) {
      return (
        <img
          src={part.file.url}
          alt={part.file.name}
          className="max-h-[220px] max-w-full rounded-lg object-cover"
        />
      );
    }
    return (
      <a
        href={part.file.url}
        download={part.file.name}
        className="flex items-center gap-2 rounded-lg bg-elevated px-3 py-2 text-sm text-text hover:bg-hover"
      >
        📎 {part.file.name}
      </a>
    );
  }

  // 产出物部分
  if (isArtifactPart(part)) {
    // TODO: 创建 ArtifactBlock 组件
    return (
      <div className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm">
        <div className="font-medium text-text">{part.artifact.title}</div>
        <div className="text-xs text-muted">{part.artifact.type}</div>
      </div>
    );
  }

  // 系统通知部分
  if (isSystemNoticePart(part)) {
    // TODO: 创建 SystemNoticeBlock 组件
    return (
      <div className="flex justify-center">
        <span className="rounded-full bg-bg px-3 py-1 text-xs text-muted">
          {part.content}
        </span>
      </div>
    );
  }

  // 未知类型
  console.warn('[PartRenderer] Unknown part type:', part);
  return null;
}
