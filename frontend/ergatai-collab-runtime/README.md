# Ergatai Collaboration Runtime

This package is the Bun sidecar for the implicit collaboration runtime. It owns a lightweight collaboration state machine, local session persistence, supervisor/group/single-agent/DAG compatibility routes, and approval lifecycle state.

## IPC Contract

- Transport: stdin/stdout using newline-delimited JSON (JSON Lines).
- Direction: Rust Core writes requests to stdin and reads responses/events from stdout.
- Logging: the runtime writes diagnostics to stderr only; stdout is reserved for protocol frames.
- Versioning: every request and response contains `protocolVersion`; the current version is `1`.
- Authentication: Rust Core generates a one-time token, passes it through `ERGATAI_COLLAB_RUNTIME_TOKEN`, and includes it in every request. The first command must be `hello`.
- Frame limit: 1 MiB per JSON line.

## Request Example

```json
{"id":"req_1","protocolVersion":1,"token":"local-only-token","command":{"type":"health"}}
```

## Response Example

```json
{"id":"req_1","protocolVersion":1,"ok":true,"result":{"type":"health","status":"ok","protocolVersion":1,"uptimeMs":12,"activeSessions":0}}
```

## Event Example

The runtime emits an unauthenticated readiness event before the first authenticated request:

```json
{"type":"ready","protocolVersion":1,"runtimeVersion":"0.1.0"}
```

## Runtime Behavior

- Collaboration state stores only semantic summaries, decisions, participants, and Rust-managed artifact references.
- Supervisor sessions can interrupt at an approval gate and resume through `approve` or `reject`.
- Session, run, and approval state can be restored from `ERGATAI_COLLAB_RUNTIME_DATA_DIR/collaboration/sessions.json`.
- `cancel`, `resume_session`, `approve`, and `reject` emit semantic runtime events.
- The UI consumes only Ergatai runtime events and has no third-party collaboration runtime dependency.
