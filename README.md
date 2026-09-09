# Ergatai

> 多 Agent 协作工作台 — Organize independent AI coding assistants into a collaborative team.

Ergatai takes standalone AI coding agents (Claude Code, Cursor, Codex, OpenCode, …) and wires them into a structured collaboration via the [Agent Client Protocol (ACP)](https://github.com/agentclientprotocol). Agents stay in their own workspaces — Ergatai handles message routing, file access control, and DAG-based task orchestration.

```
┌─────────┐  ACP   ┌──────────┐   NATS    ┌─────────┐
│ Agent A │◀──────▶│  Ergatai │◀────────▶│ Agent B │
│ (Claude)│ stdio  │  Router  │ JetStream │(Codex)  │
└─────────┘        │          │           └─────────┘
                   │  ┌─────┐ │
                   │  │Lock │ │  ◀── zero-trust file access
                   │  │DAG  │ │  ◀── task orchestration
                   │  └─────┘ │
                   └──────────┘
                         │
                   ┌─────┴─────┐
                   │ Desktop / │
                   │ CLI / API │
                   └───────────┘
```

## ✨ Features

- **Agent templating** — register `AgentProfile`s and spawn agents with one command
- **ACP-native** — speaks the open Agent Client Protocol (JSON-RPC over stdio), MCP tools exposed to every agent
- **Zero-trust file access** — per-agent `FileToken`s, Git COW snapshots (TOCTOU-safe), advisory locks tracked in SQLite WAL
- **DAG orchestration** — submit a YAML task graph; budget, timeout tiers (Warn → Escalate → Fail), and mesh policies (Open / Adjacent / Star / Restricted) are enforced
- **Reliable messaging** — NATS JetStream persistence, read receipts, request correlation + auto-timeout (`reqwatch`)
- **Defensive by default** — per-agent rate limits (60 msg/min), NATS back-pressure, stall + idle watchers, conversation loop guards, graceful shutdown on SIGINT/SIGTERM
- **Four interfaces** — Tauri desktop app, `ergatai` CLI, REST API, and MCP over Streamable HTTP

## 📦 Crate layout

```
crates/
  ergatai-api        HTTP + MCP server (axum, tower-governor)
  ergatai-runtime    Agent lifecycle, ACP backend, profile registry
  ergatai-collab     DAG scheduler, task coordinator, collaboration sessions
  ergatai-dag        YAML parser + strict 9-rule validation, template engine
  ergatai-nats       Embedded nats-server + JetStream event bus
  ergatai-lock       File access control (zero-trust tokens, Git COW)
  ergatai-core       Facade: unified registry, cross-crate integration
  ergatai-error      Shared error types
  ergatai-cli        `ergatai` CLI (clap + ratatui TUI)
  ergatai-agent      Agent configuration & discovery
  ergatai-binary     Locates / downloads embedded nats-server
  ergatai-preload    Preload hooks
frontend/            Tauri + React + Vite desktop app (npm workspaces)
```

## 🚀 Quick start

### Prerequisites

- Rust **1.88+** (see `rust-version` in `Cargo.toml`)
- Node.js **20+** (for the desktop frontend)
- `cargo`, `npm`

### Build

```bash
# Backend (all crates)
cargo build --workspace

# Just the API server
cargo build -p ergatai-api

# Just the CLI
cargo build -p ergatai-cli

# Desktop app (frontend + Tauri shell)
cd frontend && npm install && npm run tauri dev
```

### Run the API server

```bash
cargo run -p ergatai-api -- --port 3000 --verbose

# With API token authentication
ERGATAI_API_TOKEN=secret cargo run -p ergatai-api -- --port 3000 --api-token secret

# With TLS
cargo run -p ergatai-api -- \
  --tls-cert cert.pem --tls-key key.pem
```

### Use the CLI

```bash
export ERGATAI_API_URL=http://localhost:3000

ergatai start frontend-agent --work-dir ./frontend   # workspace + agent + attach
ergatai workspace list
ergatai agent spawn --profile claude-swe
ergatai agent list
ergatai agent message ws1-agent-1 "refactor auth module"
ergatai status --watch
```

## 🔌 Interfaces

| Interface | Endpoint | Notes |
|-----------|----------|-------|
| REST API | `http://localhost:3000/api/v1/*` | Workspaces, agents, DAGs, locks, activity |
| MCP | `POST /mcp/{agent}/*` | JSON-RPC 2025-06-18, one path per agent |
| SSE | `GET /api/v1/activity/stream` | Live activity events |
| Metrics | `GET /metrics` | Prometheus format |
| Desktop | Tauri window | React + Monaco + terminal panes |
| CLI | `ergatai` binary | See `ergatai --help` |

### MCP tools available to every agent

| Tool | Purpose |
|------|---------|
| `list_agents` | Discover peers (with filters) |
| `send_message` | Rate-limited, conversation-guarded, mesh-policy-checked delivery |
| `submit_orchestration` | Submit a DAG workflow (YAML) |
| `validate_dag_yaml` | Dry-run DAG validation |
| `get_dag_status` | Inspect a running DAG + its collaboration session |

## 🛡️ Security & safety

- **Advisory file locks** — tokens are per-session, versioned; Git COW snapshots prevent TOCTOU
- **Per-agent rate limit** — sliding window, 60 msg/min (TOCTOU-safe)
- **NATS back-pressure** — 1000 pending messages → reject + 5s cache
- **Mesh policy enforcement** — `send_message` is ACL-checked against every active `CollaborationSession`
- **Defensive timeouts** — warn at 50%, escalate at 80%, fail at 100% of `node_timeout_secs`
- **No secrets in source** — all auth via env vars (`ERGATAI_API_TOKEN`) or CLI flags

See `CLAUDE.md` for the full data-flow diagram, defensive-orchestration design, and subject naming conventions.

## 🧪 Testing

```bash
cargo test --workspace
cargo test -p ergatai-api
cargo test -p ergatai-runtime
cargo test -p ergatai-dag
cargo test -p ergatai-lock
```

Lint:

```bash
cargo clippy --workspace -- -D warnings
cargo fmt --all
```

## ⚙️ Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `ERGATAI_API_URL` | `http://localhost:3000` | CLI target |
| `ERGATAI_API_TOKEN` | — | API auth token |
| `ERGATAI_SSE_KEEP_ALIVE` | `15` | SSE keep-alive interval (seconds) |
| `ERGATAI_BACKPRESSURE_THRESHOLD` | `1000` | NATS pending-message ceiling |

Server flags (`ergatai-api`):

| Flag | Default | Purpose |
|------|---------|---------|
| `--port` | `3000` | Listen port |
| `--host` | `127.0.0.1` | Bind address |
| `--verbose` / `-v` | `false` | Debug logging |
| `--api-token` | — | Auth token (overrides env) |
| `--tls-cert` / `--tls-key` | — | PEM TLS certificate + key |
| `--sse-keep-alive` | `15` | SSE keep-alive interval |

## 🗺️ Roadmap

🚧 **Frontend in active development** — the Tauri + React desktop app is under active construction. See `frontend/` for current work.

## 🤝 Contributing

Contributions welcome. Before opening a PR:

1. Run `cargo fmt --all` and `cargo clippy --workspace -- -D warnings`
2. Add tests for any new behavior (target ≥ 80% coverage for new modules)
3. Keep commits conventional (`feat:`, `fix:`, `refactor:`, …)
4. See `CLAUDE.md` for architectural details and invariants worth preserving

## 📄 License

Apache-2.0 — see [LICENSE](./LICENSE).
