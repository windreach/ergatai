import i18n from "@/lib/i18n"
"use client"

import { useAtomValue } from "jotai"
import { Square } from "lucide-react"
// react-doctor-disable-next-line use-lazy-motion
import { AnimatePresence, motion } from "motion/react"
import { memo, useEffect, useState } from "react"
import { Button } from "../../../components/ui/button"
import { cn } from "../../../lib/utils"
import { useExtensionMeta } from "../lib/extension-meta-store"
// TODO(subagent): temporarily not consumed. Subagent rail rendering disabled.
// import {
//   useSubagentRuns,
//   selectedSubagentSessionIdAtomFamily,
// } from "../lib/subagent-message-store"

import { AgentTerminalOutput } from "./agent-terminal-output"
import { agentStatusLineAtomFamily } from "../atoms"
// Removed Resume/history selector; restore status display in the status card header.
// import { AgentHistorySelector } from "./agent-history-selector"

// Animated dots component that cycles through ., .., ...
function AnimatedDots() {
  const [dotCount, setDotCount] = useState(1)

  useEffect(() => {
    const interval = setInterval(() => {
      setDotCount((prev) => (prev % 3) + 1)
    }, 400)
    return () => clearInterval(interval)
  }, [])

  return <span className="inline-block w-[1em] text-left">{".".repeat(dotCount)}</span>
}

interface ConversationStatusCardProps {
  agentId?: string | null
  chatId: string
  conversationId: string
  isStreaming: boolean
  isCompacting?: boolean
  onStop?: () => void
  /** Whether there's a queue card above this one - affects border radius */
  hasQueueCardAbove?: boolean
  /** Whether there's an agent rail above this one - affects border radius */
  hasAgentRailAbove?: boolean
}

// react-doctor-disable-next-line no-high-complexity-react-function
export const ConversationStatusCard = memo(function ConversationStatusCard({
  agentId,
  chatId,
  conversationId,
  isStreaming,
  isCompacting,
  onStop,
  hasQueueCardAbove = false,
  hasAgentRailAbove = false,
}: ConversationStatusCardProps) {
  const isBusy = isStreaming || isCompacting
  const agentStatusLine = useAtomValue(
    agentStatusLineAtomFamily(conversationId),
  )
  const [isRailExpanded, setIsRailExpanded] = useState(false)
  const [activeRailSection, setActiveRailSection] = useState<"subagents" | "terminal">("subagents")
  const [selectedTerminalKey, setSelectedTerminalKey] = useState<string | null>(null)
  // TODO(subagent): temporarily not consumed. Subagent rail rendering disabled.
  // const [selectedSubagentSessionId, setSelectedSubagentSessionId] = useAtom(
  //   selectedSubagentSessionIdAtomFamily(conversationId),
  // )
  // const subagentRuns = useSubagentRuns(agentId ?? null)
  //
  // useEffect(() => {
  //   if (
  //     selectedSubagentSessionId &&
  //     !subagentRuns.some((run) => run.subagentSessionId === selectedSubagentSessionId)
  //   ) {
  //     setSelectedSubagentSessionId(null)
  //   }
  // }, [subagentRuns, selectedSubagentSessionId])
  const subagentRuns: any[] = []
  const extensionMeta = useExtensionMeta(agentId ?? chatId)
  const terminalPayload = extensionMeta?.["terminal_update"]
  const terminalEntries = (() => {
    if (!terminalPayload || typeof terminalPayload !== "object") return []
    if (Array.isArray(terminalPayload)) {
      return terminalPayload.map((item, i) => ({ key: String(i), value: item }))
    }
    return Object.entries(terminalPayload as Record<string, unknown>).map(([k, v]) => ({ key: k, value: v }))
  })()
  // Hide status box when ready (idle, no subagents).
  if (!isBusy && subagentRuns.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        // Only animate paint properties here. Animating padding/margin (via
        // transition-all) would redo layout every frame when the rail toggles.
        "border border-border bg-muted/30 overflow-hidden flex flex-col transition-colors duration-200",
        isRailExpanded ? "pb-2" : "border-b-0 pb-6 -mb-6",
        // If queue card or agent rail above - no top radius
        hasQueueCardAbove || hasAgentRailAbove ? "rounded-none" : "rounded-t-xl"
      )}
    >
      {/* Header - at top */}
      <div className="flex items-center justify-between pr-1 pl-3 h-8 rounded-sm">
        <div className="flex items-center gap-2 text-xs min-w-0">
          {/* Status display */}
          {isBusy ? (
            <span className="text-xs text-muted-foreground">
              {isCompacting ? "Compacting" : "Generating"}<AnimatedDots />
            </span>
          ) : null}
          {agentStatusLine && (
            <span className="text-xs text-muted-foreground truncate ml-2">
              {agentStatusLine}
            </span>
          )}
        </div>

        {/* Right side: action buttons */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Stop button */}
          {isBusy && onStop && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                if (isBusy) onStop?.()
              }}
              className="h-6 px-2 text-xs font-normal rounded-md transition-transform duration-150 active:scale-[0.97] flex items-center gap-1"
              aria-label={i18n.t('Stop (Ctrl+C)')}
            >
              <Square className="h-3 w-3" />
              <span>{i18n.t('Ctrl+C')}</span>
            </Button>
          )}

          {/* Subagent rail toggle */}
          {subagentRuns.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsRailExpanded((v) => !v)}
              className="h-6 px-2 text-xs font-normal rounded-md"
              aria-label={isRailExpanded ? "Collapse subagents" : "Expand subagents"}
            >
              Subagents
            </Button>
          )}

        </div>
      </div>

      {/* Expanded rail panel */}
      <AnimatePresence initial={false}>
        {isRailExpanded && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden border-t border-border bg-background/40"
          >
            <div className="h-8 border-b border-border/40" />
            <div className="flex max-h-[calc(var(--chat-input-height,120px)+2rem)] overflow-hidden">
              <div className="w-28 shrink-0 border-r border-border/40 p-2 space-y-1">
                <button
                  type="button"
                  onClick={() => setActiveRailSection("subagents")}
                  className={cn("block w-full rounded px-2 py-1 text-left text-xs", activeRailSection === "subagents" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50")}
                >
                  Subagents
                </button>
                <button
                  type="button"
                  onClick={() => setActiveRailSection("terminal")}
                  className={cn("block w-full rounded px-2 py-1 text-left text-xs", activeRailSection === "terminal" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50")}
                >
                  Terminal
                </button>
              </div>
              <div className="flex-1 p-3 text-xs text-muted-foreground overflow-y-auto">
                {activeRailSection === "subagents" ? (
                  // TODO(subagent): temporarily not consumed.
                  <div className="text-xs text-muted-foreground">{i18n.t('Subagents temporarily disabled')}</div>
                ) : terminalEntries.length === 0 ? (
                  <div>{i18n.t('No terminal data')}</div>
                ) : (
                  <div className="space-y-2">
                    <div className="space-y-1">
                      {terminalEntries.map((entry) => (
                        <button
                          key={entry.key}
                          type="button"
                          onClick={() => setSelectedTerminalKey(entry.key)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") setSelectedTerminalKey(entry.key)
                          }}
                          className={cn(
                            "block w-full rounded px-2 py-1 text-left",
                            selectedTerminalKey === entry.key ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50",
                          )}
                        >
                          {entry.key}
                        </button>
                      ))}
                    </div>
                    {selectedTerminalKey ? (
                      <AgentTerminalOutput
                        content={(() => {
                          const value = terminalEntries.find((e) => e.key === selectedTerminalKey)?.value
                          if (typeof value === "string") return value
                          try {
                            return JSON.stringify(value ?? null, null, 2)
                          } catch {
                            return String(value)
                          }
                        })()}
                        className="h-40 w-full rounded"
                      />
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})
