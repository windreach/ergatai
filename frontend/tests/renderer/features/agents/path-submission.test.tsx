import { createRef, useState, type RefObject } from "react"
import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { AgentsSlashCommand } from "@/features/agents/commands/agents-slash-command"
import { AgentsFileMention } from "@/features/agents/mentions/agents-file-mention"
import {
  AgentsMentionsEditor,
  type AgentsMentionsEditorHandle,
} from "@/features/agents/mentions/agents-mentions-editor"

vi.mock("@/lib/trpc", () => ({
  trpc: {
    ergatai: {
      getAgentBindings: {
        useQuery: () => ({ data: [], isLoading: false }),
      },
    },
  },
  trpcClient: {},
}))

vi.mock("@/lib/api-adapter", () => ({
  api: {
    github: {
      searchFiles: {
        useQuery: () => ({ data: [], error: null, isFetching: false }),
      },
    },
  },
}))

vi.mock("@/features/agents/discovery/use-discovery-groups", () => ({
  useDiscoveryGroups: () => ({ groups: [], isLoading: false }),
}))

type EditorRef = RefObject<AgentsMentionsEditorHandle | null>

function insertPlainText(editor: HTMLElement, text: string) {
  editor.textContent = text
  const range = document.createRange()
  if (!editor.firstChild) throw new Error("editor text node not created")
  range.setStart(editor.firstChild, text.length)
  range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function SlashPathComposer({
  editorRef,
  onSubmit,
}: {
  editorRef: EditorRef
  onSubmit: () => void
}) {
  const [open, setOpen] = useState(false)
  const [searchText, setSearchText] = useState("")

  return (
    <>
      <AgentsMentionsEditor
        ref={editorRef}
        onTrigger={vi.fn()}
        onCloseTrigger={vi.fn()}
        onSlashTrigger={({ searchText: nextSearch }) => {
          setSearchText(nextSearch)
          setOpen(true)
        }}
        onCloseSlashTrigger={() => setOpen(false)}
        onSubmit={onSubmit}
      />
      {open && (
        <AgentsSlashCommand
          isOpen={open}
          onClose={() => setOpen(false)}
          onSelect={vi.fn()}
          searchText={searchText}
          position={{ top: 0, left: 0 }}
        />
      )}
    </>
  )
}

function MentionPathComposer({
  editorRef,
  onSubmit,
}: {
  editorRef: EditorRef
  onSubmit: () => void
}) {
  const [open, setOpen] = useState(false)
  const [searchText, setSearchText] = useState("")

  return (
    <>
      <AgentsMentionsEditor
        ref={editorRef}
        onTrigger={({ searchText: nextSearch }) => {
          setSearchText(nextSearch)
          setOpen(true)
        }}
        onCloseTrigger={() => setOpen(false)}
        onSubmit={onSubmit}
      />
      {open && (
        <AgentsFileMention
          isOpen={open}
          onClose={() => setOpen(false)}
          onSelect={vi.fn()}
          searchText={searchText}
          position={{ top: 0, left: 0 }}
          scope="agents"
        />
      )}
    </>
  )
}

describe("pasted path submission", () => {
  it("submits an absolute path when the slash dropdown has no matching option", async () => {
    const onSubmit = vi.fn()
    const editorRef = createRef<AgentsMentionsEditorHandle>()
    const view = render(<SlashPathComposer editorRef={editorRef} onSubmit={onSubmit} />)
    const editor = view.container.querySelector<HTMLElement>("[contenteditable='true']")
    if (!editor) throw new Error("editor element not mounted")

    act(() => {
      insertPlainText(editor, "/tmp/example.txt")
      editorRef.current!.triggerDetection()
    })

    await waitFor(() => {
      expect(view.getByText(/No commands matching/)).toBeInTheDocument()
    })
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter" })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(editor.textContent).toBe("/tmp/example.txt")
  })

  it("submits a serialized file mention when the mention dropdown has no option", async () => {
    const onSubmit = vi.fn()
    const editorRef = createRef<AgentsMentionsEditorHandle>()
    const view = render(<MentionPathComposer editorRef={editorRef} onSubmit={onSubmit} />)
    const editor = view.container.querySelector<HTMLElement>("[contenteditable='true']")
    if (!editor) throw new Error("editor element not mounted")

    act(() => {
      insertPlainText(editor, "@[file:local:/tmp/example.txt]")
      editorRef.current!.triggerDetection()
    })

    await waitFor(() => {
      expect(view.getByText(/No items matching/)).toBeInTheDocument()
    })
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter" })

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})
