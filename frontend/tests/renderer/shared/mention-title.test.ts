import { describe, expect, it } from "vitest"
import {
  mentionsToReadableText,
  promptToTitle,
} from "../../../src/shared/mention-title"

describe("promptToTitle", () => {
  it("replaces file mentions with the file name", () => {
    expect(
      promptToTitle("@[file:local:Antigravity-x64/locales/fil.pak] hello"),
    ).toBe("fil.pak hello")
  })

  it("replaces folder mentions with the folder name", () => {
    expect(promptToTitle("@[folder:local:src/renderer] review this")).toBe(
      "renderer review this",
    )
  })

  it("keeps the readable form of agent, skill and command mentions", () => {
    expect(
      promptToTitle(
        "@[agent:reviewer] use @[skill:typescript] and @[command:test]",
      ),
    ).toBe("@reviewer use /typescript and /test")
  })

  it("uses the preview of content-bearing mentions", () => {
    expect(
      promptToTitle(
        "@[quote:explain this:ZXhwbGFpbg==] @[pasted:12:pasted text|/tmp/a.txt]",
      ),
    ).toBe("explain this pasted text")
  })

  it("drops tool and plugin tokens", () => {
    expect(
      promptToTitle("@[tool:mcp__server__tool] @[plugin:formatter] hi"),
    ).toBe("hi")
  })

  it("collapses whitespace and truncates to the requested length", () => {
    expect(promptToTitle("  hello\n\nworld  ", 8)).toBe("hello wo")
    expect(promptToTitle("hello\nworld")).toBe("hello world")
  })

  it("handles prompts made of only mentions", () => {
    expect(promptToTitle("@[file:local:src/app.ts]")).toBe("app.ts")
    expect(promptToTitle("@[tool:mcp__server__tool]")).toBe("")
  })

  it("does not truncate existing titles when converting mentions", () => {
    const longTitle =
      "@[file:local:src/app.ts] " + "a".repeat(120)
    expect(mentionsToReadableText(longTitle)).toBe("app.ts " + "a".repeat(120))
    expect(promptToTitle(longTitle)).toHaveLength(50)
  })
})
