import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { ChatSurfaceShell } from "@/features/agents"

describe("ChatSurfaceShell", () => {
  it("renders messagesSlot", () => {
    render(<ChatSurfaceShell messagesSlot={<div data-testid="msgs">messages</div>} />)
    expect(screen.getByTestId("msgs")).toBeDefined()
  })

  it("renders optional slots", () => {
    render(
      <ChatSurfaceShell
        titleSlot={<div data-testid="title">title</div>}
        beforeMessagesSlot={<div data-testid="before">before</div>}
        messagesSlot={<div data-testid="msgs">messages</div>}
        afterMessagesSlot={<div data-testid="after">after</div>}
        footerSlot={<div data-testid="footer">footer</div>}
      />,
    )
    expect(screen.getByTestId("title")).toBeDefined()
    expect(screen.getByTestId("before")).toBeDefined()
    expect(screen.getByTestId("msgs")).toBeDefined()
    expect(screen.getByTestId("after")).toBeDefined()
    expect(screen.getByTestId("footer")).toBeDefined()
  })

  it("omits optional slots when not provided", () => {
    render(<ChatSurfaceShell messagesSlot={<div data-testid="msgs">messages</div>} />)
    expect(screen.queryByTestId("title")).toBeNull()
    expect(screen.queryByTestId("footer")).toBeNull()
  })
})
