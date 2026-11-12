"use client"

import { cn } from "../../../lib/utils"
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  memo,
} from "react"
import { createFileIconElement } from "./file-icon-utils"
import { buildGenericMentionToken, MENTION_PREFIXES } from "./mentions-utils"
import {
  type AgentNativeTrigger,
  type AgentTriggerMatch,
  matchAgentTriggers,
} from "../../mentions"

// Threshold for skipping expensive trigger detection (characters)
// Should be >= MAX_PASTE_LENGTH from paste-text.ts to avoid processing large pasted content
const LARGE_TEXT_THRESHOLD = 10000

// Maximum number of undo states to keep in the stack
const MAX_UNDO_STACK_SIZE = 100

// Undo state snapshot (html + serialized cursor offset)
interface UndoState {
  html: string
  cursorOffset: number
}

// Parse a serialized mention id (the part inside mention token brackets) into a FileMentionOption.
// Used as a fallback when resolveMention is not provided (e.g., during restore from serialized text).
function parseMentionId(id: string): FileMentionOption | null {
  if (id.startsWith(MENTION_PREFIXES.FILE) || id.startsWith(MENTION_PREFIXES.FOLDER)) {
    const parts = id.split(":")
    if (parts.length >= 3) {
      const type = parts[0] as "file" | "folder"
      const repo = parts[1]
      const path = parts.slice(2).join(":")
      const name = path.split("/").pop() || path
      return { id, label: name, path, repository: repo, type }
    }
  }
  if (id.startsWith(MENTION_PREFIXES.SKILL)) {
    const skillName = id.slice(MENTION_PREFIXES.SKILL.length)
    return { id, label: skillName, path: "", repository: "", type: "skill" }
  }
  if (id.startsWith(MENTION_PREFIXES.AGENT)) {
    const agentName = id.slice(MENTION_PREFIXES.AGENT.length)
    return { id, label: agentName, path: "", repository: "", type: "agent" }
  }
  if (id.startsWith(MENTION_PREFIXES.TOOL)) {
    const toolPath = id.slice(MENTION_PREFIXES.TOOL.length)
    if (toolPath.startsWith("mcp__")) {
      const parts = toolPath.split("__")
      const toolName = parts.length >= 3 ? parts.slice(2).join("__") : toolPath
      const displayName = toolName
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim()
      return { id, label: displayName, path: toolPath, repository: "", type: "tool" }
    }
    return { id, label: toolPath, path: toolPath, repository: "", type: "tool" }
  }
  return null
}

export interface FileMentionOption {
  id: string // file:owner/repo:path/to/file.tsx or folder:owner/repo:path/to/folder or skill:skill-name or tool:servername
  label: string // filename or folder name or skill name or tool name
  path: string // full path or skill description
  repository: string
  truncatedPath?: string // directory path for inline display or skill description
  additions?: number // for changed files
  deletions?: number // for changed files
  type?: "file" | "folder" | "skill" | "agent" | "category" | "tool" | "command" | "plugin" | "group-header" // entry type (default: file)
  group?: string // dynamic category label; items with same group render under one header
  // Extended data for rich tooltips (skills/agents/tools)
  description?: string // skill/agent/tool description
  tools?: string[] // agent allowed tools
  model?: string // agent model
  source?: "user" | "project" | "plugin" | "agent-sdk" | "convention" // skill/agent source
  mcpServer?: string // MCP server name for tools
}

type TriggerPayload = {
  searchText: string
  rect: DOMRect
  triggerChar?: string
}

// Export SlashTriggerPayload for slash commands
export type SlashTriggerPayload = TriggerPayload

export type NativeTriggerPayload = AgentTriggerMatch & {
  rect: DOMRect
}

/**
 * Trigger configuration from backend.
 * Used by walkTreeOnce to detect trigger characters dynamically.
 */
export interface EditorTriggerConfig {
  char: string
  position: "standalone" | "start-of-line" | "anywhere"
  kind?: "slash" | "mention"
}

// Default triggers (fallback when no config provided)
const DEFAULT_MENTION_TRIGGER: EditorTriggerConfig = { char: "@", position: "standalone", kind: "mention" }
const DEFAULT_SLASH_TRIGGER: EditorTriggerConfig = { char: "/", position: "start-of-line", kind: "slash" }

export type AgentsMentionsEditorHandle = {
  focus: () => void
  blur: () => void
  triggerDetection: () => void
  insertMention: (option: FileMentionOption) => void
  getValue: () => string
  setValue: (value: string) => void
  clear: () => void
  clearSlashCommand: () => void // Clear slash command text after selection
  /** Returns true if the given DOM node is inside the editor */
  contains: (node: Node) => boolean
}

type AgentsMentionsEditorProps = {
  // UNCONTROLLED: no value/onChange - use ref methods instead
  initialValue?: string // optional initial content
  onTrigger: (payload: TriggerPayload) => void
  onCloseTrigger: () => void
  onSlashTrigger?: (payload: TriggerPayload) => void // Slash command trigger
  onCloseSlashTrigger?: () => void // Close slash command dropdown
  /** Explicit native trigger allowlist; unregistered syntax stays raw. */
  nativeTriggers?: AgentNativeTrigger[]
  onNativeTrigger?: (payload: NativeTriggerPayload) => void
  onCloseNativeTrigger?: () => void
  /** Trigger config for mention dropdown (default: @ standalone) */
  mentionTrigger?: EditorTriggerConfig
  /** Trigger config for slash command dropdown (default: / start-of-line) */
  slashTrigger?: EditorTriggerConfig
  /** Additional discovery triggers (agent-specific) */
  discoveryTriggers?: EditorTriggerConfig[]
  onContentChange?: (hasContent: boolean) => void // lightweight callback for send button state
  placeholder?: string
  className?: string
  onSubmit?: () => void
  onForceSubmit?: () => void // Opt+Enter: bypass queue, stop stream and send immediately
  disabled?: boolean
  onPaste?: (e: React.ClipboardEvent) => void
  onShiftTab?: () => void // callback for Shift+Tab (e.g., mode switching)
  onFocus?: () => void
  onBlur?: () => void
}

// Append text to element (no styling in input, ultrathink only in sent messages)
function appendText(root: HTMLElement, text: string) {
  if (text) {
    root.appendChild(document.createTextNode(text))
  }
}

// Create styled mention chip (matching canvas style)
function createMentionNode(option: FileMentionOption, triggerChar: string = "@"): HTMLSpanElement {
  const span = document.createElement("span")
  span.setAttribute("contenteditable", "false")
  span.setAttribute("data-mention-id", option.id)
  span.setAttribute("data-mention-type", option.type || "file")
  span.setAttribute("data-trigger-char", triggerChar)
  span.className =
    "inline-flex items-center gap-1 px-[6px] py-[1px] rounded-[4px] text-sm align-middle bg-black/[0.04] dark:bg-white/[0.08] text-foreground/80 [&.mention-selected]:bg-primary/70 [&.mention-selected]:text-primary-foreground"

  // Create icon element (pass type for folder icon)
  const iconElement = createFileIconElement(option.label, option.type === "group-header" ? "category" : option.type)
  span.appendChild(iconElement)

  const label = document.createElement("span")
  label.textContent = option.label

  span.appendChild(label)
  return span
}

// Serialize DOM to text with mention tokens
function serializeContent(root: HTMLElement): string {
  let result = ""
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  )
  let node: Node | null = walker.nextNode()
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent || ""
      node = walker.nextNode()
      continue
    }
    const el = node as HTMLElement
    // Handle <br> elements as newlines
    if (el.tagName === "BR") {
      result += "\n"
      node = walker.nextNode()
      continue
    }
    // Handle <div> elements (some browsers wrap lines in divs)
    if (el.tagName === "DIV" && el !== root) {
      // Add newline before div content (if not at start)
      if (result.length > 0 && !result.endsWith("\n")) {
        result += "\n"
      }
      node = walker.nextNode()
      continue
    }
    // Handle ultrathink styled nodes
    if (el.hasAttribute("data-ultrathink")) {
      result += el.textContent || ""
      // Skip subtree
      const next: Node | null = el.nextSibling
      if (next) {
        walker.currentNode = next
        node = next
        continue
      }
      let parent: Node | null = el.parentNode
      while (parent && !parent.nextSibling) parent = parent.parentNode
      if (parent && parent.nextSibling) {
        walker.currentNode = parent.nextSibling
        node = parent.nextSibling
      } else {
        node = null
      }
      continue
    }
    if (el.hasAttribute("data-mention-id")) {
      const id = el.getAttribute("data-mention-id") || ""
      const char = el.getAttribute("data-trigger-char") || "@"
      result += buildGenericMentionToken(id, char)
      // Skip subtree
      const next: Node | null = el.nextSibling
      if (next) {
        walker.currentNode = next
        node = next
        continue
      }
      let parent: Node | null = el.parentNode
      while (parent && !parent.nextSibling) parent = parent.parentNode
      if (parent && parent.nextSibling) {
        walker.currentNode = parent.nextSibling
        node = parent.nextSibling
      } else {
        node = null
      }
      continue
    }
    node = walker.nextNode()
  }
  return result
}

// Build DOM from serialized text
function buildContentFromSerialized(
  root: HTMLElement,
  serialized: string,
  resolveMention?: (id: string) => FileMentionOption | null,
) {
  // Clear safely
  while (root.firstChild) {
    root.removeChild(root.firstChild)
  }

  const regex = /@\[([^\]]+)\]/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(serialized)) !== null) {
    // Text before mention
    if (match.index > lastIndex) {
      appendText(root, serialized.slice(lastIndex, match.index))
    }
    const id = match[1]
    // Try to resolve mention (prefer caller-provided resolver, fall back to parser)
    const option = resolveMention ? resolveMention(id) : parseMentionId(id)
    if (option) {
      root.appendChild(createMentionNode(option))
      root.appendChild(document.createTextNode(" "))
    } else {
      // Fallback: just show the id
      root.appendChild(document.createTextNode(buildGenericMentionToken(id, root.getAttribute("data-trigger-char") || "@")))
    }
    lastIndex = match.index + match[0].length
  }

  // Remaining text
  if (lastIndex < serialized.length) {
    appendText(root, serialized.slice(lastIndex))
  }
}

// Combined tree walk result - computes everything in ONE pass instead of 3
interface TreeWalkResult {
  serialized: string
  textBeforeCursor: string
  // Generic discovery trigger info (replaces atPosition/atIndex/slashPosition/slashIndex)
  discoveryPosition: { node: Node; offset: number } | null
  discoveryIndex: number
  discoveryTrigger: EditorTriggerConfig | null
  nativeTriggerMatches: AgentTriggerMatch[]
}

/**
 * Check if a character matches the trigger position rule.
 * - standalone: char must be at start or after whitespace
 * - start-of-line: char must be at start or after newline
 * - anywhere: no restriction
 */
function matchesTriggerPosition(
  charBefore: string | null,
  position: "standalone" | "start-of-line" | "anywhere",
): boolean {
  switch (position) {
    case "standalone":
      return charBefore === null || /\s/.test(charBefore)
    case "start-of-line":
      return charBefore === null || charBefore === "\n"
    case "anywhere":
      return true
    default:
      return false
  }
}

// Single O(n) tree walk that computes all needed data
function walkTreeOnce(
  root: HTMLElement,
  range: Range | null,
  nativeTriggers: readonly AgentNativeTrigger[] = [],
  discoveryTriggers: readonly EditorTriggerConfig[] = [DEFAULT_MENTION_TRIGGER, DEFAULT_SLASH_TRIGGER],
): TreeWalkResult {
  let serialized = ""
  let textBeforeCursor = ""
  let reachedCursor = false
  let discoveryPosition: { node: Node; offset: number } | null = null
  let discoveryIndex = -1
  let discoveryTrigger: EditorTriggerConfig | null = null

  // Handle case where cursor is in root element (not in a text node)
  let cursorInRoot = false
  let cursorRootOffset = 0
  if (range && range.endContainer === root) {
    cursorInRoot = true
    cursorRootOffset = range.endOffset
  }

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  )
  let node: Node | null = walker.nextNode()

  // Helper to test a trigger candidate at a given global index
  const considerTrigger = (
    trig: EditorTriggerConfig,
    globalIdx: number,
    nodeRef: Node,
    localOffset: number,
    textBeforeInNode: string,
  ) => {
    const kind = trig.kind ?? (trig.char === "/" ? "slash" : "mention")
    const isSlash = kind === "slash"
    const textUpTo = serialized + textBeforeInNode.slice(0, localOffset)
    const charBefore = globalIdx > 0 ? textUpTo.charAt(globalIdx - 1) : null
    if (!matchesTriggerPosition(charBefore, trig.position ?? "anywhere")) return
    const afterTrigger = textBeforeCursor.slice(globalIdx + 1)
    const valid = isSlash
      ? !afterTrigger.includes(" ") && !afterTrigger.includes("\n")
      : !afterTrigger.includes("\n") && !afterTrigger.includes("  ")
    if (!valid) return
    if (globalIdx > discoveryIndex) {
      discoveryIndex = globalIdx
      discoveryPosition = { node: nodeRef, offset: localOffset }
      discoveryTrigger = trig
    }
  }

  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || ""

      const cursorInThisNode = range && !reachedCursor && node === range.endContainer

      let cursorAtRootBoundary = false
      if (cursorInRoot && !reachedCursor && node.parentNode === root) {
        const children = Array.from(root.childNodes)
        const nodeIndex = children.indexOf(node as ChildNode)
        if (nodeIndex >= cursorRootOffset) {
          cursorAtRootBoundary = true
        }
      }

      if (cursorInThisNode) {
        const cursorOffset = range!.endOffset
        textBeforeCursor += text.slice(0, cursorOffset)
        reachedCursor = true

        const textBeforeInNode = text.slice(0, cursorOffset)

        // Check every discovery trigger at every occurrence in this node
        for (const trig of discoveryTriggers) {
          for (let i = 0; i < textBeforeInNode.length; i++) {
            if (textBeforeInNode[i] !== trig.char) continue
            const globalIdx = serialized.length + i
            considerTrigger(trig, globalIdx, node, i, textBeforeInNode)
          }
        }
      } else if (cursorAtRootBoundary) {
        reachedCursor = true
      } else if (!reachedCursor) {
        textBeforeCursor += text
        // For fully-passed nodes, track mention-style triggers only (slash needs cursor context)
        for (const trig of discoveryTriggers) {
          const kind = trig.kind ?? (trig.char === "/" ? "slash" : "mention")
          if (kind === "slash") continue
          const localIdx = text.lastIndexOf(trig.char)
          if (localIdx === -1) continue
          const globalIdx = serialized.length + localIdx
          const textUpTo = serialized + text.slice(0, localIdx)
          const charBefore = globalIdx > 0 ? textUpTo.charAt(globalIdx - 1) : null
          if (!matchesTriggerPosition(charBefore, trig.position ?? "anywhere")) continue
          if (globalIdx > discoveryIndex) {
            discoveryIndex = globalIdx
            discoveryPosition = { node, offset: localIdx }
            discoveryTrigger = trig
          }
        }
      }

      serialized += text
      node = walker.nextNode()
      continue
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement

      if (el.hasAttribute("data-ultrathink")) {
        const text = el.textContent || ""
        serialized += text
        if (!reachedCursor) {
          textBeforeCursor += text
        }
        const next: Node | null = el.nextSibling
        if (next) {
          walker.currentNode = next
          node = next
          continue
        }
        let parent: Node | null = el.parentNode
        while (parent && !parent.nextSibling) parent = parent.parentNode
        if (parent && parent.nextSibling) {
          walker.currentNode = parent.nextSibling
          node = parent.nextSibling
          continue
        }
        node = null
        continue
      }

      if (el.hasAttribute("data-mention-id")) {
        const id = el.getAttribute("data-mention-id") || ""
        const char = el.getAttribute("data-trigger-char") || "@"
        const mentionToken = buildGenericMentionToken(id, char)
        serialized += mentionToken
        if (!reachedCursor) {
          textBeforeCursor += mentionToken
        }
        const next: Node | null = el.nextSibling
        if (next) {
          walker.currentNode = next
          node = next
          continue
        }
        let parent: Node | null = el.parentNode
        while (parent && !parent.nextSibling) parent = parent.parentNode
        if (parent && parent.nextSibling) {
          walker.currentNode = parent.nextSibling
          node = parent.nextSibling
          continue
        }
        node = null
        continue
      }
    }

    node = walker.nextNode()
  }

  // Validate discovery trigger based on kind
  if (discoveryIndex !== -1 && discoveryTrigger) {
    const kind = discoveryTrigger.kind ?? (discoveryTrigger.char === "/" ? "slash" : "mention")
    const isSlash = kind === "slash"
    const afterTrigger = textBeforeCursor.slice(discoveryIndex + 1)
    const invalid = isSlash
      ? afterTrigger.includes(" ") || afterTrigger.includes("\n")
      : afterTrigger.includes("\n") || afterTrigger.includes("  ")
    if (invalid) {
      discoveryIndex = -1
      discoveryPosition = null
      discoveryTrigger = null
    }
  }

  return {
    serialized,
    textBeforeCursor,
    discoveryPosition,
    discoveryIndex,
    discoveryTrigger,
    nativeTriggerMatches: matchAgentTriggers(textBeforeCursor, nativeTriggers),
  }
}

// Memoized to prevent re-renders when parent re-renders
// react-doctor-disable-next-line no-giant-component
export const AgentsMentionsEditor = memo(
  forwardRef<AgentsMentionsEditorHandle, AgentsMentionsEditorProps>(
    function AgentsMentionsEditor(
      {
        initialValue,
        onTrigger,
        onCloseTrigger,
        onSlashTrigger,
        onCloseSlashTrigger,
        // react-doctor-disable-next-line rerender-memo-with-default-value
        nativeTriggers = [],
        onNativeTrigger,
        onCloseNativeTrigger,
        mentionTrigger,
        slashTrigger,
        discoveryTriggers,
        onContentChange,
        placeholder,
        className,
        onSubmit,
        onForceSubmit,
        disabled,
        onPaste,
        onShiftTab,
        onFocus,
        onBlur,
      },
      ref,
    ) {
      const editorRef = useRef<HTMLDivElement>(null)
      // Unified discovery trigger state (replaces separate mention/slash trigger refs).
      const activeDiscoveryTrigger = useRef<{
        kind: "slash" | "mention"
        startIndex: number
        char: string
      } | null>(null)
      // Track if editor has content for placeholder (updated via DOM, no React state)
      const [hasContent, setHasContent] = useState(false)

      // Custom undo/redo stack
      // Browser's native undo doesn't work well with execCommand insertText and DOM manipulations
      const undoStack = useRef<UndoState[]>([])
      const redoStack = useRef<UndoState[]>([])
      const isUndoRedo = useRef(false)
      const lastSavedHtml = useRef<string>("")
      const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

      // Get current editor state (html + cursor position)
      const getCurrentState = useCallback((): UndoState | null => {
        if (!editorRef.current) return null
        const html = editorRef.current.innerHTML
        const sel = window.getSelection()
        let cursorOffset = 0
        if (sel && sel.rangeCount > 0 && editorRef.current.contains(sel.anchorNode)) {
          const range = sel.getRangeAt(0)
          // Calculate offset by walking through all nodes
          // Mentions count by their serialized length for consistency with walkTreeOnce/insertMention
          const walker = document.createTreeWalker(
            editorRef.current,
            NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
          )
          let node: Node | null = walker.nextNode()
          while (node) {
            if (node === range.startContainer) {
              cursorOffset += range.startOffset
              break
            }
            if (node.nodeType === Node.TEXT_NODE) {
              cursorOffset += node.textContent?.length || 0
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node as HTMLElement
              if (el.hasAttribute("data-mention-id")) {
                const id = el.getAttribute("data-mention-id") || ""
                cursorOffset += buildGenericMentionToken(id, (el as HTMLElement).getAttribute("data-trigger-char") || "@").length
                // Skip children of mention node - jump to parent's next sibling
                let parent: Node | null = el.parentNode
                while (parent && parent !== editorRef.current && !parent.nextSibling) parent = parent.parentNode
                if (parent && parent.nextSibling) {
                  walker.currentNode = parent.nextSibling
                  node = parent.nextSibling
                  continue
                }
                // No more siblings - stop walking
                node = null
                continue
              }
            }
            node = walker.nextNode()
          }
        }
        return { html, cursorOffset }
      }, [])

      // Save state to undo stack (call before making changes)
      const saveUndoState = useCallback(() => {
        if (!editorRef.current || isUndoRedo.current) return
        const state = getCurrentState()
        if (!state) return
        // Don't save if nothing changed
        if (state.html === lastSavedHtml.current) return
        lastSavedHtml.current = state.html
        undoStack.current.push(state)
        // Clear redo stack when new action is performed
        redoStack.current = []
        // Limit stack size
        if (undoStack.current.length > MAX_UNDO_STACK_SIZE) {
          undoStack.current.shift()
        }
      }, [getCurrentState])

      // Debounced save for typing - saves state after 500ms of no typing
      const debouncedSaveUndoState = useCallback(() => {
        if (debounceTimer.current) {
          clearTimeout(debounceTimer.current)
        }
        debounceTimer.current = setTimeout(() => {
          saveUndoState()
          debounceTimer.current = null
        }, 500)
      }, [saveUndoState])

      // Immediate save (for paste, mentions) - also cancels unknown pending debounce
      const immediateSaveUndoState = useCallback(() => {
        if (debounceTimer.current) {
          clearTimeout(debounceTimer.current)
          debounceTimer.current = null
        }
        saveUndoState()
      }, [saveUndoState])

      // Restore cursor position after undo/redo
      // Handles both text nodes and mention nodes
      // Mentions count by their serialized length for consistency with getCurrentState
      const restoreCursor = useCallback((offset: number) => {
        if (!editorRef.current) return
        const sel = window.getSelection()
        if (!sel) return

        let currentOffset = 0
        const walker = document.createTreeWalker(
          editorRef.current,
          NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        )
        let node: Node | null = walker.nextNode()

        while (node) {
          if (node.nodeType === Node.TEXT_NODE) {
            const textNode = node as Text
            const nodeLength = textNode.textContent?.length || 0
            if (currentOffset + nodeLength >= offset) {
              const range = document.createRange()
              range.setStart(textNode, Math.min(offset - currentOffset, nodeLength))
              range.collapse(true)
              sel.removeAllRanges()
              sel.addRange(range)
              return
            }
            currentOffset += nodeLength
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement
            if (el.hasAttribute("data-mention-id")) {
              const id = el.getAttribute("data-mention-id") || ""
              const mentionLen = buildGenericMentionToken(id, (el as HTMLElement).getAttribute("data-trigger-char") || "@").length
              if (currentOffset + mentionLen >= offset) {
                // Place cursor after mention
                const range = document.createRange()
                range.setStartAfter(el)
                range.collapse(true)
                sel.removeAllRanges()
                sel.addRange(range)
                return
              }
              currentOffset += mentionLen
              // Skip children of mention node - jump to parent's next sibling
              let parent: Node | null = el.parentNode
              while (parent && parent !== editorRef.current && !parent.nextSibling) parent = parent.parentNode
              if (parent && parent.nextSibling) {
                walker.currentNode = parent.nextSibling
                node = parent.nextSibling
                continue
              }
              // No more siblings - stop walking
              node = null
              continue
            }
          }
          node = walker.nextNode()
        }

        // Fallback: move to end
        sel.selectAllChildren(editorRef.current)
        sel.collapseToEnd()
      }, [])

      // Cleanup debounce timer on unmount
      useEffect(() => {
        return () => {
          if (debounceTimer.current) {
            clearTimeout(debounceTimer.current)
          }
        }
      }, [])

      // Resolve mention from id for rendering
      const resolveMention = useCallback(
        (id: string): FileMentionOption | null => parseMentionId(id),
        [],
      )

      // Initialize editor with initialValue on mount
      useEffect(() => {
        if (editorRef.current && initialValue) {
          buildContentFromSerialized(
            editorRef.current,
            initialValue,
            resolveMention,
          )
          setHasContent(!!initialValue)
        }
        // Save initial state for undo (allows undo to empty)
        if (editorRef.current) {
          lastSavedHtml.current = editorRef.current.innerHTML
          undoStack.current = [{ html: editorRef.current.innerHTML, cursorOffset: 0 }]
        }
      // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []) // Only on mount

      // Handle selection changes to highlight mention chips
      // Throttled to avoid performance issues during rapid typing
      useEffect(() => {
        let rafId: number | null = null
        let lastRun = 0
        const THROTTLE_MS = 100

        const handleSelectionChange = () => {
          const now = Date.now()

          // Throttle: skip if called too recently
          if (now - lastRun < THROTTLE_MS) {
            // Schedule one final update after throttle period
            if (rafId) cancelAnimationFrame(rafId)
            rafId = requestAnimationFrame(() => {
              lastRun = Date.now()
              updateMentionHighlights()
            })
            return
          }

          lastRun = now
          updateMentionHighlights()
        }

        const updateMentionHighlights = () => {
          if (!editorRef.current) return

          const selection = window.getSelection()
          if (!selection || selection.rangeCount === 0) {
            // Clear all highlights when no selection
            const mentions =
              editorRef.current.querySelectorAll("[data-mention-id]")
            mentions.forEach((mention) => {
              const mentionEl = mention as HTMLElement
              mentionEl.classList.remove("mention-selected")
            })
            return
          }

          const range = selection.getRangeAt(0)

          // Check if selection is within our editor
          const commonAncestor = range.commonAncestorContainer
          const isInEditor = editorRef.current.contains(
            commonAncestor.nodeType === Node.ELEMENT_NODE
              ? commonAncestor
              : commonAncestor.parentElement,
          )

          if (!isInEditor) return

          // Get all mention chips
          const mentions =
            editorRef.current.querySelectorAll("[data-mention-id]")

          mentions.forEach((mention) => {
            const mentionEl = mention as HTMLElement

            // Check if mention is within selection range
            if (range.intersectsNode(mentionEl)) {
              mentionEl.classList.add("mention-selected")
            } else {
              mentionEl.classList.remove("mention-selected")
            }
          })
        }

        document.addEventListener("selectionchange", handleSelectionChange)
        return () => {
          document.removeEventListener("selectionchange", handleSelectionChange)
          if (rafId) cancelAnimationFrame(rafId)
        }
      }, [])

      // Trigger detection timeout ref for cleanup
      const triggerDetectionTimeout = useRef<number | null>(null)

      // Handle input - UNCONTROLLED: no onChange, just @ and / trigger detection
      const handleInput = useCallback(() => {
        if (!editorRef.current) return

        // Save undo state with debounce (for typing)
        // This captures state periodically during typing for proper undo
        debouncedSaveUndoState()

        // Update placeholder visibility and notify parent IMMEDIATELY (cheap operation)
        // Use textContent without trim() so placeholder hides even with just spaces
        const content = editorRef.current.textContent || ""
        const newHasContent = !!content
        setHasContent(newHasContent)
        onContentChange?.(newHasContent)

        // Skip expensive trigger detection for very large text
        // This prevents UI freeze when pasting large content
        if (content.length > LARGE_TEXT_THRESHOLD) {
          // Close unknown open triggers since we can't detect them
          if (activeDiscoveryTrigger.current?.kind === "mention") {
            activeDiscoveryTrigger.current = null
            onCloseTrigger()
          }
          if (activeDiscoveryTrigger.current?.kind === "slash") {
            activeDiscoveryTrigger.current = null
            onCloseSlashTrigger?.()
          }
          return
        }

        // Clear previous timeout
        if (triggerDetectionTimeout.current) {
          cancelAnimationFrame(triggerDetectionTimeout.current)
        }

        // For short content, run trigger detection immediately
        // For longer content, debounce to avoid performance issues
        const runTriggerDetection = () => {
          if (!editorRef.current) return

          // Get selection for cursor position
          const sel = window.getSelection()
          const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null

          // Handle non-collapsed selection (close triggers)
          if (range && !range.collapsed) {
            if (activeDiscoveryTrigger.current?.kind === "mention") {
              activeDiscoveryTrigger.current = null
              onCloseTrigger()
            }
            if (activeDiscoveryTrigger.current?.kind === "slash") {
              activeDiscoveryTrigger.current = null
              onCloseSlashTrigger?.()
            }
            onCloseNativeTrigger?.()
            return
          }

          // Build combined discovery trigger list from props
          const allDiscoveryTriggers =
            (discoveryTriggers && discoveryTriggers.length > 0)
              ? discoveryTriggers
              : [mentionTrigger ?? DEFAULT_MENTION_TRIGGER, slashTrigger ?? DEFAULT_SLASH_TRIGGER]

          // Single tree walk for trigger detection (configurable via props)
          const {
            textBeforeCursor,
            discoveryPosition,
            discoveryIndex,
            discoveryTrigger,
            nativeTriggerMatches,
          } = walkTreeOnce(
            editorRef.current,
            range,
            nativeTriggers,
            allDiscoveryTriggers,
          )

          const discoveryKind =
            discoveryTrigger?.kind ?? (discoveryTrigger?.char === "/" ? "slash" : "mention")

          // Handle discovery trigger
          if (discoveryIndex !== -1 && discoveryPosition && discoveryTrigger && (discoveryKind === "slash" ? onSlashTrigger : onTrigger)) {
            const isSlash = discoveryKind === "slash"
            const previousKind = activeDiscoveryTrigger.current?.kind
            if (isSlash) {
              if (previousKind === "mention") {
                onCloseTrigger()
              }
              activeDiscoveryTrigger.current = {
                kind: "slash",
                startIndex: discoveryIndex,
                char: discoveryTrigger.char,
              }
            } else {
              if (previousKind === "slash") {
                onCloseSlashTrigger?.()
              }
              activeDiscoveryTrigger.current = {
                kind: "mention",
                startIndex: discoveryIndex,
                char: discoveryTrigger.char,
              }
            }

            const afterTrigger = textBeforeCursor.slice(discoveryIndex + 1)

            if (range && editorRef.current && discoveryPosition) {
              const tempRange = document.createRange()
              tempRange.setStart(discoveryPosition.node, discoveryPosition.offset)
              tempRange.setEnd(discoveryPosition.node, discoveryPosition.offset + 1)
              const triggerRect = tempRange.getBoundingClientRect()

              const rect = new DOMRect(
                triggerRect.left,
                triggerRect.top,
                0,
                triggerRect.height,
              )

              if (isSlash && onSlashTrigger) {
                onSlashTrigger({ searchText: afterTrigger, rect, triggerChar: discoveryTrigger?.char })
              } else {
                onTrigger({ searchText: afterTrigger, rect, triggerChar: discoveryTrigger?.char })
              }
              return
            }
          }

          // Close discovery trigger if no discovery trigger found
          if (activeDiscoveryTrigger.current?.kind === "mention") {
            activeDiscoveryTrigger.current = null
            onCloseTrigger()
          } else if (activeDiscoveryTrigger.current?.kind === "slash") {
            activeDiscoveryTrigger.current = null
            onCloseSlashTrigger?.()
          }

          // Native triggers have lower priority than Ergatai's explicit
          // route/slash entry points. Unknown syntax reaches this branch only
          // when it is registered; otherwise it remains ordinary raw text.
          const nativeTriggerMatch = nativeTriggerMatches[0]
          if (nativeTriggerMatch && range && onNativeTrigger) {
            const tempRange = document.createRange()
            tempRange.setStart(range.endContainer, range.endOffset)
            tempRange.setEnd(range.endContainer, range.endOffset)
            const cursorRect = tempRange.getBoundingClientRect()
            const rect = new DOMRect(
              cursorRect.left,
              cursorRect.top,
              0,
              cursorRect.height,
            )
            onNativeTrigger({ ...nativeTriggerMatch, rect })
            return
          }

          if (!nativeTriggerMatch) {
            onCloseNativeTrigger?.()
          }
        }

        // Always use requestAnimationFrame to avoid blocking input rendering
        // This allows the browser to render the typed character first,
        // then detect triggers in the next frame
        if (triggerDetectionTimeout.current) {
          cancelAnimationFrame(triggerDetectionTimeout.current)
        }
        triggerDetectionTimeout.current = requestAnimationFrame(runTriggerDetection)
      }, [
        nativeTriggers,
        mentionTrigger,
        slashTrigger,
        discoveryTriggers,
        onContentChange,
        onCloseNativeTrigger,
        onCloseSlashTrigger,
        onCloseTrigger,
        onNativeTrigger,
        onSlashTrigger,
        onTrigger,
        debouncedSaveUndoState,
      ])

      // Cleanup on unmount
      useEffect(() => {
        return () => {
          if (triggerDetectionTimeout.current) {
            cancelAnimationFrame(triggerDetectionTimeout.current)
          }
        }
      }, [])

      // Handle keydown
      const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
          // Custom undo (Cmd+Z / Ctrl+Z)
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
            if (undoStack.current.length > 0) {
              e.preventDefault()
              isUndoRedo.current = true

              // Save current state to redo stack
              const currentState = getCurrentState()
              if (currentState) {
                redoStack.current.push(currentState)
              }

              // Restore previous state
              const state = undoStack.current.pop()!
              if (editorRef.current) {
                editorRef.current.innerHTML = state.html
                lastSavedHtml.current = state.html
                restoreCursor(state.cursorOffset)
                const newHasContent = !!editorRef.current.textContent
                setHasContent(newHasContent)
                onContentChange?.(newHasContent)
              }

              isUndoRedo.current = false
              return
            }
          }

          // Custom redo (Cmd+Shift+Z / Ctrl+Shift+Z or Cmd+Y / Ctrl+Y)
          if ((e.metaKey || e.ctrlKey) && ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y")) {
            if (redoStack.current.length > 0) {
              e.preventDefault()
              isUndoRedo.current = true

              // Save current state to undo stack
              const currentState = getCurrentState()
              if (currentState) {
                undoStack.current.push(currentState)
              }

              // Restore redo state
              const state = redoStack.current.pop()!
              if (editorRef.current) {
                editorRef.current.innerHTML = state.html
                lastSavedHtml.current = state.html
                restoreCursor(state.cursorOffset)
                const newHasContent = !!editorRef.current.textContent
                setHasContent(newHasContent)
                onContentChange?.(newHasContent)
              }

              isUndoRedo.current = false
              return
            }
          }

          // Prevent submission during IME composition (e.g., Chinese/Japanese/Korean input)
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            if (activeDiscoveryTrigger.current !== null) {
              // Let dropdown handle Enter
              return
            }
            e.preventDefault()
            // Opt+Enter = force submit (bypass queue, stop stream and send immediately)
            if (e.altKey && onForceSubmit) {
              onForceSubmit()
            } else {
              onSubmit?.()
            }
          }
          if (e.key === "Escape") {
            // Close mention dropdown
            if (activeDiscoveryTrigger.current?.kind === "mention") {
              e.preventDefault()
              activeDiscoveryTrigger.current = null
              onCloseTrigger()
              return
            }
            // Close command dropdown
            if (activeDiscoveryTrigger.current?.kind === "slash") {
              e.preventDefault()
              activeDiscoveryTrigger.current = null
              onCloseSlashTrigger?.()
              return
            }
            // If no dropdown is open, blur the editor (but don't prevent default
            // to allow other handlers like multi-select clear to run)
            editorRef.current?.blur()
          }
          if (e.key === "Tab" && e.shiftKey) {
            e.preventDefault()
            onShiftTab?.()
          }
        },
        [onSubmit, onForceSubmit, onCloseTrigger, onCloseSlashTrigger, onShiftTab, restoreCursor, onContentChange, getCurrentState],
      )

      // Expose methods via ref (UNCONTROLLED pattern)
      useImperativeHandle(
        ref,
        () => ({
          focus: () => {
            const editor = editorRef.current
            if (!editor) return

            editor.focus()

            // Always ensure cursor is visible at end
            const sel = window.getSelection()
            if (sel && sel.rangeCount === 0) {
              sel.selectAllChildren(editor)
              sel.collapseToEnd()
            }
          },

          blur: () => {
            const editor = editorRef.current
            if (!editor) return
            editor.blur()
          },

          // Get serialized value with mention tokens
          getValue: () => {
            if (!editorRef.current) return ""
            return serializeContent(editorRef.current)
          },

          // Set content from serialized string
          setValue: (value: string) => {
            if (!editorRef.current) return
            buildContentFromSerialized(editorRef.current, value, resolveMention)
            const newHasContent = !!value
            setHasContent(newHasContent)
            onContentChange?.(newHasContent)

            // Position cursor at the end of content
            if (newHasContent) {
              const sel = window.getSelection()
              if (sel) {
                sel.selectAllChildren(editorRef.current)
                sel.collapseToEnd()
              }
            }
          },

          // Clear editor content
          clear: () => {
            if (!editorRef.current) return
            editorRef.current.innerHTML = ""
            setHasContent(false)
            onContentChange?.(false)
            activeDiscoveryTrigger.current = null
          },

          // Clear slash command text after selection (removes /command from input)
          clearSlashCommand: () => {
            if (!editorRef.current || activeDiscoveryTrigger.current?.kind !== "slash" || activeDiscoveryTrigger.current.startIndex === null)
              return

            const sel = window.getSelection()
            if (!sel || sel.rangeCount === 0) {
              // Fallback: clear entire editor if we can't find the range
              editorRef.current.innerHTML = ""
              setHasContent(false)
              onContentChange?.(false)
              activeDiscoveryTrigger.current = null
              onCloseSlashTrigger?.()
              return
            }

            const range = sel.getRangeAt(0)
            const node = range.startContainer

            if (node.nodeType === Node.TEXT_NODE) {
              const text = node.textContent || ""
              // Find local position of / within this text node
              let localSlashPosition: number | null = null
              let serializedCharCount = 0

              const walker = document.createTreeWalker(
                editorRef.current,
                NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
              )
              let walkNode: Node | null = walker.nextNode()

              while (walkNode) {
                if (walkNode === node) {
                  localSlashPosition =
                    activeDiscoveryTrigger.current!.startIndex - serializedCharCount
                  break
                }

                if (walkNode.nodeType === Node.TEXT_NODE) {
                  serializedCharCount += (walkNode.textContent || "").length
                } else if (walkNode.nodeType === Node.ELEMENT_NODE) {
                  const el = walkNode as HTMLElement
                  if (el.hasAttribute("data-mention-id")) {
                    const id = el.getAttribute("data-mention-id") || ""
                    serializedCharCount += buildGenericMentionToken(id, (el as HTMLElement).getAttribute("data-trigger-char") || "@").length
                    // Skip mention children - jump to parent's next sibling
                    let parent: Node | null = el.parentNode
                    while (parent && parent !== editorRef.current && !parent.nextSibling) parent = parent.parentNode
                    if (parent && parent.nextSibling) {
                      walker.currentNode = parent.nextSibling
                      walkNode = parent.nextSibling
                      continue
                    }
                    walkNode = null
                    continue
                  }
                }
                walkNode = walker.nextNode()
              }

              // Only proceed if we found the slash position
              if (localSlashPosition === null || localSlashPosition < 0) {
                // Node not found in tree walk - just close the trigger without modifying text
                activeDiscoveryTrigger.current = null
                onCloseSlashTrigger?.()
                return
              }

              // Remove from / to cursor
              const beforeSlash = text.slice(0, localSlashPosition)
              const afterCursor = text.slice(range.startOffset)
              node.textContent = beforeSlash + afterCursor

              // Move cursor to where / was
              const newRange = document.createRange()
              newRange.setStart(node, localSlashPosition)
              newRange.collapse(true)
              sel.removeAllRanges()
              sel.addRange(newRange)

              // Update hasContent
              const newContent = editorRef.current.textContent
              setHasContent(!!newContent)
              onContentChange?.(!!newContent)
            }

            // Close trigger
            activeDiscoveryTrigger.current = null
            onCloseSlashTrigger?.()
          },

          triggerDetection: () => {
            handleInput()
          },
          insertMention: (option: FileMentionOption) => {
            if (!editorRef.current) return

            // Save state for undo before inserting mention (immediate, not debounced)
            immediateSaveUndoState()

            const sel = window.getSelection()
            const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null

            // Case 1: Triggered by @ - remove @ and search text, then insert mention
            if (
              range &&
              range.startContainer.nodeType === Node.TEXT_NODE &&
              activeDiscoveryTrigger.current?.kind === "mention"
            ) {
              const node = range.startContainer
              const text = node.textContent || ""

              // Find local position of @ within THIS text node
              let localAtPosition = 0
              let serializedCharCount = 0

              const walker = document.createTreeWalker(
                editorRef.current,
                NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
              )
              let walkNode: Node | null = walker.nextNode()

              while (walkNode) {
                if (walkNode === node) {
                  localAtPosition =
                    activeDiscoveryTrigger.current!.startIndex - serializedCharCount
                  break
                }

                if (walkNode.nodeType === Node.TEXT_NODE) {
                  serializedCharCount += (walkNode.textContent || "").length
                } else if (walkNode.nodeType === Node.ELEMENT_NODE) {
                  const el = walkNode as HTMLElement
                  if (el.hasAttribute("data-mention-id")) {
                    const id = el.getAttribute("data-mention-id") || ""
                    serializedCharCount += buildGenericMentionToken(id, (el as HTMLElement).getAttribute("data-trigger-char") || "@").length
                    // Skip mention children - jump to parent's next sibling
                    let parent: Node | null = el.parentNode
                    while (parent && parent !== editorRef.current && !parent.nextSibling) parent = parent.parentNode
                    if (parent && parent.nextSibling) {
                      walker.currentNode = parent.nextSibling
                      walkNode = parent.nextSibling
                      continue
                    }
                    walkNode = null
                    continue
                  }
                }
                walkNode = walker.nextNode()
              }

              const beforeAt = text.slice(0, localAtPosition)
              const afterCursor = text.slice(range.startOffset)
              node.textContent = beforeAt + afterCursor

              // Insert the directory path as plain text, keeping the leading @ so the
              // directory stays addressable (and browsable) instead of being eaten.
              const isFolder = option.type === "folder"
              const insertedNode = isFolder
                ? document.createTextNode(`@${option.path}/`)
                : createMentionNode(option, (activeDiscoveryTrigger.current?.kind === "mention" ? activeDiscoveryTrigger.current.char : null) || "@")
              const newRange = document.createRange()
              newRange.setStart(node, localAtPosition)
              newRange.collapse(true)
              newRange.insertNode(insertedNode)

              // Directories are inserted without a trailing space so the @ trigger
              // search text stays clean (e.g. "path/") and filtering works.
              if (option.type === "folder") {
                // Place cursor inside the folder text node so trigger detection can
                // reliably see the cursor position and continue directory browsing.
                newRange.setStart(insertedNode, (insertedNode.textContent || "").length)
                newRange.collapse(true)
              } else {
                const space = document.createTextNode(" ")
                insertedNode.after(space)
                newRange.setStartAfter(space)
                newRange.collapse(true)
              }
              sel!.removeAllRanges()
              sel!.addRange(newRange)

              // Update hasContent
              setHasContent(true)

              // Close trigger
              activeDiscoveryTrigger.current = null
              onCloseTrigger()
            }
            // Case 2: Direct insertion (e.g., from sidebar widget, drag & drop)
            else {
              const isFolder = option.type === "folder"
              const mentionNode = isFolder
                ? document.createTextNode(`@${option.path}/`)
                : createMentionNode(option)
              const space = isFolder ? null : document.createTextNode(" ")

              // Try to insert at current cursor position if it's inside the editor
              const editorEl = editorRef.current
              let inserted = false

              if (range && editorEl.contains(range.startContainer)) {
                range.collapse(false)
                if (space) range.insertNode(space)
                range.insertNode(mentionNode)
                inserted = true
              }

              // Fallback: insert at end of the last text/inline content
              if (!inserted) {
                // Find the deepest last child to append inline (avoid new-line from div siblings)
                let target: Node = editorEl
                while (target.lastChild && target.lastChild.nodeType === Node.ELEMENT_NODE) {
                  const el = target.lastChild as HTMLElement
                  if (el.hasAttribute("data-mention-id") || el.tagName === "BR") break
                  target = el
                }
                target.appendChild(mentionNode)
                if (space) target.appendChild(space)
              }

              // Move cursor after the inserted node (and trailing space if any)
              const newRange = document.createRange()
              if (space) {
                newRange.setStartAfter(space)
              } else if (isFolder && mentionNode.nodeType === Node.TEXT_NODE) {
                // Keep cursor inside folder text so trigger detection can continue browsing.
                newRange.setStart(mentionNode, (mentionNode.textContent || "").length)
              } else {
                newRange.setStartAfter(mentionNode)
              }
              newRange.collapse(true)

              if (sel) {
                sel.removeAllRanges()
                sel.addRange(newRange)
              }

              // Update hasContent
              setHasContent(true)
              onContentChange?.(true)
            }
          },

          contains: (node: Node) => {
            return editorRef.current != null && editorRef.current.contains(node)
          },
        }),
        [onCloseTrigger, onCloseSlashTrigger, resolveMention, onContentChange, immediateSaveUndoState, handleInput],
      )

      return (
        <div className="relative">
          {!hasContent && placeholder && (
            <div className="pointer-events-none absolute left-1 top-1 text-sm text-muted-foreground/60 whitespace-pre-wrap">
              {placeholder}
            </div>
          )}
          {/* react-doctor-disable-next-line control-has-associated-label */}
          <div
            role="button"
            ref={editorRef}
            contentEditable={!disabled}
            suppressContentEditableWarning
            spellCheck={false}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              // Save state for undo before paste (immediate, not debounced)
              immediateSaveUndoState()
              onPaste?.(e)
            }}
            onFocus={onFocus}
            onBlur={onBlur}
            className={cn(
              "min-h-[24px] outline-none whitespace-pre-wrap break-words text-sm relative",
              disabled && "opacity-50 cursor-not-allowed",
              className,
            )}
          />
        </div>
      )
    },
  ),
)
