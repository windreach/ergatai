// Why Did You Render - MUST be first import (before React)
import "./wdyr"

import ReactDOM from "react-dom/client"
import { App } from "./App"
import "./styles/globals.css"
import { preloadDiffHighlighter } from "./lib/themes/diff-view-highlighter"
import {
  migrateStorageKey,
  migrateWindowScopedStorageKey,
} from "./lib/window-storage"

// Preload shiki highlighter for diff view (prevents delay when opening diff sidebar)
preloadDiffHighlighter()

migrateWindowScopedStorageKey("agents-conversations-mode", "agents-subchats-mode")
migrateStorageKey(
  "agents-conversations-sidebar-width",
  "agents-subchats-sidebar-width",
)

// Suppress ResizeObserver loop error - this is a non-fatal browser warning
// that can occur when layout changes trigger observation callbacks
// Common with virtualization libraries and diff viewers
const resizeObserverErr = /ResizeObserver loop/

// Handle both error event and unhandledrejection
window.addEventListener("error", (e) => {
  if (e.message && resizeObserverErr.test(e.message)) {
    e.stopImmediatePropagation()
    e.preventDefault()
    return false
  }
})

// Also override window.onerror for broader coverage
const originalOnError = window.onerror
window.onerror = (message, source, lineno, colno, error) => {
  if (typeof message === "string" && resizeObserverErr.test(message)) {
    return true // Suppress the error
  }
  // Log "Cannot read properties of undefined" errors with full stack trace
  if (typeof message === "string" && message.includes("Cannot read properties of undefined")) {
    console.error("🔴 CRITICAL ERROR: Cannot read properties of undefined")
    console.error("Message:", message)
    console.error("Source:", source)
    console.error("Line:", lineno, "Column:", colno)
    if (error) {
      console.error("Stack:", error.stack)
    }
    console.trace("Error location trace")
  }
  if (originalOnError) {
    return originalOnError(message, source, lineno, colno, error)
  }
  return false
}

const rootElement = document.getElementById("root")

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(<App />)
}
