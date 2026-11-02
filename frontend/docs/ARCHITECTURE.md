# Frontend Architecture

## Top-level organization
- Feature-first (vertical slices): `src/renderer/features/<feature>/`
- Shared kernel: `src/renderer/shared/`, `src/renderer/components/ui/`, `src/renderer/lib/`
- Electron main process: `src/main/`
- Cross-process contracts: `src/shared/`

## Feature internal layers
```
features/<name>/
  ui/            # presentation only
  hooks/         # React adapters
  application/   # use cases (optional, incremental)
  domain/        # pure models/rules (optional, incremental)
  infrastructure/# tRPC/IPC/storage adapters
  state/         # feature state (single source)
  contracts/     # public types
  index.ts       # public entry point
```

## Boundaries
- Features may only import other features via their `index.ts` (public entry).
- `ui/` must not import `infrastructure/` directly.
- State: one source of truth per concept; runtime state lives in `RuntimeSessionStore`.
- Main/renderer communicate via tRPC or IPC; no direct Node imports in renderer.

## Guards
- `bun run check:api-boundaries`
- `bun run check:frontend-ids`
- `bun run check:feature-boundaries`
- `bun run check:file-size`

## Baseline
See `scripts/architecture-baseline.json`. Ratchet down as refactors land.
