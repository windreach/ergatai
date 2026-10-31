import { describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"
import { StrictMode } from "react"
import { ChatMarkdownRenderer } from "@/components/chat-markdown-renderer"

vi.mock("@/lib/hooks/use-code-theme", () => ({
  useCodeTheme: () => "ergatai-dark",
}))

const content = `# Test\n\n你好\n\n\`\`\`bash\nls -la\n\`\`\`\n\n| A | B |\n|---|---|\n| 1 | 2 |\n`

describe("chat markdown renderer smoke", () => {
  it("renders then toggles streaming under StrictMode", () => {
    const view = render(<StrictMode><ChatMarkdownRenderer content={content} isStreaming /></StrictMode>)
    view.rerender(<StrictMode><ChatMarkdownRenderer content={content + " more"} isStreaming /></StrictMode>)
    view.rerender(<StrictMode><ChatMarkdownRenderer content={content + " more"} isStreaming={false} /></StrictMode>)
    expect(view.container.textContent).toContain("Test")
  })
})
