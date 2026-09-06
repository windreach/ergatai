# Ergatai Frontend

The frontend is a pnpm/npm workspace split for multi-host delivery.

## Packages

- `packages/platform-core`: API contracts, transports, and runtime configuration shared by every host.
- `packages/ui-core`: the five core panels, Dockview tab shell, stores, i18n, and shared UI.
- `apps/web`: the browser/Vite entry point.

CEF, VSCode, or another host should reuse `ui-core` and provide its own platform adapter where host behavior differs.

## Commands

```bash
npm install
npm run dev
npm run build
npm run lint
```

Runtime behavior is configured with the existing `VITE_*` variables in `packages/platform-core/src/config/runtime.ts`.
