import { describe, it, expect } from "vitest"
import { generateTicketId, generateQueueItemId } from "@/features/conversation/runtime/id-generators"

describe("id-generators", () => {
  it("ticket id prefix", () => {
    expect(generateTicketId()).toMatch(/^ticket_\d+_[a-z0-9]{9}$/)
  })
  it("queue id prefix", () => {
    expect(generateQueueItemId()).toMatch(/^queue_\d+_[a-z0-9]{9}$/)
  })
  it("unique", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTicketId()))
    expect(ids.size).toBe(100)
  })
})
