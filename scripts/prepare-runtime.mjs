#!/usr/bin/env node
/**
 * Copy the current Node.js runtime into the Electron resource directory so
 * packaged builds can run the JS-based ACP adapters without relying on the
 * user's shell PATH.
 *
 * Usage: node scripts/prepare-runtime.mjs
 * Output: frontend/resources/bin/<platform>-<arch>/node
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")
const OUT_ROOT = join(ROOT, "frontend", "resources", "bin")

function platformDir() {
  const platform = process.platform === "darwin" ? "darwin" : process.platform
  const arch = process.arch
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`prepare-runtime: unsupported platform ${process.platform}`)
  }
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`prepare-runtime: unsupported arch ${arch}`)
  }
  return `${platform}-${arch}`
}

const targetDir = join(OUT_ROOT, platformDir())
const target = join(targetDir, process.platform === "win32" ? "node.exe" : "node")
mkdirSync(targetDir, { recursive: true })

if (!process.versions.node) {
  throw new Error("prepare-runtime: must run with Node.js, not Bun/Electron")
}

const source = process.execPath
if (!existsSync(source)) {
  throw new Error(`prepare-runtime: cannot find current node binary at ${source}`)
}

const shouldCopy =
  !existsSync(target) ||
  statSync(source).size !== statSync(target).size ||
  statSync(source).mtimeMs > statSync(target).mtimeMs

if (shouldCopy) {
  copyFileSync(source, target)
  if (process.platform !== "win32") chmodSync(target, 0o755)
  console.log(`[prepare-runtime] bundled node ${process.version}: ${target}`)
} else {
  console.log(`[prepare-runtime] node already up to date: ${target}`)
}
