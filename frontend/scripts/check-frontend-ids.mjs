#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

const sourceDir = new URL("../src", import.meta.url)
const forbiddenPattern =
  /\brandomUUID\s*\(|from\s+["'](?:node:)?uuid["']|import\s*\(\s*["'](?:node:)?uuid["']\s*\)/

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(path)
    } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
      yield path
    }
  }
}

const violations = []

for await (const filePath of walk(sourceDir.pathname)) {
  const content = await readFile(filePath, "utf8")
  const relativePath = filePath.slice(filePath.indexOf("src/"))
  const lines = content.split("\n")
  lines.forEach((line, index) => {
    if (forbiddenPattern.test(line)) {
      violations.push(`${relativePath}:${index + 1} UUID generation is forbidden`)
    }
  })
}

if (violations.length > 0) {
  console.error(`Frontend ID check failed (${violations.length} violation${violations.length === 1 ? "" : "s"}):`)
  for (const violation of violations) {
    console.error(`  ${violation}`)
  }
  process.exit(1)
}

console.log("Frontend ID check passed.")
