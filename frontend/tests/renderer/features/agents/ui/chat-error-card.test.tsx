import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"

import { ChatErrorCard } from "@/features/agents/ui/chat-error-card"

describe("ChatErrorCard", () => {
  it("maps model_not_found to actionable copy and keeps raw details collapsed", () => {
    render(
      <ChatErrorCard
        error={{
          message:
            'Internal error: There\'s an issue with the selected model (qwen3.7-plus).: {"errorKind": "model_not_found"} [code=model_not_found]',
          errorName: "model_not_found",
          rawText: "There's an issue with the selected model (qwen3.7-plus).",
          repeatCount: 3,
        }}
      />,
    )

    expect(screen.getByText("模型不可用")).toBeTruthy()
    expect(screen.getByText("重复 3 次")).toBeTruthy()
    expect(screen.getByText("技术详情")).toBeTruthy()
  })
})
