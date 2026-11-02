#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"

const root = new URL("../", import.meta.url).pathname
const srcDir = join(root, "src")
const baselinePath = join(root, "scripts/architecture-baseline.json")
const THRESHOLD = 500

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) yield path
  }
}

const large = []
for await (const filePath of walk(srcDir)) {
  const content = await readFile(filePath, "utf8")
  const lines = content.split("\n").length
  if (lines > THRESHOLD) {
    large.push({ file: relative(root, filePath), lines })
  }
}

let baseline = null
try {
  const raw = await readFile(baselinePath, "utf8")
  const json = JSON.parse(raw)
  baseline = json.largeFiles ?? null
} catch {
  // initialize baseline
  const { writeFile } = await import("node:fs/promises")
  let existing = {}
  try { existing = JSON.parse(await readFile(baselinePath, "utf8")) } catch {}
  existing.largeFiles = large.length
  await writeFile(baselinePath, JSON.stringify(existing, null, 2) + "\n", "utf8")
  console.log(`Baseline initialized: largeFiles=${large.length}`)
  process.exit(0)
}

if (baseline === null) {
  const { writeFile } = await import("node:fs/promises")
  let existing = {}
  try { existing = JSON.parse(await readFile(baselinePath, "utf8")) } catch {}
  existing.largeFiles = large.length
  await writeFile(baselinePath, JSON.stringify(existing, null, 2) + "\n", "utf8")
  console.log(`Baseline initialized: largeFiles=${large.length}`)
  process.exit(0)
}

if (large.length > baseline) {
  console.error(`File size check failed: ${large.length} files > ${THRESHOLD} lines (baseline ${baseline})\n`)
  for (const f of large.slice(baseline)) {
    console.error(`  ${f.file} (${f.lines} lines)`)
  }
  process.exit(1)
}

console.log(`File size check passed: ${large.length} files > ${THRESHOLD} lines (baseline ${baseline}).`)
