import { defineConfig } from "vitest/config"
import path from "path"

// Temporary local override for the race-render diagnosis:
// - the default cache directory resolves outside the writable sandbox
//   ($HOME contains a stray pnpm-workspace.yaml, so vitest resolves the
//   workspace root to $HOME and fails on its read-only cache dir)
// - @testing-library/jest-dom is not installed in this sandbox, so the
//   original setup file is skipped.
// Remove after the diagnosis is complete.
export default defineConfig({
  cacheDir: "/tmp/vitest-ergatai",
  fsModuleCachePath: "/tmp/vitest-fs-cache-ergatai",
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: [],
    include: ["tests/renderer/**/*.test.ts", "tests/renderer/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src/renderer"),
    },
  },
})
