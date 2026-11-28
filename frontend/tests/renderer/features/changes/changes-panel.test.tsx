import { fireEvent, render, screen } from "@testing-library/react"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  mergeMutation: { mutate: vi.fn(), isPending: false },
  syncMutation: { mutate: vi.fn(), isPending: false },
  invalidateStatus: vi.fn(),
  invalidateParsedDiff: vi.fn(),
}))

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      changes: { getStatus: { invalidate: mocks.invalidateStatus } },
      chats: { getParsedDiff: { invalidate: mocks.invalidateParsedDiff } },
    }),
    chats: { get: { useQuery: mocks.useQuery } },
    changes: {
      mergeChatBranch: { useMutation: () => mocks.mergeMutation },
      syncWorktreeToBase: { useMutation: () => mocks.syncMutation },
    },
  },
}))

vi.mock("@/features/changes/changes-view", () => ({
  ChangesView: () => <div data-testid="changes-view" />,
}))

import { ChangesPanel } from "@/features/changes/changes-panel"

function mockChat(branch: string, baseBranch: string) {
  mocks.useQuery.mockReturnValue({ data: { branch, baseBranch } })
}

function openMergeMenu() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: /Merge into main/ }),
    { button: 0, ctrlKey: false },
  )
}

beforeAll(() => {
  // Radix's dropdown primitives expect these browser APIs; happy-dom does not
  // implement them.
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

describe("ChangesPanel merge into base", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("hides the merge action when the chat branch is the base branch", () => {
    mockChat("main", "main")

    render(<ChangesPanel worktreePath="/tmp/worktree" />)

    expect(screen.queryByRole("button", { name: /Merge into/ })).toBeNull()
  })

  it("shows the branch direction and merge action when the branch differs", () => {
    mockChat("chat/feature", "main")

    render(<ChangesPanel worktreePath="/tmp/worktree" />)

    expect(screen.getByText("chat/feature → main")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Merge into main/ }),
    ).toBeInTheDocument()
  })

  it("offers the three git merge strategies", async () => {
    mockChat("chat/feature", "main")

    render(<ChangesPanel worktreePath="/tmp/worktree" />)
    openMergeMenu()

    expect(await screen.findByText("Fast-forward only")).toBeInTheDocument()
    expect(screen.getByText("Merge commit")).toBeInTheDocument()
    expect(screen.getByText("Squash")).toBeInTheDocument()
  })

  it("merges with the strategy the user picks", async () => {
    mockChat("chat/feature", "main")

    render(<ChangesPanel worktreePath="/tmp/worktree" />)
    openMergeMenu()
    fireEvent.click(await screen.findByText("Merge commit"))

    expect(mocks.mergeMutation.mutate).toHaveBeenCalledWith({
      worktreePath: "/tmp/worktree",
      chatBranch: "chat/feature",
      baseBranch: "main",
      strategy: "no-ff",
    })
  })
})
