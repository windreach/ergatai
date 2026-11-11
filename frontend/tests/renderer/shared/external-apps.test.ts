import { describe, it, expect } from "vitest"
import { externalAppSchema, APP_META, EXTERNAL_APPS } from "../../../src/shared/external-apps"

describe("externalAppSchema", () => {
  it("accepts known app", () => {
    expect(externalAppSchema.safeParse("vscode").success).toBe(true)
  })
  it("rejects unknown app", () => {
    expect(externalAppSchema.safeParse("nope").success).toBe(false)
  })
})

describe("APP_META", () => {
  it("has meta for every app", () => {
    for (const app of EXTERNAL_APPS) {
      expect(APP_META[app]).toBeDefined()
      expect(APP_META[app].label).toBeTruthy()
    }
  })
})
