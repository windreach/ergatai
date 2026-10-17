"use client"

import { useMemo } from "react"
import { AnimatePresence } from "motion/react"
import { createPortal } from "react-dom"
import { useAtomValue } from "jotai"
import { loadingConversationsAtom } from "../atoms"
import { AgentChatCard } from "./agent-chat-card"

interface AgentsQuickSwitchDialogProps {
  isOpen: boolean
  chats: Array<{
    id: string
    name: string | null
    meta: any
    sandbox_id: string | null
    updated_at: Date
    projectId: string | null
  }>
  selectedIndex: number
  projectsMap: Map<string, { gitOwner?: string | null; gitProvider?: string | null; gitRepo?: string | null; name: string }>
  onHover?: (index: number) => void
}

export function AgentsQuickSwitchDialog({
  isOpen,
  chats,
  selectedIndex,
  projectsMap,
  onHover,
}: AgentsQuickSwitchDialogProps) {
  if (typeof window === "undefined") return null

  // Derive loading parent chat IDs from loadingConversations Map
  const loadingConversations = useAtomValue(loadingConversationsAtom)
  const loadingChatIds = useMemo(
    () => new Set([...loadingConversations.values()]),
    [loadingConversations],
  )

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
                {/* Chat List or Empty State */}
                {chats.length === 0 ? (
                  <div className="px-4 py-12 text-center bg-background rounded-xl border-[0.5px]">
                    <p className="text-sm text-muted-foreground">
                      No recent agents
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
                    {chats.map((chat, index) => {
                      const isSelected = index === selectedIndex
                      const isLoading = loadingChatIds.has(chat.id)
                      const project = chat.projectId ? projectsMap.get(chat.projectId) : null

                      return (
                        <AgentChatCard
                          key={chat.id}
                          chat={chat}
                          isSelected={isSelected}
                          isLoading={isLoading}
                          variant="quick-switch"
                          gitOwner={project?.gitOwner}
                          gitProvider={project?.gitProvider}
                          repoName={project?.gitRepo || project?.name}
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
