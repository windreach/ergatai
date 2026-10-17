"use client"

import { useMemo } from "react"
import { AnimatePresence } from "motion/react"
import { createPortal } from "react-dom"
import { useAtomValue } from "jotai"
import { cn } from "../../../lib/utils"
import {
  loadingConversationsAtom,
  agentsConversationUnseenChangesAtom,
  conversationFilesAtom,
  type ConversationFileChange,
} from "../atoms"
import { IconSpinner, PlanIcon, AgentIcon } from "../../../components/ui/icons"
import type { ConversationMeta } from "../stores/conversation-store"
import { formatTimeAgo } from "../utils/format-time-ago"

interface ConversationsQuickSwitchDialogProps {
  isOpen: boolean
  conversations: ConversationMeta[]
  selectedIndex: number
  onHover?: (index: number) => void
}

// Conversation card for quick switch
function ConversationCard({
  conversation,
  isSelected,
  isLoading,
  hasUnseenChanges,
  fileChanges,
  onMouseEnter,
}: {
  conversation?: ConversationMeta
  isSelected: boolean
  isLoading: boolean
  hasUnseenChanges: boolean
  fileChanges: ConversationFileChange[]
  onMouseEnter?: () => void
}) {
  const mode = conversation?.mode || "agent"
  const timeAgo = formatTimeAgo(conversation?.updated_at || conversation?.created_at)

  // Calculate totals from file changes
  const stats = useMemo(() => {
    if (!fileChanges || fileChanges.length === 0) return null
    let additions = 0
    let deletions = 0
    for (const file of fileChanges) {
      additions += file.additions
      deletions += file.deletions
    }
    return { fileCount: fileChanges.length, additions, deletions }
  }, [fileChanges])

  return (
    <div
      onMouseEnter={onMouseEnter}
      className={cn(
        "relative rounded-2xl overflow-hidden min-w-[160px] max-w-[180px] p-2 cursor-pointer",
        isSelected ? "bg-primary shadow-lg" : "bg-transparent",
      )}
    >
      <div className="flex items-start gap-2.5">
        {/* Mode icon with badge */}
        <div className="pt-0.5 relative flex-shrink-0 h-4 w-4">
          {mode === "plan" ? (
            <PlanIcon
              className={cn(
                "w-4 h-4",
                isSelected
                  ? "text-primary-foreground"
                  : "text-muted-foreground",
              )}
            />
          ) : (
            <AgentIcon
              className={cn(
                "w-4 h-4",
                isSelected
                  ? "text-primary-foreground"
                  : "text-muted-foreground",
              )}
            />
          )}
          {/* Badge in bottom-right corner */}
          {(isLoading || hasUnseenChanges) && (
            <div
              className={cn(
                "absolute -bottom-1 -right-1 w-3 h-3 rounded-full flex items-center justify-center",
                isSelected ? "bg-primary" : "bg-background",
              )}
            >
              {isLoading ? (
                <IconSpinner
                  className={cn(
                    "w-2.5 h-2.5",
                    isSelected
                      ? "text-primary-foreground"
                      : "text-muted-foreground",
                  )}
                />
              ) : (
                <div className="w-2 h-2 rounded-full bg-[#307BD0]" />
              )}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          {/* Conversation name */}
          <span
            className={cn(
              "truncate block text-sm leading-tight",
              isSelected ? "text-primary-foreground" : "text-foreground",
            )}
          >
            {conversation?.name || "New Chat"}
          </span>
          {/* Time and stats */}
          <div className="flex items-center gap-1.5 text-[11px]">
            <span
              className={cn(
                isSelected
                  ? "text-primary-foreground/60"
                  : "text-muted-foreground/60",
              )}
            >
              {timeAgo}
            </span>
            {stats && (
              <>
                <span
                  className={cn(
                    isSelected
                      ? "text-primary-foreground/40"
                      : "text-muted-foreground/40",
                  )}
                >
                  ·
                </span>
                <span
                  className={cn(
                    isSelected
                      ? "text-primary-foreground/60"
                      : "text-muted-foreground/60",
                  )}
                >
                  {stats.fileCount} {stats.fileCount === 1 ? "file" : "files"}
                </span>
                {(stats.additions > 0 || stats.deletions > 0) && (
                  <>
                    <span
                      className={cn(
                        isSelected
                          ? "text-primary-foreground/80"
                          : "text-green-600 dark:text-green-400",
                      )}
                    >
                      +{stats.additions}
                    </span>
                    <span
                      className={cn(
                        isSelected
                          ? "text-primary-foreground/80"
                          : "text-red-600 dark:text-red-400",
                      )}
                    >
                      -{stats.deletions}
                    </span>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function ConversationsQuickSwitchDialog({
  isOpen,
  conversations,
  selectedIndex,
  onHover,
}: ConversationsQuickSwitchDialogProps) {
  if (typeof window === "undefined") return null

  // Derive loading conversation IDs
  const loadingConversations = useAtomValue(loadingConversationsAtom)
  const loadingConversationIds = useMemo(
    () => new Set([...loadingConversations.keys()]),
    [loadingConversations],
  )

  // Unseen changes
  const unseenChanges = useAtomValue(agentsConversationUnseenChangesAtom)

  // File changes per conversation
  const conversationFiles = useAtomValue(conversationFilesAtom)

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-[10000]" />

          {/* Dialog */}
          <div className="fixed inset-0 flex items-center justify-center z-[10001] p-4 pointer-events-none">
            <div className="pointer-events-auto">
              <div className="max-w-5xl mx-auto">
                {/* Conversation List or Empty State */}
                {conversations.length === 0 ? (
                  <div className="px-4 py-12 text-center bg-background rounded-xl border-[0.5px]">
                    <p className="text-sm text-muted-foreground">
                      No chats in this agent
                    </p>
                  </div>
                ) : (
                  <div
                    className="flex gap-3 overflow-x-auto p-3 bg-background rounded-3xl border-[0.5px]"
                    style={{
                      boxShadow:
                        "0 8px 32px 0 rgba(0,0,0,0.07), 0 0px 16px 0 rgba(0,0,0,0.04), 0 -8px 24px 0 rgba(0,0,0,0.03)",
                    }}
                  >
                    {conversations.map((conversation, index) => {
                      const isSelected = index === selectedIndex
                      const isLoading = loadingConversationIds.has(conversation?.id)
                      const hasUnseenChanges = unseenChanges.has(conversation?.id)
                      const fileChanges = conversationFiles.get(conversation?.id) || []

                      return (
                        <ConversationCard
                          key={conversation?.id}
                          conversation={conversation}
                          isSelected={isSelected}
                          isLoading={isLoading}
                          hasUnseenChanges={hasUnseenChanges}
                          fileChanges={fileChanges}
                          onMouseEnter={() => onHover?.(index)}
                        />
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}
