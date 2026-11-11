import { describe, it, expect } from "vitest"
import { extractTriggerConfig } from "@/features/agents/discovery/use-registered-triggers"

describe("extractTriggerConfig", () => {
  const triggers = [
    { char: "@", position: "standalone" as const, types: ["file"], kind: "mention" as const },
    { char: "/", position: "start-of-line" as const, types: ["skill"], kind: "slash" as const },
  ]

  it("returns config for existing char", () => {
    const cfg = extractTriggerConfig(triggers, "@", "anywhere")
    expect(cfg).toEqual({ char: "@", position: "standalone" })
  })

  it("returns undefined for missing char", () => {
    expect(extractTriggerConfig(triggers, "#", "anywhere")).toBeUndefined()
  })

  it("falls back to defaultPosition when trigger.position missing", () => {
    const t = [{ char: "!", types: ["x"] }]
    const cfg = extractTriggerConfig(t as any, "!", "standalone")
    expect(cfg).toEqual({ char: "!", position: "standalone" })
  })
})
