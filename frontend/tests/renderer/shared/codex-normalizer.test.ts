import { describe, it, expect } from "vitest"
import { normalizeCodexToolPart, normalizeCodexStreamChunk } from "../../../src/shared/codex-tool-normalizer"

describe("normalizeCodexToolPart", () => {
  it("returns non-tool parts unchanged", () => {
    const part = { type: "text", text: "hi" }
    expect(normalizeCodexToolPart(part)).toBe(part)
  })
  it("normalizes verb-based tool name to canonical", () => {
    const part = { type: "tool-Read", toolName: "Read foo.ts", state: "input-available" }
    const out: any = normalizeCodexToolPart(part, { normalizeState: true })
    expect(out.type).toBe("tool-Read")
    expect(out.input.file_path).toBe("foo.ts")
    expect(out.state).toBe("call")
  })
  it("normalizes MCP tool name", () => {
    const part = { type: "tool-Tool", toolName: "Tool:server/toolName", input: { args: { x: 1 } } }
    const out: any = normalizeCodexToolPart(part)
    expect(out.type).toBe("tool-mcp__server__toolName")
  })
})

describe("normalizeCodexStreamChunk", () => {
  it("returns non-tool chunks unchanged", () => {
    const chunk = { type: "text-delta", text: "hi" }
    expect(normalizeCodexStreamChunk(chunk)).toBe(chunk)
  })
  it("normalizes tool-input-start with verb", () => {
    const chunk = { type: "tool-input-start", toolName: "Read foo.ts" }
    const out: any = normalizeCodexStreamChunk(chunk)
    expect(out.toolName).toBe("Read")
  })
})
