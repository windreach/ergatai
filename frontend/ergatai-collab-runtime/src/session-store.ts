import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { ArtifactReference, CollaborationMode } from "./protocol"

export type RuntimeRoute =
  | "single_agent_run"
  | "supervisor_session"
  | "group_session"
  | "dag_import"

export type RuntimeSessionStatus =
  | "running"
  | "awaiting_approval"
  | "completed"
  | "cancelled"
  | "failed"

export type RuntimeProgress = {
  summary: string
  status: RuntimeSessionStatus
}

export type PendingApproval = {
  runId: string
  approvalId: string
  summary: string
}

export type RuntimeSession = {
  sessionId: string
  chatId: string
  mode: CollaborationMode
  route: RuntimeRoute
  status: RuntimeSessionStatus
  lastRunId?: string
  currentStep: string
  participants: string[]
  summaries: RuntimeProgress[]
  decisions: string[]
  artifactRefs: ArtifactReference[]
  pendingApproval: PendingApproval | null
}

type PersistedStore = {
  version: 1
  sessions: RuntimeSession[]
}

const RUNTIME_ROUTES: RuntimeRoute[] = [
  "single_agent_run",
  "supervisor_session",
  "group_session",
  "dag_import",
]

const RUNTIME_STATUSES: RuntimeSessionStatus[] = [
  "running",
  "awaiting_approval",
  "completed",
  "cancelled",
  "failed",
]

export function isRuntimeRoute(value: string): value is RuntimeRoute {
  return RUNTIME_ROUTES.includes(value as RuntimeRoute)
}

function isRuntimeSession(value: unknown): value is RuntimeSession {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const record = value as Partial<RuntimeSession>
  return (
    typeof record.sessionId === "string" &&
    typeof record.chatId === "string" &&
    (record.mode === "supervisor" || record.mode === "group") &&
    typeof record.route === "string" &&
    isRuntimeRoute(record.route) &&
    typeof record.status === "string" &&
    RUNTIME_STATUSES.includes(record.status) &&
    typeof record.currentStep === "string" &&
    Array.isArray(record.participants) &&
    Array.isArray(record.summaries) &&
    Array.isArray(record.decisions) &&
    Array.isArray(record.artifactRefs) &&
    (record.pendingApproval === null || typeof record.pendingApproval === "object")
  )
}

export class SessionStore {
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly stateFile: string
  private persistQueue: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.stateFile = join(dataDir, "sessions.json")
    this.load()
  }

  list(): RuntimeSession[] {
    return Array.from(this.sessions.values())
  }

  get(sessionId: string): RuntimeSession | undefined {
    return this.sessions.get(sessionId)
  }

  save(session: RuntimeSession): void {
    this.sessions.set(session.sessionId, session)
    this.persist()
  }

  private load(): void {
    try {
      const raw = readFileSync(this.stateFile, "utf8")
      const parsed = JSON.parse(raw) as PersistedStore
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
        return
      }

      for (const session of parsed.sessions) {
        if (isRuntimeSession(session)) {
          this.sessions.set(session.sessionId, session)
        }
      }
    } catch (error) {
      // Silently ignore errors - start with empty store if file is corrupted or missing
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Failed to load session store, starting fresh:", error)
      }
    }
  }

  private persist(): void {
    const next = this.persistQueue.then(() => {
      const temporaryFile = `${this.stateFile}.tmp`
      const store: PersistedStore = {
        version: 1,
        sessions: this.list(),
      }
      writeFileSync(temporaryFile, JSON.stringify(store), "utf8")
      renameSync(temporaryFile, this.stateFile)
    })
    this.persistQueue = next.catch(() => undefined)
  }
}
