"use client"

import { useEffect, useState } from "react"
import { Minus, Square, X, ChevronLeft, ChevronRight, PanelLeft } from "lucide-react"
import { Button } from "./ui/button"

/**
 * Windows title bar component for frameless windows
 * Provides window controls (minimize, maximize, close) and drag region
 *
 * Only shown on Windows when using frameless window (useNativeFrame = false)
 */
interface WindowsTitleBarProps {
  onToggleSidebar?: () => void
  sidebarOpen?: boolean
  onBack?: () => void
  onForward?: () => void
  canBack?: boolean
  canForward?: boolean
  pageTitle?: string
}

export function WindowsTitleBar({
  onToggleSidebar,
  sidebarOpen,
  onBack,
  onForward,
  canBack = false,
  canForward = false,
  pageTitle,
}: WindowsTitleBarProps = {}) {
  const [isMaximized, setIsMaximized] = useState(false)
  const [hasNativeFrame, setHasNativeFrame] = useState(false)

  const isWindows =
    typeof window !== "undefined" && window.desktopApi?.platform === "win32"
  const isLinux =
    typeof window !== "undefined" && window.desktopApi?.platform === "linux"
  const isMac =
    typeof window !== "undefined" && window.desktopApi?.platform === "darwin"
  const isCustomTitleBar = isWindows || isLinux || isMac
  const showWindowControls = isWindows || isLinux

  // Check actual window frame state
  useEffect(() => {
    if (!isCustomTitleBar || !window.desktopApi?.getWindowFrameState) return

    const checkFrameState = async () => {
      try {
        const hasFrame = await window.desktopApi.getWindowFrameState()
        setHasNativeFrame(hasFrame)
      } catch {
        setHasNativeFrame(false)
      }
    }

    checkFrameState()
  }, [isCustomTitleBar])

  // Check window maximized state
  useEffect(() => {
    if (!isCustomTitleBar || !window.desktopApi?.windowIsMaximized) return

    const checkMaximized = async () => {
      const maximized = await window.desktopApi.windowIsMaximized()
      setIsMaximized(maximized)
    }

    checkMaximized()

    const handleFocus = () => checkMaximized()
    window.addEventListener("focus", handleFocus)
    return () => window.removeEventListener("focus", handleFocus)
  }, [isCustomTitleBar])

  // Don't render on non-Windows or when using native frame
  if (!isCustomTitleBar || hasNativeFrame) return null

  const handleMinimize = async () => {
    await window.desktopApi?.windowMinimize()
  }

  const handleMaximize = async () => {
    await window.desktopApi?.windowMaximize()
    setTimeout(async () => {
      const maximized = await window.desktopApi?.windowIsMaximized()
      setIsMaximized(maximized ?? false)
    }, 100)
  }

  const handleClose = async () => {
    await window.desktopApi?.windowClose()
  }

  // macOS traffic light buttons width + padding
  const MAC_TRAFFIC_LIGHTS_WIDTH = 70

  return (
    <div
      className="h-8 flex-shrink-0 flex items-center justify-between bg-tl-background"
      style={{
        // @ts-expect-error - WebKit-specific property for Electron window dragging
        WebkitAppRegion: "drag",
      }}
    >
      {/* Left side - navigation + collapse (draggable) */}
      <div
        className="flex items-center gap-1 px-2 h-full"
        style={{
          // @ts-expect-error - WebKit-specific property for Electron window dragging
          WebkitAppRegion: "no-drag",
          paddingLeft: isMac ? MAC_TRAFFIC_LIGHTS_WIDTH : undefined,
        }}
      >
        {onToggleSidebar && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleSidebar}
            className="h-6 w-6 rounded-md hover:bg-foreground/10"
            aria-label="Toggle sidebar"
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          disabled={!canBack}
          className="h-6 w-6 rounded-md hover:bg-foreground/10 disabled:opacity-40"
          aria-label="Back"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onForward}
          disabled={!canForward}
          className="h-6 w-6 rounded-md hover:bg-foreground/10 disabled:opacity-40"
          aria-label="Forward"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        {pageTitle && (
          <span className="ml-2 text-xs font-medium text-foreground/70 truncate max-w-[240px]">
            {pageTitle}
          </span>
        )}
      </div>

      {/* Right side - Window controls (non-draggable) */}
      {showWindowControls && (
      <div
        className="flex items-center h-full"
        style={{
          // @ts-expect-error - WebKit-specific property
          WebkitAppRegion: "no-drag",
        }}
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={handleMinimize}
          className="h-full w-10 rounded-none hover:bg-foreground/10"
          aria-label="Minimize"
        >
          <Minus className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleMaximize}
          className="h-full w-10 rounded-none hover:bg-foreground/10"
          aria-label={isMaximized ? "Restore" : "Maximize"}
        >
          <Square className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleClose}
          className="h-full w-10 rounded-none hover:bg-red-500/20 hover:text-red-500"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      )}
    </div>
  )
}
