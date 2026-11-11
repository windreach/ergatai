import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/renderer/**/*.test.ts", "tests/renderer/**/*.test.tsx"],
  },
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src/renderer") },
      { find: "react-icons/hi2", replacement: path.resolve(__dirname, "./src/test-stubs/react-icons-stub.tsx") },
      { find: "react-icons/lu", replacement: path.resolve(__dirname, "./src/test-stubs/react-icons-stub.tsx") },
      { find: "mermaid", replacement: path.resolve(__dirname, "./src/test-stubs/mermaid-stub.ts") },
      { find: /^monaco-editor(\/.*)?(\?.*)?$/, replacement: path.resolve(__dirname, "./src/test-stubs/monaco-stub.ts") },
    ],
  },
})
