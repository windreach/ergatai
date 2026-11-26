#!/usr/bin/env node
/**
 * Install the JS ACP adapters into the Electron resource directory.
 *
 * We intentionally use --omit=optional so the large platform-specific agent
 * CLIs (Claude Code / Codex) are NOT bundled. The adapters use the user's
 * externally installed `claude` / `codex` binaries instead (the backend points
 * CLAUDE_CODE_EXECUTABLE / CODEX_PATH at them).
 *
 * Usage: node scripts/prepare-adapters.mjs
 * Output:
 *   frontend/resources/bin/<platform>-<arch>/adapters/node_modules
 *   frontend/resources/bin/<platform>-<arch>/adapters/manifest.json
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")
const OUT_ROOT = join(ROOT, "frontend", "resources", "bin")

const ADAPTERS = {
  "@agentclientprotocol/claude-agent-acp": "0.112.0",
  "@agentclientprotocol/codex-acp": "2.12.0",
}

function platformDir() {
  const platform = process.platform === "darwin" ? "darwin" : process.platform
  const arch = process.arch
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`prepare-adapters: unsupported platform ${process.platform}`)
  }
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`prepare-adapters: unsupported arch ${arch}`)
  }
  return `${platform}-${arch}`
}

const targetDir = join(OUT_ROOT, platformDir(), "adapters")
const manifestPath = join(targetDir, "manifest.json")
const marker = join(targetDir, ".prepared")
const force = process.env.ERGATAI_FORCE_ADAPTERS === "1"
const skip = process.env.ERGATAI_SKIP_ADAPTERS === "1"

if (skip) {
  console.log("[prepare-adapters] skipped (ERGATAI_SKIP_ADAPTERS=1)")
  process.exit(0)
}

if (!force && existsSync(marker) && existsSync(manifestPath)) {
  console.log(`[prepare-adapters] already prepared: ${targetDir}`)
  process.exit(0)
}

mkdirSync(targetDir, { recursive: true })

const specs = Object.entries(ADAPTERS).map(([name, version]) => `${name}@${version}`)
console.log(`[prepare-adapters] installing ${specs.join(", ")}`)
try {
  execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      "--prefix",
      targetDir,
      "--omit=optional",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      ...specs,
    ],
    { stdio: "inherit", env: process.env },
  )
} catch (error) {
  throw new Error(
    `prepare-adapters: npm install failed. Install Node.js/npm or set ERGATAI_SKIP_ADAPTERS=1. (${error.message})`,
  )
}

writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      adapters: ADAPTERS,
    },
    null,
    2,
  ) + "\n",
)
writeFileSync(marker, "")
console.log(`[prepare-adapters] bundled adapters: ${targetDir}`)
