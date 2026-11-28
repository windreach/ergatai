import { describe, expect, it } from "vitest"

import { toQueuedFile } from "@/features/agents/lib/queue-utils"
import type { UploadedFile } from "@/features/agents/hooks/use-agents-file-upload"

describe("toQueuedFile", () => {
  it("preserves the file payload needed by backend delivery", () => {
    const file: UploadedFile = {
      id: "file-1",
      url: "blob:file-1",
      filename: "example.txt",
      type: "text/plain",
      size: 4,
      base64Data: "YWJj",
      isLoading: false,
    }

    expect(toQueuedFile(file)).toEqual({
      id: file.id,
      url: file.url,
      filename: file.filename,
      mediaType: file.type,
      size: file.size,
      base64Data: file.base64Data,
    })
  })
})
