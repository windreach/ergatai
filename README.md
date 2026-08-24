# Ergatai

<div align="center">

<img src="assets/logo.png" alt="Ergatai Logo" width="200">

### Turn your AI coding assistants into a coordinated team.

*Claude, Cursor, Codex — working together instead of stepping on each other.*

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
&ensp;
[![Rust](https://img.shields.io/badge/rust-2021-orange.svg)](https://www.rust-lang.org)
&ensp;
[![Docs](https://img.shields.io/badge/docs-CLAUDE.md-blue.svg)](CLAUDE.md)

</div>

<br/>

---

### The problem

You have Claude Code refactoring the auth module. Cursor is adding tests. Codex is updating docs.

They're all editing the same files. Nobody knows what the others are doing. Merge conflicts. Duplicated work. Overwritten changes.

**Ergatai fixes this.** It connects your existing AI agents through a lightweight coordination layer — so they can talk, divide work, and edit code without colliding.

---

### See it in action

<!-- TODO: Replace with actual demo GIF -->
![Demo](assets/demo-placeholder.gif)

*Three agents collaborating on a single codebase — messages flowing, tasks dispatched, files locked safely.*

---

### What you can do

**💬 Agents that talk to each other**

Claude can ask Cursor to review a PR. Codex can report results back to the team. No more copy-pasting between terminals.

**📋 Divide and conquer**

Submit a complex task. Ergatai breaks it into steps, assigns them to different agents, and tracks progress — like a project manager for AI.

**🔒 No more merge conflicts**

When two agents try to edit the same file, Ergatai locks it safely. One works while the other waits. No overwritten changes, no lost work.

---

### Quick Start

**1. Install**

```bash
curl -sSL https://raw.githubusercontent.com/windreach/ergatai/main/install.sh | bash
```

**2. Start the server**

```bash
ergatai-server
```

**3. Launch your first agent**

```bash
ega claude
```

**4. Add more agents**

Point your other agents (Cursor, Codex, etc.) to `http://localhost:3000/mcp/<agent-name>` in their MCP config.

That's it. Your agents can now collaborate.

📖 [Full installation guide](docs/getting-started/INSTALL.md) · [CLI reference](docs/guide/CLI.md) · [MCP setup](docs/guide/MCP.md)

---

### Works with your favorite agents

| Agent | Status |
|-------|--------|
| Claude Code | ✅ Verified |
| Cursor | ✅ Verified |
| Codex | ✅ Supported |
| Goose | ✅ Supported |
| Cline | ✅ Supported |
| Any MCP-compatible agent | ✅ Supported |

---

### Why Ergatai?

- **Local-first** — Everything runs on your machine. No data leaves your laptop.
- **Agent-agnostic** — Works with any MCP-compatible agent. Switch agents without switching tools.
- **Zero infrastructure** — No Kubernetes, no cloud services. Just one binary.
- **Crash-proof** — DAG state persisted to disk. If Ergatai crashes, it recovers where it left off.

---

### Learn more

- [Architecture Overview](docs/architecture/OVERVIEW.md) — How it works under the hood
- [Examples](examples/) — Sample workflows and use cases
- [Contributing](CONTRIBUTING.md) — Join the project

---

### License

Apache License 2.0 — see [LICENSE](LICENSE) for details.

<br/>

<div align="center">

**Tell your agents what to do. They'll figure out the rest — together.**

</div>
