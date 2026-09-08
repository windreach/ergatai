import { apiUrl, runtime } from "../config/runtime";

export interface WorkspaceInfo {
  id: string;
  backend: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  state: string;
  workDir: string;
}

export interface GitBranchInfo {
  current: string;
  branches: string[];
}

const mockWorkspaces: WorkspaceInfo[] = [
  { id: "default", backend: "local" },
  { id: "frontend", backend: "local" },
];

const mockAgents: AgentSummary[] = [];

const mockBranches: GitBranchInfo = { current: "main", branches: ["main", "develop", "feat/ui"] };

function isMock(): boolean {
  return runtime.chatMode === "mock";
}

export async function fetchWorkspaces(): Promise<WorkspaceInfo[]> {
  if (isMock()) return mockWorkspaces;
  const res = await fetch(apiUrl("/api/v1/workspaces"));
  if (!res.ok) throw new Error(`Failed to list workspaces (${res.status})`);
  return (await res.json()) as WorkspaceInfo[];
}

export async function fetchAgents(): Promise<AgentSummary[]> {
  if (isMock()) return mockAgents;
  const res = await fetch(apiUrl("/api/v1/agents"));
  if (!res.ok) throw new Error(`Failed to list agents (${res.status})`);
  const raw: Array<Record<string, unknown>> = await res.json();
  return raw.map((a) => ({
    id: String(a.agent_id ?? ""),
    name: String(a.stable_id ?? a.agent_id ?? ""),
    state: String(a.state ?? "unknown"),
    workDir: String(a.work_dir ?? ""),
  }));
}

export async function fetchGitBranches(_workDir?: string): Promise<GitBranchInfo> {
  if (isMock()) return mockBranches;
  // TODO: add a lightweight GET /api/v1/git/branches endpoint to ergatai-api
  return mockBranches;
}
