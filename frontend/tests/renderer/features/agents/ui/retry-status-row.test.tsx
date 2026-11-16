import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"

import { RetryStatusRow } from "@/features/agents/ui/retry-status-row"

describe("RetryStatusRow", () => {
  it("shows the attempt counter and calls onStop", () => {
    const onStop = vi.fn()
    render(
      <RetryStatusRow
        retry={{
          attempt: 3,
          maxAttempts: 20,
          delayMs: 4_000,
          nextRetryAtMs: 0,
          errorName: "rate_limit",
        }}
        onStop={onStop}
      />,
    )

    expect(screen.getByText("正在自动重试 3/20")).toBeTruthy()
    expect(screen.getByText("· 正在重试…")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /停止/ }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})
