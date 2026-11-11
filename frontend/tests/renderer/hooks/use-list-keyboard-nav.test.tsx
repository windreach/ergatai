import { describe, it, expect, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useListKeyboardNav } from "@/components/dialogs/settings-tabs/use-list-keyboard-nav"

describe("useListKeyboardNav", () => {
  it("moves down on ArrowDown", () => {
    const onSelect = vi.fn()
    const { result } = renderHook(() =>
      useListKeyboardNav({ items: ["a", "b", "c"], selectedItem: "a", onSelect })
    )
    act(() => {
      result.current.onKeyDown({ key: "ArrowDown", preventDefault: vi.fn() } as any)
    })
    expect(onSelect).toHaveBeenCalledWith("b")
  })
  it("moves up on ArrowUp", () => {
    const onSelect = vi.fn()
    const { result } = renderHook(() =>
      useListKeyboardNav({ items: ["a", "b", "c"], selectedItem: "b", onSelect })
    )
    act(() => {
      result.current.onKeyDown({ key: "ArrowUp", preventDefault: vi.fn() } as any)
    })
    expect(onSelect).toHaveBeenCalledWith("a")
  })
  it("ignores other keys", () => {
    const onSelect = vi.fn()
    const { result } = renderHook(() =>
      useListKeyboardNav({ items: ["a", "b"], selectedItem: "a", onSelect })
    )
    act(() => {
      result.current.onKeyDown({ key: "Enter", preventDefault: vi.fn() } as any)
    })
    expect(onSelect).not.toHaveBeenCalled()
  })
})
