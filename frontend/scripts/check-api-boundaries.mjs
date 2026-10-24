#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

const routerDir = new URL("../src/main/lib/trpc/routers", import.meta.url)

// These checks are intentionally narrow. The goal is to catch the highest-risk
// mistakes: raw backend DTO arrays/objects escaping a tRPC route without going
// through an explicit mapper. Mapper functions may still import Backend* types.
const checks = [
  {
    name: "raw backend DTO returned directly",
    pattern:
      /return\s+ergataiFetch\s*<\s*Backend(?:Message|Conversation|Chat|Project|Workspace|AgentBinding|WorkspaceProject|WorkspaceStatus)(?:\[\])?\b/,
    hint:
      "Map the backend DTO before returning it (for example: mapConversation, mapMessage, mapBackendMessagesToUiMessages).",
  },
  {
    name: "raw messages/conversations serialized without mapping",
    pattern:
      /\b(?:messages|conversations)\s*:\s*JSON\.stringify\(\s*(?:messages|backendMessages|persistedMessages|chatConversations|conversations)\s*\)/,
    hint:
      "Serialize a mapped UI DTO (for example: JSON.stringify(mapBackendMessagesToUiMessages(messages))).",
  },
  {
    name: "raw messages/conversations array assigned to response field",
    pattern:
      /\b(?:messages|conversations)\s*:\s*(?:messages|backendMessages|persistedMessages|chatConversations|conversations)\b/,
    hint:
      "Assign a mapped UI DTO, not the raw Backend DTO variable.",
  },
]

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(path)
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      yield path
    }
  }
}

const violations = []

for await (const filePath of walk(routerDir.pathname)) {
  const content = await readFile(filePath, "utf8")
  const relativePath = filePath.slice(filePath.indexOf("src/main/lib/trpc/routers/"))

  for (const check of checks) {
    const pattern = new RegExp(check.pattern.source, "gm")
    let match
    while ((match = pattern.exec(content)) !== null) {
      const line = content.slice(0, match.index).split("\n").length
      violations.push(
        `${relativePath}:${line} ${check.name}\n  ${match[0]}\n  ${check.hint}`,
      )
    }
  }
}

if (violations.length > 0) {
  console.error(`API boundary check failed (${violations.length} violation${violations.length === 1 ? "" : "s"}):\n`)
  for (const violation of violations) {
    console.error(violation)
  }
  process.exit(1)
}

console.log("API boundary check passed.")
