import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"

import { RetryStatusRow } from "@/features/agents/ui/retry-status-row"

describe("RetryStatusRow", () => {
  it("shows the attempt counter without a stop action", () => {
    render(
      <RetryStatusRow
        retry={{
          attempt: 3,
          maxAttempts: 20,
          delayMs: 4_000,
          nextRetryAtMs: 0,
          errorName: "rate_limit",
        }}
      />,
    )

    expect(screen.getByText("Automatically retrying 3/20")).toBeTruthy()
    expect(screen.getByText("· retrying…")).toBeTruthy()
    expect(screen.queryByRole("button")).toBeNull()
  })
})
