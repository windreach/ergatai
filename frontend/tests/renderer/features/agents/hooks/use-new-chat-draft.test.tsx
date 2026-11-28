import { act, cleanup, renderHook } from "@testing-library/react"
import type { AgentsMentionsEditorHandle } from "../../../../../src/renderer/features/agents/mentions"
import {
  DRAFTS_STORAGE_KEY,
  loadGlobalDrafts,
  revokeAllDraftBlobUrls,
} from "../../../../../src/renderer/features/agents/lib/drafts"
import { useNewChatDraft } from "../../../../../src/renderer/features/agents/hooks/use-new-chat-draft"
import type { UploadedFile, UploadedImage } from "../../../../../src/renderer/features/agents/hooks/use-agents-file-upload"
import type { PastedTextFile } from "../../../../../src/renderer/features/agents/hooks/use-pasted-text-files"

const project = { id: "project-1", name: "Project", path: "/project" }
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
let scopeCounter = 0

function nextScope() {
  scopeCounter += 1
  return `workspace-${scopeCounter}`
}

function createEditor(initialValue = "") {
  let value = initialValue
  const editor = {
    getValue: () => value,
    setValue: (nextValue: string) => {
      value = nextValue
    },
    clear: () => {
      value = ""
    },
    focus: () => {},
    blur: () => {},
  } as unknown as AgentsMentionsEditorHandle

  return {
    ref: { current: editor },
    setValue: (nextValue: string) => editor.setValue(nextValue),
    getValue: () => editor.getValue(),
  }
}

function createOptions(scopeKey: string, editorRef: ReturnType<typeof createEditor>["ref"]) {
  return {
    scopeKey,
    selectedDraftId: null,
    project,
    editorRef,
    images: [] as UploadedImage[],
    files: [] as UploadedFile[],
    pastedTexts: [] as PastedTextFile[],
    fileContentsRef: { current: new Map<string, string>() },
    setHasContent: vi.fn(),
    setImagesFromDraft: vi.fn(),
    setFilesFromDraft: vi.fn(),
    setPastedTextsFromDraft: vi.fn(),
  }
}

describe("useNewChatDraft", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    revokeAllDraftBlobUrls()
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectURL,
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectURL,
    })
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("flushes pending text on unmount and restores it by default", () => {
    const scopeKey = nextScope()
    const firstEditor = createEditor()
    const first = renderHook(() =>
      useNewChatDraft(createOptions(scopeKey, firstEditor.ref)),
    )

    act(() => {
      firstEditor.setValue("latest input")
      first.result.current.handleContentChange(true)
    })
    first.unmount()

    const drafts = loadGlobalDrafts()
    expect(Object.values(drafts).some((draft) => draft.text === "latest input")).toBe(true)

    const secondEditor = createEditor()
    const secondOptions = createOptions(scopeKey, secondEditor.ref)
    renderHook(() => useNewChatDraft(secondOptions))

    expect(secondEditor.getValue()).toBe("latest input")
    expect(secondOptions.setHasContent).toHaveBeenCalledWith(true)
  })

  it("flushes pending text when the renderer page is hidden or reloaded", () => {
    const scopeKey = nextScope()
    const editor = createEditor()
    const hook = renderHook(() => useNewChatDraft(createOptions(scopeKey, editor.ref)))

    act(() => {
      editor.setValue("saved before reload")
      hook.result.current.handleContentChange(true)
      window.dispatchEvent(new Event("pagehide"))
    })

    expect(
      Object.values(loadGlobalDrafts()).some(
        (draft) => draft.text === "saved before reload",
      ),
    ).toBe(true)
  })

  it("keeps active drafts isolated between workspaces", () => {
    const firstScope = nextScope()
    const secondScope = nextScope()
    const firstEditor = createEditor()
    const first = renderHook(() =>
      useNewChatDraft(createOptions(firstScope, firstEditor.ref)),
    )

    act(() => {
      firstEditor.setValue("first workspace")
      first.result.current.handleContentChange(true)
    })
    first.unmount()

    const secondEditor = createEditor()
    const second = renderHook(() =>
      useNewChatDraft(createOptions(secondScope, secondEditor.ref)),
    )
    act(() => {
      secondEditor.setValue("second workspace")
      second.result.current.handleContentChange(true)
    })
    second.unmount()

    const restoredFirstEditor = createEditor()
    const restoredFirst = renderHook(() =>
      useNewChatDraft(createOptions(firstScope, restoredFirstEditor.ref)),
    )
    expect(restoredFirstEditor.getValue()).toBe("first workspace")
    restoredFirst.unmount()

    const restoredSecondEditor = createEditor()
    renderHook(() =>
      useNewChatDraft(createOptions(secondScope, restoredSecondEditor.ref)),
    )
    expect(restoredSecondEditor.getValue()).toBe("second workspace")
  })

  it("restores attachments, pasted text cards, and cached file contents", () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:restored"),
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    })

    const scopeKey = nextScope()
    const image: UploadedImage = {
      id: "image-1",
      filename: "image.png",
      url: "blob:image",
      base64Data: "aW1hZ2U=",
      mediaType: "image/png",
      isLoading: false,
    }
    const folder: UploadedFile = {
      id: "folder-1",
      filename: "src",
      url: "",
      size: 0,
      type: "folder",
      isFolder: true,
      folderFiles: ["index.ts"],
      isLoading: false,
    }
    const pasted: PastedTextFile = {
      id: "pasted-1",
      filePath: "/tmp/pasted.txt",
      filename: "pasted.txt",
      size: 12,
      preview: "pasted text",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    }
    const fileContentsRef = { current: new Map<string, string>() }
    const firstEditor = createEditor()
    const firstOptions = {
      ...createOptions(scopeKey, firstEditor.ref),
      images: [image],
      files: [folder],
      pastedTexts: [pasted],
      fileContentsRef,
    }
    const first = renderHook(() => useNewChatDraft(firstOptions))

    act(() => {
      fileContentsRef.current.set("file:local:src/index.ts", "export {}")
      first.result.current.flushDraft()
    })
    const savedDraft = Object.values(loadGlobalDrafts())[0]
    expect(savedDraft).toMatchObject({
      fileContents: { "file:local:src/index.ts": "export {}" },
    })
    first.unmount()

    const secondEditor = createEditor()
    const secondOptions = createOptions(scopeKey, secondEditor.ref)
    const secondFileContentsRef = { current: new Map<string, string>() }
    renderHook(() =>
      useNewChatDraft({ ...secondOptions, fileContentsRef: secondFileContentsRef }),
    )

    expect(secondOptions.setImagesFromDraft).toHaveBeenCalledWith([
      expect.objectContaining({ id: "image-1", filename: "image.png" }),
    ])
    expect(secondOptions.setFilesFromDraft).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "folder-1",
        isFolder: true,
        folderFiles: ["index.ts"],
      }),
    ])
    expect(secondOptions.setPastedTextsFromDraft).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "pasted-1",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ])
    expect(secondFileContentsRef.current.get("file:local:src/index.ts")).toBe("export {}")
  })

  it("deletes the active draft when the composer is explicitly cleared", () => {
    const scopeKey = nextScope()
    const editor = createEditor()
    const pasted: PastedTextFile = {
      id: "pasted-clear",
      filePath: "/tmp/pasted-clear.txt",
      filename: "pasted-clear.txt",
      size: 7,
      preview: "pasted",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    }
    const hook = renderHook(() =>
      useNewChatDraft({
        ...createOptions(scopeKey, editor.ref),
        pastedTexts: [pasted],
      }),
    )

    act(() => {
      editor.setValue("temporary")
      hook.result.current.handleContentChange(true)
      hook.result.current.flushDraft()
    })
    expect(localStorage.getItem(DRAFTS_STORAGE_KEY)).toContain("temporary")

    act(() => hook.result.current.clearDraft())
    hook.unmount()
    expect(localStorage.getItem(DRAFTS_STORAGE_KEY)).not.toContain("temporary")
    expect(localStorage.getItem(DRAFTS_STORAGE_KEY)).not.toContain("pasted-clear")
  })
})
