import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import { resolve } from "path"
import react from "@vitejs/plugin-react"
import tailwindcss from "tailwindcss"
import autoprefixer from "autoprefixer"

const isDev = process.env.NODE_ENV !== "production"

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        // Don't externalize these - bundle them instead
        exclude: ["superjson", "trpc-electron", "gray-matter", "async-mutex"],
      }),
    ],
    build: {
      lib: {
        entry: resolve(__dirname, "src/main/index.ts"),
      },
      rollupOptions: {
        external: [
          "electron",
          "better-sqlite3",
          "@prisma/client",
          "@anthropic-ai/claude-agent-sdk", // ESM module - must use dynamic import
        ],
        output: {
          format: "cjs",
        },
      },
    },
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["trpc-electron"],
      }),
    ],
    build: {
      lib: {
        entry: resolve(__dirname, "src/preload/index.ts"),
      },
      rollupOptions: {
        external: ["electron"],
        output: {
          format: "cjs",
        },
      },
    },
  },
  renderer: {
    plugins: [
      react({
        jsxImportSource: isDev
          ? "@welldone-software/why-did-you-render"
          : undefined,
      }),
    ],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer"),
      },
    },
    build: {
      sourcemap: true,
      minify: "oxc",
      chunkSizeWarningLimit: 1000,
      target: "es2020",
      cssCodeSplit: false,
      experimental: {
        rolldown: true,  // Use Rolldown (Rust-based, highly memory efficient)
      },
      rollupOptions: {
        treeshake: {
          moduleSideEffects: false,
        },
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          login: resolve(__dirname, "src/renderer/login.html"),
        },
        output: {
          chunkFileNames: "chunks/[name]-[hash].js",
          manualChunks(id) {
            if (id.includes("node_modules")) {
              return "vendor"
            }
          },
        },
      },
    },
    optimizeDeps: {
      include: ["react", "react-dom"],
    },
    css: {
      postcss: {
        plugins: [tailwindcss, autoprefixer],
      },
    },
  },
})
