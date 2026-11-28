import { describe, expect, it } from "vitest"

import {
  extractInitialPrompt,
  initialMessagePartSchema,
} from "../../../src/main/lib/trpc/routers/chat-initial-message"

describe("initial message attachments", () => {
  it("accepts and extracts a file-only initial message", () => {
    const part = {
      type: "data-file",
      data: {
        url: "blob:file-1",
        filename: "example.txt",
        mediaType: "text/plain",
        size: 4,
        base64Data: "YWJj",
      },
    }

    expect(initialMessagePartSchema.safeParse(part).success).toBe(true)
    expect(extractInitialPrompt([part])).toEqual({
      prompt: "",
      images: [],
      files: [
        {
          base64Data: "YWJj",
          mediaType: "text/plain",
          filename: "example.txt",
          size: 4,
        },
      ],
    })
  })

  it("keeps text, images, and hidden file content in the initial prompt", () => {
    const result = extractInitialPrompt([
      { type: "text", text: "Review this" },
      {
        type: "data-image",
        data: {
          url: "blob:image-1",
          filename: "screen.png",
          base64Data: "aW1hZ2U=",
        },
      },
      {
        type: "file-content",
        filePath: "/tmp/example.txt",
        content: "file contents",
      },
    ])

    expect(result.prompt).toBe("Review this\n\n[File: /tmp/example.txt]\nfile contents")
    expect(result.images).toEqual([
      {
        base64Data: "aW1hZ2U=",
        mediaType: "image/png",
        filename: "screen.png",
      },
    ])
    expect(result.files).toEqual([])
  })
})
