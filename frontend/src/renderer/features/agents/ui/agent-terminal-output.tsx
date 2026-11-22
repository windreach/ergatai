"use client"

import { useEffect, useMemo, useRef } from "react"
import { Terminal as XTerm, type ITheme } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { useTheme } from "next-themes"
import "@xterm/xterm/css/xterm.css"

interface AgentTerminalOutputProps {
  content: string
  className?: string
  /** Terminal colors, so read-only output matches the real terminal panel. */
  theme?: ITheme
  fontSize?: number
  fontFamily?: string
  lineHeight?: number
}

export function AgentTerminalOutput({
  content,
  className,
  theme,
  fontSize = 12,
  fontFamily,
  lineHeight,
}: AgentTerminalOutputProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const writtenRef = useRef("")
  const { resolvedTheme } = useTheme()

  const fallbackTheme = useMemo<ITheme>(
    () => ({
      background: resolvedTheme === "dark" ? "#1e1e1e" : "#ffffff",
      foreground: resolvedTheme === "dark" ? "#d4d4d4" : "#1f2937",
    }),
    [resolvedTheme],
  )
  const terminalTheme = theme ?? fallbackTheme

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      convertEol: true,
      fontSize,
      fontFamily,
      lineHeight,
      cursorBlink: false,
      disableStdin: true,
      theme: terminalTheme,
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
      writtenRef.current = ""
    }
  }, [terminalTheme, fontSize, fontFamily, lineHeight])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const previous = writtenRef.current
    if (content.startsWith(previous)) {
      const delta = content.slice(previous.length)
      if (delta) term.write(delta)
    } else {
      term.reset()
      term.write(content || "")
    }
    writtenRef.current = content
    try {
      fitRef.current?.fit()
    } catch {
      // ignore
    }
  }, [content, terminalTheme, fontSize, fontFamily, lineHeight])

  return <div ref={containerRef} className={className ?? "h-40 w-full"} />
}
