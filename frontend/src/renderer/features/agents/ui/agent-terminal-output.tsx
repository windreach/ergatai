"use client"

import { useEffect, useRef } from "react"
import { Terminal as XTerm } from "xterm"
import { FitAddon } from "@xterm/addon-fit"
import { useTheme } from "next-themes"
import "xterm/css/xterm.css"

interface AgentTerminalOutputProps {
  content: string
  className?: string
}

export function AgentTerminalOutput({ content, className }: AgentTerminalOutputProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    if (!containerRef.current) return

    const isDark = resolvedTheme === "dark"
    const term = new XTerm({
      convertEol: true,
      fontSize: 12,
      cursorBlink: false,
      disableStdin: true,
      theme: {
        background: isDark ? "#1e1e1e" : "#ffffff",
        foreground: isDark ? "#d4d4d4" : "#1f2937",
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // ignore
      }
    })
    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [resolvedTheme])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.reset()
    term.write(content || "")
    try {
      fitRef.current?.fit()
    } catch {
      // ignore
    }
  }, [content])

  return <div ref={containerRef} className={className ?? "h-40 w-full"} />
}
