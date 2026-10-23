/**
 * Integration test fixture - 启动真实 ergatai 后端
 * 使用预编译的 ergatai-server 二进制，避免每次重新编译
 */

import { _electron as electron, ElectronApplication, Page } from '@playwright/test'
import * as path from 'path'
import { spawn, ChildProcess } from 'child_process'

const ERGATAI_PORT = 3001
const ERGATAI_API_URL = `http://127.0.0.1:${ERGATAI_PORT}`
// __dirname is e2e-tests/fixtures, ergatai root is 3 levels up
const ERGATAI_BINARY = path.resolve(__dirname, '../../../target/debug/ergatai-server')

// Test API token (UUIDv4 format, must match backend's authIdSchema)
const TEST_API_TOKEN = '92d984bd-1138-476d-ad3c-ac4b5db9f844'

let backendProcess: ChildProcess | null = null
let xvfbProcess: ChildProcess | null = null

/**
 * 启动 Xvfb 虚拟显示（如果未运行）
 */
async function ensureXvfb(): Promise<string> {
  const display = ':99'
  try {
    const { execSync } = require('child_process')
    execSync(`xdpyinfo -display ${display} 2>/dev/null`)
    console.log(`✅ Xvfb 已在运行 (Display: ${display})`)
    return display
  } catch {
    console.log(`🚀 启动 Xvfb...`)
    xvfbProcess = spawn('Xvfb', [display, '-screen', '0', '1280x960x24', '-ac'], {
      stdio: 'ignore',
      detached: true,
    })
    await new Promise(resolve => setTimeout(resolve, 1000))
    return display
  }
}

/**
 * 启动 ergatai 真实后端
 */
async function startBackend(): Promise<void> {
  console.log(`🚀 启动 ergatai 真实后端 (port: ${ERGATAI_PORT})...`)

  backendProcess = spawn(ERGATAI_BINARY, ['--port', String(ERGATAI_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      RUST_LOG: process.env.DEBUG_BACKEND ? 'debug' : 'info',
      ERGATAI_API_TOKEN: TEST_API_TOKEN,
      ERGATAI_STRICT_MODE: '0',  // 禁用 strict mode 以允许测试命令
    },
  })

  backendProcess.stdout?.on('data', (data: Buffer) => {
    if (process.env.DEBUG_BACKEND) {
      process.stdout.write(`[backend] ${data.toString()}`)
    }
  })

  backendProcess.stderr?.on('data', (data: Buffer) => {
    if (process.env.DEBUG_BACKEND) {
      process.stderr.write(`[backend] ${data.toString()}`)
    }
  })

  backendProcess.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`❌ 后端进程退出 (code: ${code})`)
    }
  })

  // 等待后端就绪（健康检查）
  const maxWait = 30000
  const startTime = Date.now()
  while (Date.now() - startTime < maxWait) {
    try {
      const response = await fetch(`${ERGATAI_API_URL}/health`)
      if (response.ok) {
        console.log(`✅ 后端已就绪 (${Date.now() - startTime}ms)`)
        return
      }
    } catch {
      // 后端还没启动
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }

  throw new Error(`后端启动超时 (${maxWait}ms)`)
}

/**
 * 停止 ergatai 后端
 */
async function stopBackend(): Promise<void> {
  if (backendProcess) {
    console.log('🛑 停止 ergatai 后端...')
    backendProcess.kill('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 2000))
    if (backendProcess.exitCode === null) {
      backendProcess.kill('SIGKILL')
    }
    backendProcess = null
  }
}

/**
 * 启动 Electron 应用（连接真实后端）
 */
export async function launchIntegrationElectron(): Promise<{
  electron: ElectronApplication
  page: Page
  backendProcess: ChildProcess | null
}> {
  const display = await ensureXvfb()
  await startBackend()

  // __dirname is e2e-tests/fixtures, app is at frontend/
  const appPath = path.resolve(__dirname, '../..')

  console.log('🚀 启动 Electron (连接真实后端)...')

  const electronApp = await electron.launch({
    args: [appPath, '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    cwd: appPath,
    env: {
      ...process.env,
      DISPLAY: display,
      ERGATAI_API_URL,
      ERGATAI_API_TOKEN: TEST_API_TOKEN,
      NODE_ENV: 'test',
      ELECTRON_TEST_MODE: 'true',
    },
  })

  const page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  console.log('✅ Electron 已启动')

  return { electron: electronApp, page, backendProcess }
}

/**
 * 清理集成测试环境
 */
export async function cleanupIntegration(electronApp?: ElectronApplication): Promise<void> {
  if (electronApp) {
    console.log('🛑 关闭 Electron...')
    await electronApp.close().catch(() => {})
  }
  await stopBackend()

  // 关闭 Xvfb
  if (xvfbProcess) {
    xvfbProcess.kill('SIGTERM')
    xvfbProcess = null
    console.log('✅ Xvfb 已关闭')
  }
}

/**
 * 直接调用 ergatai REST API（不经过 tRPC）
 */
export const api = {
  baseUrl: ERGATAI_API_URL,
  token: TEST_API_TOKEN,

  async health() {
    const res = await fetch(`${this.baseUrl}/health`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    })
    return res.json()
  },

  async ready() {
    const res = await fetch(`${this.baseUrl}/ready`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    })
    return res.json()
  },

  // Workspace APIs
  async listWorkspaces() {
    const res = await fetch(`${this.baseUrl}/api/v1/workspaces/managed`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    })
    return res.json()
  },

  async createWorkspace(data: { name?: string; work_dir: string }) {
    const res = await fetch(`${this.baseUrl}/api/v1/workspaces/managed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify(data),
    })
    return res.json()
  },

  async deleteWorkspace(id: string) {
    const res = await fetch(`${this.baseUrl}/api/v1/workspaces/managed/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.token}` }
    })
    return res.status
  },

  // Agent APIs
  async listAgents() {
    const res = await fetch(`${this.baseUrl}/api/v1/agents`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    })
    return res.json()
  },

  async spawnAgent(data: { command: string; workspace_id?: string; work_dir?: string }) {
    const res = await fetch(`${this.baseUrl}/api/v1/agents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify(data),
    })
    const json = await res.json()
    if (!res.ok) {
      console.error(`Spawn failed (${res.status}):`, json)
    }
    return json
  },

  async registerAgentProfile(data: { name: string; command: string; agent_type: string }) {
    const res = await fetch(`${this.baseUrl}/api/v1/agent-profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      const json = await res.json()
      throw new Error(`Failed to register profile: ${json.error}`)
    }
    return res.json()
  },

  async sendMessage(agentId: string, message: string) {
    const res = await fetch(`${this.baseUrl}/api/v1/agents/${agentId}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify({ message }),
    })
    const json = await res.json()
    if (!res.ok) {
      console.error(`Send message failed (${res.status}):`, json)
    }
    return json
  },

  async promptAgent(agentId: string, message: string, images?: string[]) {
    const res = await fetch(`${this.baseUrl}/api/v1/agents/${agentId}/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify({ message, images }),
    })
    const json = await res.json()
    if (!res.ok) {
      console.error(`Prompt agent failed (${res.status}):`, json)
    }
    return json
  },

  // Conversation APIs
  async listConversations() {
    const res = await fetch(`${this.baseUrl}/api/v1/conversations`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    })
    return res.json()
  },

  async getConversationOutputs(conversationId: string) {
    const res = await fetch(`${this.baseUrl}/api/v1/conversations/${conversationId}/outputs`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    })
    return res.json()
  },

  async getConversationMessages(conversationId: string) {
    const res = await fetch(`${this.baseUrl}/api/v1/conversations/${conversationId}/messages`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    })
    return res.json()
  },

  async killAgent(id: string) {
    const res = await fetch(`${this.baseUrl}/api/v1/agents/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.token}` }
    })
    return res.status
  },

  // System status
  async getStatus() {
    const res = await fetch(`${this.baseUrl}/api/v1/status`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    })
    return res.json()
  },
}

/**
 * 等待条件满足（轮询）
 */
export async function waitFor<T>(
  fn: () => Promise<T>,
  options: { timeout?: number; interval?: number; message?: string } = {}
): Promise<T> {
  const { timeout = 10000, interval = 200, message = 'Condition not met' } = options
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    try {
      const result = await fn()
      if (result) return result
    } catch {
      // 继续等待
    }
    await new Promise(resolve => setTimeout(resolve, interval))
  }

  throw new Error(`${message} (timeout: ${timeout}ms)`)
}
