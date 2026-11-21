# Scripts

Helper scripts for development, testing, and release. Grouped by purpose:

- Root level (dev tooling):
  - `dev.sh` — start the full dev environment (backend + frontend).
  - `fix.sh`, `local-ci.sh`, `local-coverage.sh` — local quality gates.
  - `package.sh` — build + package release artifacts.
  - `bundle.sh` — self-contained portable bundle (server + app + launcher).
  - `test-pty.sh` — PTY smoke test.
- `lib/` — shared shell libraries (`test-lib.sh`).
- `test/` — test runners and suites:
  - `api-test.sh` — API integration test scheduler (sources `test/api/*.sh`).
  - `run-api-tests.sh` — lighter API smoke tests.
  - `run-e2e-tests.sh` — Playwright E2E runner.
  - `api/` — numbered API test modules (`01-system.sh` … `15-agent-output-persistence.sh`).
- `scan/` — performance profiling helpers.
- `maintenance/` — one-off data maintenance scripts.
- Build/release helpers (`.mjs`/`.py`) remain at the root and are invoked via `package.json`.

All scripts use `#!/usr/bin/env bash` and should be run from the repository root unless noted. Standalone scripts use `set -euo pipefail`.