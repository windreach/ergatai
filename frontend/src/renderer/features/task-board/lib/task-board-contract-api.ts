/**
 * Task Board Contract API — connects to Ergatai backend DAG system
 *
 * Data mapping:
 * - DAG → BoardTask (dag_id → id, progress → status)
 * - DAG Node → AgentActivity (agent → agentName, status → status)
 */

import { trpcClient } from "../../../lib/trpc"

export type TaskBoardStatus = "queued" | "running" | "completed" | "failed"
export type AgentLogoKind = "codex" | "claude-code" | "custom"

export interface BoardTask {
  id: string
  title: string
  workspaceName: string
  status: TaskBoardStatus
  startedAt: string
}

export interface AgentActivity {
  id: string
  taskId: string
  agentName: string
  logoKind: AgentLogoKind
  logoText: string
  subtaskTitle: string
  status: TaskBoardStatus
  startedAt: string
  progress: number
  lastActivity: string
}

export interface CreateTaskInput {
  /** YAML DAG definition (required for submission) */
  definition: string
  /** Template parameters for the DAG */
  parameters?: Record<string, unknown>
}

export interface ValidateTaskResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export interface TaskBoardContractApi {
  listTasks(): Promise<BoardTask[]>
  getTask(taskId: string): Promise<BoardTask | null>
  createTask(input: CreateTaskInput): Promise<BoardTask>
  validateTask(definition: string, parameters?: Record<string, unknown>): Promise<ValidateTaskResult>
  listActivities(taskId: string): Promise<AgentActivity[]>
}

// ── Backend type definitions ──────────────────────────────────────────────

interface DagInfo {
  dag_id: string
  progress: number
  is_complete: boolean
  status_prompt?: string
}

interface NodeStatusInfo {
  id: string
  agent: string
  task: string
  status: string
  depends_on: string[]
  started_at?: string
  completed_at?: string
}

interface DagStatusResponse {
  running: boolean
  progress?: number
  status_prompt?: string
  is_complete?: boolean
  nodes?: NodeStatusInfo[]
}

// ── Helper functions ──────────────────────────────────────────────────────

function mapDagStatusToTaskBoardStatus(status: string): TaskBoardStatus {
  switch (status.toLowerCase()) {
    case "completed":
    case "complete":
    case "done":
      return "completed"
    case "running":
    case "in_progress":
      return "running"
    case "failed":
    case "error":
      return "failed"
    case "pending":
    case "queued":
    default:
      return "queued"
  }
}

function mapNodeStatusToTaskBoardStatus(status: string): TaskBoardStatus {
  switch (status.toLowerCase()) {
    case "completed":
    case "complete":
    case "done":
      return "completed"
    case "running":
    case "in_progress":
      return "running"
    case "failed":
    case "error":
      return "failed"
    case "pending":
    case "queued":
    default:
      return "queued"
  }
}

function getAgentLogoKind(agentName: string): AgentLogoKind {
  const lower = agentName.toLowerCase()
  if (lower.includes("codex")) return "codex"
  if (lower.includes("claude")) return "claude-code"
  return "custom"
}

function getAgentLogoText(agentName: string): string {
  // Extract initials or short form
  const words = agentName.split(/[\s-_]+/)
  if (words.length >= 2) {
    return words.map(w => w[0]?.toUpperCase() || "").join("")
  }
  return agentName.slice(0, 2).toUpperCase()
}

// ── API Implementation ────────────────────────────────────────────────────

export const taskBoardContractApi: TaskBoardContractApi = {
  async listTasks(): Promise<BoardTask[]> {
    try {
      const dags = await trpcClient.ergatai.listDags.query() as DagInfo[]

      return dags.map((dag) => {
        const status = dag.is_complete ? "completed" :
                      dag.progress > 0 ? "running" : "queued"

        return {
          id: dag.dag_id,
          title: dag.status_prompt || `DAG ${dag.dag_id.slice(0, 8)}`,
          workspaceName: "default", // DAGs don't have workspace info in current API
          status: mapDagStatusToTaskBoardStatus(status),
          startedAt: new Date().toISOString(), // Backend doesn't provide this
        }
      })
    } catch (error) {
      console.error("[TaskBoard] Failed to list DAGs:", error)
      return []
    }
  },

  async getTask(taskId: string): Promise<BoardTask | null> {
    try {
      const dags = await trpcClient.ergatai.listDags.query() as DagInfo[]
      const dag = dags.find(d => d.dag_id === taskId)

      if (!dag) return null

      const status = dag.is_complete ? "completed" :
                    dag.progress > 0 ? "running" : "queued"

      return {
        id: dag.dag_id,
        title: dag.status_prompt || `DAG ${dag.dag_id.slice(0, 8)}`,
        workspaceName: "default",
        status: mapDagStatusToTaskBoardStatus(status),
        startedAt: new Date().toISOString(),
      }
    } catch (error) {
      console.error("[TaskBoard] Failed to get DAG:", error)
      return null
    }
  },

  async createTask(input: CreateTaskInput): Promise<BoardTask> {
    try {
      const result = await trpcClient.ergatai.submitDag.mutate({
        definition: input.definition,
        parameters: input.parameters,
      })

      return {
        id: result.submitted_nodes > 0 ? `dag-${Date.now()}` : "",
        title: `DAG (${result.submitted_nodes} nodes)`,
        workspaceName: "default",
        status: "queued",
        startedAt: new Date().toISOString(),
      }
    } catch (error) {
      console.error("[TaskBoard] Failed to submit DAG:", error)
      throw error
    }
  },

  async validateTask(definition: string, parameters?: Record<string, unknown>): Promise<ValidateTaskResult> {
    // Backend no longer supports DAG validation
    console.warn("[TaskBoard] validateDag is no longer supported")
    return { valid: true, errors: [], warnings: ["DAG validation is no longer supported by backend"] }
  },

  async listActivities(taskId: string): Promise<AgentActivity[]> {
    try {
      const status = await trpcClient.ergatai.getDagStatus.query({ dagId: taskId }) as DagStatusResponse

      if (!status.nodes || status.nodes.length === 0) {
        return []
      }

      return status.nodes.map((node, index) => {
        const agentName = node.agent || "Unknown Agent"
        const progress = node.status === "completed" ? 100 :
                        node.status === "running" ? 50 :
                        node.status === "failed" ? 100 : 0

        return {
          id: `${taskId}-node-${node.id || index}`,
          taskId: taskId,
          agentName: agentName,
          logoKind: getAgentLogoKind(agentName),
          logoText: getAgentLogoText(agentName),
          subtaskTitle: node.task || `Node ${node.id || index}`,
          status: mapNodeStatusToTaskBoardStatus(node.status),
          startedAt: node.started_at || new Date().toISOString(),
          progress: progress,
          lastActivity: node.status === "completed" ? "Task completed" :
                       node.status === "running" ? "Executing task" :
                       node.status === "failed" ? "Task failed" :
                       "Waiting to start",
        }
      })
    } catch (error) {
      console.error("[TaskBoard] Failed to list DAG nodes:", error)
      return []
    }
  },
}
