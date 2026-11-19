import { describe, it, expect, vi } from "vitest"
import { render } from "@testing-library/react"
import { createRef } from "react"
import {
  AgentsMentionsEditor,
  type AgentsMentionsEditorHandle,
  type FileMentionOption,
} from "@/features/agents/mentions"

const skill: FileMentionOption = {
  id: "skill:ask-matt",
  label: "ask-matt",
  path: "",
  repository: "",
  type: "skill",
}

function renderEditor() {
  const ref = createRef<AgentsMentionsEditorHandle>()
  const onTrigger = vi.fn()
  const onCloseTrigger = vi.fn()
  render(
    <AgentsMentionsEditor
      ref={ref}
      onTrigger={onTrigger}
      onCloseTrigger={onCloseTrigger}
    />,
  )
  const element = ref.current?.getElement()
  if (!element) throw new Error("editor element not mounted")
  element.focus()
  return { ref, element }
}

describe("AgentsMentionsEditor caret placement", () => {
  it("keeps the caret inside a text node after a mention is inserted", () => {
    const { ref, element } = renderEditor()

    element.textContent = "这个可以"
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(element.firstChild!, 4)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)

    ref.current!.insertMention(skill)

    const anchor = window.getSelection()!.anchorNode
    expect(anchor).not.toBeNull()
    expect(anchor!.nodeType).toBe(Node.TEXT_NODE)
    expect(anchor).not.toBe(element)

    // The caret should sit after the chip's trailing space, where IME
    // composition can safely anchor.
    expect(anchor!.textContent).toContain(" ")
  })

  it("anchors the caret in a text node when restoring serialized content", () => {
    const { ref, element } = renderEditor()

    ref.current!.setValue("@[skill:ask-matt] 这个可以")

    const anchor = window.getSelection()!.anchorNode
    expect(anchor).not.toBeNull()
    expect(anchor!.nodeType).toBe(Node.TEXT_NODE)
    expect(anchor).not.toBe(element)
    expect(element.querySelector("[data-mention-id]")).not.toBeNull()
  })
})
