"use client"

import { memo, useCallback, useMemo, useRef } from "react"
import { useAtom, useAtomValue } from "jotai"
import { useTheme } from "next-themes"
import { fullThemeDataAtom } from "@/lib/atoms"
import { ArrowUpRight, TerminalSquare, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PlusIcon } from "@/components/ui/icons"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Kbd } from "@/components/ui/kbd"
import { useResolvedHotkeyDisplay } from "@/lib/hotkeys"
import { getDefaultTerminalBg } from "@/features/terminal/helpers"
import {
  terminalsAtom,
  activeTerminalIdAtom,
} from "@/features/terminal/atoms"
import type { TerminalInstance } from "@/features/terminal/types"
import { cn } from "@/lib/utils"
import { killTerminalSession } from "@/features/terminal/providers"

interface TerminalWidgetProps {
  /** Must match the TerminalSidebar scope key so tasks map 1:1 to sidebar terminals */
  scopeKey: string
  onExpand?: () => void
}

function generateTerminalId(): string {
  return crypto.randomUUID().slice(0, 8)
}

function generatePaneId(scopeKey: string, terminalId: string): string {
  return `${scopeKey}:term:${terminalId}`
}

function getNextTerminalName(terminals: TerminalInstance[]): string {
  const existingNumbers = terminals
    .map((t) => {
      const match = t.name.match(/^Terminal (\d+)$/)
      return match ? parseInt(match[1], 10) : 0
    })
    .filter((n) => n > 0)

  const maxNumber =
    existingNumbers.length > 0 ? Math.max(...existingNumbers) : 0
  return `Terminal ${maxNumber + 1}`
}

/**
 * Terminal tasks widget for the Details sidebar.
 * Lists the chat's terminal sessions (same scope key as TerminalSidebar);
 * clicking a task enters the real terminal (expanded sidebar) to view
 * live output and interact with it. No terminal is auto-created.
 */
export const TerminalWidget = memo(function TerminalWidget({
  scopeKey,
  onExpand,
}: TerminalWidgetProps) {
  const [allTerminals, setAllTerminals] = useAtom(terminalsAtom)
  const [allActiveIds, setAllActiveIds] = useAtom(activeTerminalIdAtom)

  // Theme detection for header background
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === "dark"
  const fullThemeData = useAtomValue(fullThemeDataAtom)

  const toggleTerminalHotkey = useResolvedHotkeyDisplay("toggle-terminal")

  const terminalBg = useMemo(() => {
    if (fullThemeData?.colors?.["terminal.background"]) {
      return fullThemeData.colors["terminal.background"]
    }
    if (fullThemeData?.colors?.["editor.background"]) {
      return fullThemeData.colors["editor.background"]
    }
    return getDefaultTerminalBg(isDark)
  }, [isDark, fullThemeData])

  const terminals = useMemo(
    () => allTerminals[scopeKey] || [],
    [allTerminals, scopeKey],
  )

  const activeTerminalId = useMemo(
    () => allActiveIds[scopeKey] || null,
    [allActiveIds, scopeKey],
  )

  const scopeKeyRef = useRef(scopeKey)
  scopeKeyRef.current = scopeKey
  const terminalsRef = useRef(terminals)
  terminalsRef.current = terminals

  const createTerminal = useCallback(() => {
    const currentScopeKey = scopeKeyRef.current
    const currentTerminals = terminalsRef.current

    const id = generateTerminalId()
    const paneId = generatePaneId(currentScopeKey, id)
    const name = getNextTerminalName(currentTerminals)

    const newTerminal: TerminalInstance = {
      id,
      paneId,
      name,
      createdAt: Date.now(),
    }

    setAllTerminals((prev) => ({
      ...prev,
      [currentScopeKey]: [...(prev[currentScopeKey] || []), newTerminal],
    }))

    setAllActiveIds((prev) => ({
      ...prev,
      [currentScopeKey]: id,
    }))
  }, [setAllTerminals, setAllActiveIds])

  // Enter a terminal task: make it active and open the real terminal
  const enterTerminal = useCallback(
    (id: string) => {
      const currentScopeKey = scopeKeyRef.current
      setAllActiveIds((prev) => ({
        ...prev,
        [currentScopeKey]: id,
      }))
      onExpand?.()
    },
    [setAllActiveIds, onExpand],
  )

  const handleCreateAndEnter = useCallback(() => {
    createTerminal()
    onExpand?.()
  }, [createTerminal, onExpand])

  const closeTerminal = useCallback(
    (id: string) => {
      const currentScopeKey = scopeKeyRef.current
      const currentTerminals = terminalsRef.current

      const terminal = currentTerminals.find((t) => t.id === id)
      if (!terminal) return

      void killTerminalSession({ paneId: terminal.paneId }).catch((error) => {
        console.error("Failed to kill terminal:", error)
      })

      const newTerminals = currentTerminals.filter((t) => t.id !== id)
      setAllTerminals((prev) => ({
        ...prev,
        [currentScopeKey]: newTerminals,
      }))

      if (allActiveIds[currentScopeKey] === id) {
        setAllActiveIds((prev) => ({
          ...prev,
          [currentScopeKey]: newTerminals[newTerminals.length - 1]?.id || null,
        }))
      }
    },
    [allActiveIds, setAllTerminals, setAllActiveIds],
  )

  return (
    <div className="mx-2 mb-2">
      <div className="rounded-lg border border-border/50 overflow-hidden">
        {/* Header */}
        <div
          className="flex items-center gap-1 pl-2 pr-1 py-1.5 select-none group"
          style={{ backgroundColor: terminalBg }}
        >
          <TerminalSquare className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          <span className="flex-1 text-xs font-medium text-muted-foreground">
            Terminal
          </span>

          {/* Expand to real terminal — placed before + so + sits at the right
              edge, aligned with the per-row close buttons */}
          {onExpand && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onExpand}
                  className="h-6 w-6 p-0 hover:bg-foreground/10 text-muted-foreground hover:text-foreground rounded-md transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] flex-shrink-0"
                  aria-label="Open terminal"
                >
                  <ArrowUpRight className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                Open terminal
                {toggleTerminalHotkey && <Kbd>{toggleTerminalHotkey}</Kbd>}
              </TooltipContent>
            </Tooltip>
          )}

          {/* New terminal task */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCreateAndEnter}
                className="h-6 w-6 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] rounded-md flex-shrink-0"
                aria-label="New terminal"
              >
                <PlusIcon className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">New terminal</TooltipContent>
          </Tooltip>
        </div>

        {/* Terminal task list */}
        <div className="min-h-0">
          {terminals.length === 0 ? (
            <button
              type="button"
              onClick={handleCreateAndEnter}
              className="flex w-full items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <PlusIcon className="h-3 w-3" />
              New terminal task
            </button>
          ) : (
            terminals.map((terminal) => (
              <div
                key={terminal.id}
                className="group/task flex items-center gap-1 pr-1 transition-colors hover:bg-muted/50"
              >
                <button
                  type="button"
                  onClick={() => enterTerminal(terminal.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left"
                >
                  <TerminalSquare
                    className={cn(
                      "h-3 w-3 flex-shrink-0",
                      terminal.id === activeTerminalId
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  />
                  <span
                    className={cn(
                      "truncate text-xs",
                      terminal.id === activeTerminalId
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {terminal.name}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Close ${terminal.name}`}
                  onClick={() => closeTerminal(terminal.id)}
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
})
