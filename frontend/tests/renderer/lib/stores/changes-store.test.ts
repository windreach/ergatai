import { describe, it, expect, beforeEach } from "vitest"
import { useChangesStore } from "@/lib/stores/changes-store"

describe("useChangesStore", () => {
  beforeEach(() => {
    localStorage.clear()
    useChangesStore.setState({
      selectedFiles: {},
      viewMode: "side-by-side",
      fileListViewMode: "grouped",
      expandedSections: { "against-base": true, committed: true, staged: true, unstaged: true },
      baseBranch: null,
      showRenderedMarkdown: {},
    })
  })

  it("selectFile and getSelectedFile", () => {
    const file = { path: "a.ts", status: "modified" } as any
    useChangesStore.getState().selectFile("wp", file, "staged", "h1")
    const sel = useChangesStore.getState().getSelectedFile("wp")
    expect(sel?.file).toBe(file)
    expect(sel?.category).toBe("staged")
    expect(sel?.commitHash).toBe("h1")
  })

  it("selectFile null clears", () => {
    const file = { path: "a.ts" } as any
    useChangesStore.getState().selectFile("wp", file)
    useChangesStore.getState().selectFile("wp", null)
    expect(useChangesStore.getState().getSelectedFile("wp")).toBeNull()
  })

  it("toggleSection", () => {
    useChangesStore.getState().toggleSection("staged")
    expect(useChangesStore.getState().expandedSections.staged).toBe(false)
    useChangesStore.getState().toggleSection("staged")
    expect(useChangesStore.getState().expandedSections.staged).toBe(true)
  })

  it("setSectionExpanded", () => {
    useChangesStore.getState().setSectionExpanded("committed", false)
    expect(useChangesStore.getState().expandedSections.committed).toBe(false)
  })

  it("setViewMode and setFileListViewMode", () => {
    useChangesStore.getState().setViewMode("inline")
    expect(useChangesStore.getState().viewMode).toBe("inline")
    useChangesStore.getState().setFileListViewMode("tree")
    expect(useChangesStore.getState().fileListViewMode).toBe("tree")
  })

  it("setBaseBranch", () => {
    useChangesStore.getState().setBaseBranch("main")
    expect(useChangesStore.getState().baseBranch).toBe("main")
  })

  it("toggleRenderedMarkdown", () => {
    expect(useChangesStore.getState().getShowRenderedMarkdown("wp")).toBe(false)
    useChangesStore.getState().toggleRenderedMarkdown("wp")
    expect(useChangesStore.getState().getShowRenderedMarkdown("wp")).toBe(true)
  })

  it("reset clears selected file", () => {
    const file = { path: "a.ts" } as any
    useChangesStore.getState().selectFile("wp", file)
    useChangesStore.getState().reset("wp")
    expect(useChangesStore.getState().getSelectedFile("wp")).toBeNull()
  })
})
