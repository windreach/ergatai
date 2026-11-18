import { beforeEach, describe, expect, it, vi } from "vitest"

const createElectronIpcLink = vi.fn()
const electronLink = vi.fn()
const operationLink = vi.fn()

vi.mock("trpc-electron/renderer", () => ({
  ipcLink: (...args: unknown[]) => createElectronIpcLink(...args),
}))

describe("ipcLink", () => {
  beforeEach(() => {
    vi.resetModules()
    delete (globalThis as { __trpcIpcLink?: unknown }).__trpcIpcLink
    delete (globalThis as { __trpcOperationLink?: unknown })
      .__trpcOperationLink
    delete (globalThis as { __trpcNextRequestId?: unknown })
      .__trpcNextRequestId

    createElectronIpcLink.mockReset()
    electronLink.mockReset()
    operationLink.mockReset()

    createElectronIpcLink.mockReturnValue(electronLink)
    electronLink.mockReturnValue(operationLink)
    operationLink.mockImplementation((operation: unknown) => operation)
  })

  it("initializes one electron link and operation link for all clients", async () => {
    const { ipcLink } = await import("@/lib/ipc-link")
    const runtime = {} as never

    const clientA = ipcLink()(runtime)
    const clientB = ipcLink()(runtime)

    expect(createElectronIpcLink).toHaveBeenCalledTimes(1)
    expect(electronLink).toHaveBeenCalledTimes(1)

    clientA({ op: { id: 0 } } as never)
    clientB({ op: { id: 0 } } as never)

    expect(operationLink).toHaveBeenCalledTimes(2)
  })

  it("keeps request ids increasing across the shared link", async () => {
    const { ipcLink } = await import("@/lib/ipc-link")
    const client = ipcLink()({} as never)

    client({ op: { id: 0 } } as never)
    client({ op: { id: 0 } } as never)

    const first = operationLink.mock.calls[0][0] as { op: { id: number } }
    const second = operationLink.mock.calls[1][0] as { op: { id: number } }

    expect(second.op.id).toBe(first.op.id + 1)
  })

  it("reuses the cached link and request ids after a module reload (HMR)", async () => {
    const firstModule = await import("@/lib/ipc-link")
    firstModule.ipcLink()({} as never)({ op: { id: 0 } } as never)

    expect(createElectronIpcLink).toHaveBeenCalledTimes(1)

    vi.resetModules()
    const secondModule = await import("@/lib/ipc-link")
    secondModule.ipcLink()({} as never)({ op: { id: 0 } } as never)

    expect(createElectronIpcLink).toHaveBeenCalledTimes(1)
    expect(electronLink).toHaveBeenCalledTimes(1)

    const first = operationLink.mock.calls[0][0] as { op: { id: number } }
    const second = operationLink.mock.calls[1][0] as { op: { id: number } }
    expect(second.op.id).toBe(first.op.id + 1)
  })
})
