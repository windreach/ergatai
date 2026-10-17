"use client"

import { useEffect, useState } from "react"
import { useAtom, useSetAtom } from "jotai"
import { ResizableSidebar } from "@/components/ui/resizable-sidebar"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { IconDoubleChevronRight } from "@/components/ui/icons"
import {
  panelLinkCommandAtomFamily,
  createPanelLinkScopeKey,
} from "@/features/panel-link"
import { sideChatSidebarOpenAtom, sideChatSidebarWidthAtom } from "../atoms"
import { SideChatView, type ActiveSideChatInfo } from "./side-chat-view"

interface SideChatSidebarProps {
  /** Workspace/chat ID */
  chatId: string
}

/**
 * Independent sidebar hosting agent side chats. Coexists with the details
 * sidebar (opened from the Agents widget / agent rail) instead of replacing
 * its content.
 */
export function SideChatSidebar({ chatId }: SideChatSidebarProps) {
  const [isOpen, setIsOpen] = useAtom(sideChatSidebarOpenAtom)
  const panelLinkScopeKey = createPanelLinkScopeKey({ chatId })
  const dispatchPanelLink = useSetAtom(
    panelLinkCommandAtomFamily(panelLinkScopeKey),
  )

  // Active side chat info reported by SideChatView (used for panel-link sync
  // and the header title)
  const [activeSideChatInfo, setActiveSideChatInfo] =
    useState<ActiveSideChatInfo | null>(null)

  useEffect(() => {
    dispatchPanelLink({
      type: "sync-panel",
      panelId: "side-chat",
      open: isOpen,
      target: activeSideChatInfo
        ? {
            kind: "chat",
            id: activeSideChatInfo.id,
            agentId: activeSideChatInfo.agent.id,
            chatId,
            metadata: { agentName: activeSideChatInfo.agent.name },
          }
        : null,
      source: "migration",
      displayMode: "chat",
    })
  }, [activeSideChatInfo, chatId, dispatchPanelLink, isOpen])

  return (
    <ResizableSidebar
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      widthAtom={sideChatSidebarWidthAtom}
      side="right"
      minWidth={280}
      maxWidth={800}
      animationDuration={0.24}
      initialWidth={0}
      exitWidth={0}
      persistContent={true}
      className="bg-tl-background border-l"
      style={{ borderLeftWidth: "0.5px", overflow: "hidden" }}
    >
      <div className="flex h-full min-w-0 flex-col overflow-hidden">
        {/* Page header */}
        <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-border/50 bg-tl-background px-2">
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setIsOpen(false)}
                  className="h-6 w-6 p-0 text-foreground flex-shrink-0 rounded-md hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97]"
                  aria-label="Close chat"
                >
                  <IconDoubleChevronRight className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Close chat</TooltipContent>
            </Tooltip>
            <span className="text-xs font-medium text-foreground">
              {activeSideChatInfo
                ? `Chat · ${activeSideChatInfo.agent.name}`
                : "Chat"}
            </span>
          </div>
        </div>

        <SideChatView
          chatId={chatId}
          isActive={isOpen}
          onActiveSideChatChange={setActiveSideChatInfo}
        />
      </div>
    </ResizableSidebar>
  )
}
