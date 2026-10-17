/**
 * Model Snapshot Store — Persistent storage for agent model lists
 *
 * Provides atomic JSON file operations for persisting model snapshots
 * across app restarts. Uses temp file + rename pattern to prevent corruption.
 */

import { app } from "electron"
import { join } from "path"
import { readFile, writeFile, rename, mkdir } from "fs/promises"
import { existsSync } from "fs"

// ── Types ──

export interface ModelSnapshot {
  models: string[]
  current?: string
  generation: number // Monotonic counter for write ordering
  timestamp: number // Unix timestamp in milliseconds
  isStale: boolean // True if agent was not idle when fetched
}

export interface ModelSnapshotStore {
  [cacheKey: string]: ModelSnapshot // cacheKey = `${profile}:${workspace_id}`
}

// ── File Path ──

function getSnapshotFilePath(): string {
  return join(app.getPath("userData"), "model-snapshots.json")
}

// ── Load ──

/**
 * Load all model snapshots from disk.
 * Returns empty object if file doesn't exist or is corrupted.
 */
export async function loadSnapshots(): Promise<ModelSnapshotStore> {
  const filePath = getSnapshotFilePath()

  if (!existsSync(filePath)) {
    return {}
  }

  try {
    const content = await readFile(filePath, "utf-8")
    const parsed = JSON.parse(content)

    // Validate structure
    if (typeof parsed !== "object" || parsed === null) {
      console.warn("[ModelSnapshotStore] Invalid snapshot file structure, returning empty")
      return {}
    }

    // Validate each snapshot
    const validated: ModelSnapshotStore = {}
    for (const [key, snapshot] of Object.entries(parsed)) {
      if (isValidSnapshot(snapshot)) {
        validated[key] = snapshot as ModelSnapshot
      } else {
        console.warn(`[ModelSnapshotStore] Invalid snapshot for key "${key}", skipping`)
      }
    }

    return validated
  } catch (err) {
    console.error("[ModelSnapshotStore] Failed to load snapshots:", err)
    return {}
  }
}

// ── Save ──

/**
 * Save all model snapshots to disk using atomic write pattern.
 * Writes to temp file first, then renames to target to prevent corruption.
 */
export async function saveSnapshots(snapshots: ModelSnapshotStore): Promise<void> {
  const filePath = getSnapshotFilePath()
  const tempPath = `${filePath}.tmp`

  try {
    // Ensure directory exists
    const dir = join(app.getPath("userData"))
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }

    // Write to temp file
    const content = JSON.stringify(snapshots, null, 2)
    await writeFile(tempPath, content, "utf-8")

    // Atomic rename
    await rename(tempPath, filePath)
  } catch (err) {
    console.error("[ModelSnapshotStore] Failed to save snapshots:", err)
    throw err
  }
}

// ── Validation ──

function isValidSnapshot(obj: unknown): obj is ModelSnapshot {
  if (typeof obj !== "object" || obj === null) {
    return false
  }

  const snapshot = obj as Record<string, unknown>

  // Required fields
  if (!Array.isArray(snapshot.models)) {
    return false
  }

  if (typeof snapshot.generation !== "number") {
    return false
  }

  if (typeof snapshot.timestamp !== "number") {
    return false
  }

  if (typeof snapshot.isStale !== "boolean") {
    return false
  }

  // Optional field
  if (snapshot.current !== undefined && typeof snapshot.current !== "string") {
    return false
  }

  return true
}
