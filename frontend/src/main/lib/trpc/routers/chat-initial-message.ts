import { z } from "zod"

export const initialMessagePartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("data-image"),
    data: z.object({
      url: z.string(),
      mediaType: z.string().optional(),
      filename: z.string().optional(),
      base64Data: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("data-file"),
    data: z.object({
      url: z.string(),
      mediaType: z.string().optional(),
      filename: z.string().optional(),
      size: z.number().optional(),
      base64Data: z.string().optional(),
    }),
  }),
  // Hidden file content - sent to agent but not displayed in UI
  z.object({
    type: z.literal("file-content"),
    filePath: z.string(),
    content: z.string(),
  }),
])

export type InitialMessagePart = z.input<typeof initialMessagePartSchema>

export interface InitialPromptFile {
  base64Data: string
  mediaType: string | null
  filename: string
  size: number | null
}

export function extractInitialPrompt(parts: unknown[]): {
  prompt: string
  images: Array<{
    base64Data: string
    mediaType: string
    filename: string | null
  }>
  files: InitialPromptFile[]
} {
  const promptChunks: string[] = []
  const images: Array<{
    base64Data: string
    mediaType: string
    filename: string | null
  }> = []
  const files: InitialPromptFile[] = []

  for (const part of parts) {
    const parsed = initialMessagePartSchema.safeParse(part)
    if (!parsed.success) continue

    const typedPart = parsed.data
    if (typedPart.type === "text") {
      promptChunks.push(typedPart.text)
    } else if (typedPart.type === "data-image" && typedPart.data.base64Data) {
      images.push({
        base64Data: typedPart.data.base64Data,
        mediaType: typedPart.data.mediaType || "image/png",
        filename: typedPart.data.filename ?? null,
      })
    } else if (typedPart.type === "data-file" && typedPart.data.base64Data) {
      files.push({
        base64Data: typedPart.data.base64Data,
        mediaType: typedPart.data.mediaType ?? null,
        filename: typedPart.data.filename ?? "",
        size: typedPart.data.size ?? null,
      })
    } else if (typedPart.type === "file-content") {
      promptChunks.push(`\n\n[File: ${typedPart.filePath}]\n${typedPart.content}`)
    }
  }

  return { prompt: promptChunks.join(""), images, files }
}
