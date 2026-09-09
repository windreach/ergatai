import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { readdir } from 'node:fs/promises'
import os from 'node:os'

function fsListPlugin(): Plugin {
  return {
    name: 'dev-fs-list',
    configureServer(server) {
      server.middlewares.use('/api/fs', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const dirPath = url.searchParams.get('path') ?? os.homedir()
        readdir(dirPath, { withFileTypes: true })
          .then(entries => {
            const directories = entries
              .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
              .map(entry => entry.name)
              .sort()
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ path: dirPath, directories }))
          })
          .catch(err => {
            res.statusCode = err?.code === 'ENOENT' ? 404 : 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: err?.message ?? 'Failed to list directory' }))
          })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), fsListPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
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
})
