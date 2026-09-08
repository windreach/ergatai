import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    include: ["@monaco-editor/react"],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_PROXY_TARGET ?? "http://127.0.0.1:3000",
        changeOrigin: true,
        ws: true,
      },
    },
    fs: {
      allow: [path.resolve(import.meta.dirname, '../..')],
    },
  },
  resolve: {
    alias: {
      'monaco-editor/vs': path.resolve(
        import.meta.dirname,
        '../../node_modules/monaco-editor/esm/vs',
      ),
    },
  },
})
