import { selectBackend } from "./backend";
import { runtime } from "../config/runtime";

export type ReviewDecision = "pending" | "approved" | "changes-requested" | "rejected";
export type ReviewCheckStatus = "passed" | "failed" | "running" | "skipped";

export interface ReviewFile {
  id: string;
  path: string;
  language: string;
  oldText: string;
  newText: string;
  additions: number;
  deletions: number;
}

export interface ReviewCheck {
  id: string;
  name: string;
  status: ReviewCheckStatus;
  duration: string;
  message?: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: number;
}

export interface ReviewSummary {
  id: string;
  title: string;
  agent: string;
  branch: string;
  createdAt: number;
  decision: ReviewDecision;
  additions: number;
  deletions: number;
  fileCount: number;
}

export interface ReviewDetail extends ReviewSummary {
  files: ReviewFile[];
  checks: ReviewCheck[];
  comments: ReviewComment[];
}

export interface ReviewBackend {
  list: () => Promise<ReviewSummary[]>;
  get: (id: string) => Promise<ReviewDetail>;
  decide: (id: string, decision: Exclude<ReviewDecision, "pending">) => Promise<ReviewDetail>;
}

const hour = 60 * 60 * 1000;

function reviewSummary(detail: ReviewDetail): ReviewSummary {
  return {
    id: detail.id,
    title: detail.title,
    agent: detail.agent,
    branch: detail.branch,
    createdAt: detail.createdAt,
    decision: detail.decision,
    additions: detail.additions,
    deletions: detail.deletions,
    fileCount: detail.fileCount,
  };
}

const initialReviews: ReviewDetail[] = [
  {
    id: "review-auth-hardening",
    title: "Harden authentication flow",
    agent: "Codex",
    branch: "codex/auth-hardening",
    createdAt: Date.now() - hour,
    decision: "pending",
    additions: 71,
    deletions: 24,
    fileCount: 6,
    files: [
      {
        id: "auth-service",
        path: "src/services/auth.ts",
        language: "typescript",
        additions: 26,
        deletions: 9,
        oldText: `export async function login(email: string, password: string) {
  const response = await fetch("/api/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    throw new Error("Login failed");
  }

  return response.json();
}`,
        newText: `interface LoginResult {
  accessToken: string;
  expiresAt: number;
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(\`Login failed: \${response.status}\`);
  }

  const result = (await response.json()) as LoginResult;

  if (!result.accessToken || result.expiresAt <= Date.now()) {
    throw new Error("Invalid authentication response");
  }

  return result;
}`,
      },
      {
        id: "auth-docs",
        path: "docs/authentication.md",
        language: "markdown",
        additions: 8,
        deletions: 2,
        oldText: `# Authentication

The client sends an email and password to \`/api/login\`.
The server returns an access token.`,
        newText: `# Authentication

The client sends an email and password to \`/api/login\`.
Requests time out after ten seconds.

The response must contain an access token and an absolute expiry time.
The client rejects malformed or expired authentication responses.`,
      },
      {
        id: "auth-hooks",
        path: "src/hooks/useSession.ts",
        language: "typescript",
        additions: 11,
        deletions: 3,
        oldText: `export function useSession() {
  return { ready: true };
}`,
        newText: `export function useSession() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    restoreSession().finally(() => setReady(true));
  }, []);

  return { ready };
}`,
      },
      {
        id: "auth-routes",
        path: "src/routes/login.tsx",
        language: "typescript",
        additions: 8,
        deletions: 1,
        oldText: `export default function Login() {
  return <form />;
}`,
        newText: `export default function Login() {
  return (
    <form preventDefault onSubmit={login}>
      <input name="email" required type="email" />
      <input name="password" required type="password" />
    </form>
  );
}`,
      },
      {
        id: "auth-api",
        path: "src/api/auth.ts",
        language: "typescript",
        additions: 6,
        deletions: 4,
        oldText: `export async function restoreSession() {
  return fetch("/api/session");
}`,
        newText: `export async function restoreSession() {
  const response = await fetch("/api/session");

  if (!response.ok) {
    throw new Error("Session restoration failed");
  }

  return response.json();
}`,
      },
      {
        id: "auth-tests",
        path: "tests/auth.test.ts",
        language: "typescript",
        additions: 9,
        deletions: 0,
        oldText: `it("logs in", async () => {
  await expect(login("user", "pass")).resolves.toBeTruthy();
});`,
        newText: `it("logs in", async () => {
  const result = await login("user", "pass");

  expect(result.accessToken).toBeTruthy();
  expect(result.expiresAt).toBeGreaterThan(Date.now());
});`,
      },
      {
        id: "auth-env",
        path: ".env.example",
        language: "ini",
        additions: 3,
        deletions: 3,
        oldText: `API_URL=http://localhost:3000
TOKEN_TTL=3600`,
        newText: `API_URL=http://127.0.0.1:3000
ACCESS_TOKEN_TTL=3600
SESSION_RESTORE_TIMEOUT=10000`,
      },
    ],
    checks: [
      { id: "lint", name: "Lint", status: "passed", duration: "4s" },
      { id: "types", name: "TypeScript", status: "passed", duration: "8s" },
      { id: "tests", name: "Unit tests", status: "failed", duration: "16s", message: "2 expired-token tests failed" },
      { id: "security", name: "Security scan", status: "running", duration: "12s" },
    ],
    comments: [
      {
        id: "comment-expiry",
        author: "Reviewer",
        body: "Token expiry should be compared against the server time returned in the response.",
        createdAt: Date.now() - 20 * 60 * 1000,
      },
    ],
  },
  {
    id: "review-terminal-config",
    title: "Extract terminal configuration",
    agent: "Claude Code",
    branch: "claude/terminal-config",
    createdAt: Date.now() - 5 * hour,
    decision: "approved",
    additions: 12,
    deletions: 4,
    fileCount: 1,
    files: [
      {
        id: "terminal-config",
        path: "src/config/terminal.ts",
        language: "typescript",
        additions: 12,
        deletions: 4,
        oldText: `export const terminalOptions = {
  fontSize: 13,
  scrollback: 5000,
};`,
        newText: `export interface TerminalOptions {
  fontSize: number;
  scrollback: number;
}

export const terminalOptions: TerminalOptions = {
  fontSize: 13,
  scrollback: 5000,
};`,
      },
    ],
    checks: [
      { id: "lint", name: "Lint", status: "passed", duration: "3s" },
      { id: "types", name: "TypeScript", status: "passed", duration: "7s" },
      { id: "tests", name: "Unit tests", status: "passed", duration: "14s" },
      { id: "security", name: "Security scan", status: "passed", duration: "21s" },
    ],
    comments: [],
  },
];

export class MockReviewBackend implements ReviewBackend {
  private reviews = new Map(initialReviews.map((review) => [review.id, { ...review }]));

  async list() {
    return [...this.reviews.values()]
      .map(reviewSummary)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async get(id: string) {
    const review = this.reviews.get(id);
    if (!review) throw new Error(`Review not found: ${id}`);
    return structuredClone(review);
  }

  async decide(id: string, decision: Exclude<ReviewDecision, "pending">) {
    const review = this.reviews.get(id);
    if (!review) throw new Error(`Review not found: ${id}`);
    review.decision = decision;
    return structuredClone(review);
  }
}

export const mockReviewBackend = new MockReviewBackend();

export const reviewBackend = selectBackend(
  "review",
  runtime.reviewMode,
  mockReviewBackend,
);
