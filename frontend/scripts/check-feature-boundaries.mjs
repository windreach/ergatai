#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative, resolve, dirname, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = new URL("../", import.meta.url).pathname
const featuresDir = join(root, "src/renderer/features")
const baselinePath = join(root, "scripts/architecture-baseline.json")

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) yield path
  }
}

function featureOfPath(p) {
  const rel = relative(featuresDir, p).split(sep)
  return rel.length > 0 ? rel[0] : null
}

function isPublicRemainder(remainder) {
  if (!remainder || remainder === "index" || remainder === "index.ts" || remainder === "index.tsx") return true
  const first = remainder.split("/")[0]
  return first === "contracts" || first === "public"
}

function resolveTargetFeature(sourceFile, spec) {
  // alias
  let m = spec.match(/^@\/(?:renderer\/)?features\/([^/]+)(?:\/(.*))?$/)
  if (m) return { feature: m[1], remainder: m[2] || "" }

  // relative
  if (spec.startsWith(".")) {
    const resolved = resolve(dirname(sourceFile), spec)
    const rel = relative(featuresDir, resolved)
    if (!rel.startsWith("..")) {
      const parts = rel.split(sep)
      if (parts.length >= 2) {
        return { feature: parts[0], remainder: parts.slice(1).join("/") }
      }
    }
  }
  return null
}

const importRegex = /(?:from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\))/g

const violations = []
for await (const filePath of walk(featuresDir)) {
  const sourceFeature = featureOfPath(filePath)
  if (!sourceFeature) continue
  const content = await readFile(filePath, "utf8")
  let match
  while ((match = importRegex.exec(content)) !== null) {
    const spec = match[1] || match[2]
    const target = resolveTargetFeature(filePath, spec)
    if (!target) continue
    if (target.feature === sourceFeature) continue
    if (isPublicRemainder(target.remainder.replace(/\.(ts|tsx)$/, ""))) continue
    violations.push({
      file: relative(root, filePath),
      import: spec,
      target: `${target.feature}/${target.remainder}`,
    })
  }
}

// baseline
let baseline = 0
try {
  const raw = await readFile(baselinePath, "utf8")
  const json = JSON.parse(raw)
  baseline = json.featureBoundaryViolations ?? 0
} catch {
  // no baseline yet: initialize
  await writeFileBaseline(baselinePath, { featureBoundaryViolations: violations.length, largeFiles: null })
  console.log(`Baseline initialized: featureBoundaryViolations=${violations.length}`)
  process.exit(0)
}

function writeFileBaseline(path, obj) {
  // lazy import to avoid top-level await issue? fs/promises already imported
  return import("node:fs/promises").then(({ writeFile }) =>
    writeFile(path, JSON.stringify(obj, null, 2) + "\n", "utf8")
  )
}

if (violations.length > baseline) {
  console.error(`Feature boundary check failed: ${violations.length} violations (baseline ${baseline})\n`)
  const extra = violations.length - baseline
  console.error(`New violations: ${extra}\n`)
  for (const v of violations.slice(baseline)) {
    console.error(`  ${v.file}\n    -> ${v.import}`)
  }
  process.exit(1)
}

console.log(`Feature boundary check passed: ${violations.length} violations (baseline ${baseline}).`)
