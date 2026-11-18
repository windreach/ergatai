import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"
import { AgentToolCall } from "@/features/agents/ui/agent-tool-call"

describe("AgentToolCall", () => {
  it("shows an inline failure reason without red styling", () => {
    const { container } = render(
      <TooltipProvider>
        <AgentToolCall
          title="Read"
          subtitle="this-file-does-not-exist.txt"
          isPending={false}
          isError
          errorText="File not found: this-file-does-not-exist.txt"
          inlineError
        />
      </TooltipProvider>,
    )

    expect(screen.getByText("Read")).toBeTruthy()
    expect(
      screen.getByText("File not found: this-file-does-not-exist.txt"),
    ).toBeTruthy()
    expect(container.querySelector(".text-red-500")).toBeNull()
  })

  it("does not echo a lowercase tool name as the failure reason", () => {
    render(
      <TooltipProvider>
        <AgentToolCall
          title="Read"
          subtitle="nonexistent-file.txt"
          isPending={false}
          isError
          errorText="read"
          inlineError
        />
      </TooltipProvider>,
    )

    expect(screen.getByText("Read")).toBeTruthy()
    expect(screen.queryByText("read")).toBeNull()
  })

  it("keeps the stacked error row for tools without inlineError", () => {
    render(
      <AgentToolCall
        title="Bash"
        isPending={false}
        isError
        errorText="command failed"
      />,
    )

    const title = screen.getByText("Bash")
    const error = screen.getByText("command failed")

    expect(title.className).toContain("text-red-500")
    expect(error.className).toContain("text-red-500")
  })
})
