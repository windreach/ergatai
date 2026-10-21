import { z } from "zod"
import { router, publicProcedure } from "../index"
import { observable } from "@trpc/server/observable"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

/**
 * 测试模式 IPC 路由
 * 只在 NODE_ENV=test 或 ELECTRON_TEST_MODE=true 时启用
 *
 * 用于：
 * - IPC 单元测试（快速、稳定）
 * - E2E 测试数据准备（快速设置测试环境）
 */

// 检查是否启用测试模式
function isTestMode(): boolean {
  return process.env.NODE_ENV === "test" || process.env.ELECTRON_TEST_MODE === "true"
}

// 测试模式保护器
const testProcedure = publicProcedure.use(async ({ next }) => {
  if (!isTestMode()) {
    throw new Error("Test router is only available in test mode (NODE_ENV=test or ELECTRON_TEST_MODE=true)")
  }
  return next()
})

/**
 * Validate that a path is within allowed test directories.
 * Prevents arbitrary file system access even in test mode.
 *
 * SECURITY: process.cwd() is intentionally excluded because it could be
 * any directory (e.g., /home/user, /) depending on where the app was launched.
 */
function validateTestPath(inputPath: string): string {
  const fullPath = path.resolve(inputPath)

  // Allow operations ONLY in safe, well-defined directories:
  // 1. System temp directory (cleaned by OS)
  // 2. Explicit test directories under home
  const allowedRoots = [
    os.tmpdir(),
    path.join(os.homedir(), '.ergatai', 'test'), // Dedicated test directory
  ]

  const isAllowed = allowedRoots.some(root => {
    const normalizedRoot = path.resolve(root)
    return fullPath === normalizedRoot || fullPath.startsWith(normalizedRoot + path.sep)
  })

  if (!isAllowed) {
    throw new Error(
      `Path validation failed: ${inputPath} is outside allowed test directories. ` +
      `Allowed roots: ${allowedRoots.join(', ')}`
    )
  }

  return fullPath
}

/**
 * 内存存储 - 用于测试模式的数据管理
 * 实际生产环境应该使用 SQLite 数据库
 */

// 简单计数器，确保 ID 唯一（避免 Date.now() 并发冲突）
let idCounter = 0
function uniqueId(prefix: string): string {
  idCounter++
  return `${prefix}-${Date.now()}-${idCounter}-${Math.random().toString(36).slice(2, 8)}`
}

// 项目存储
interface TestProject {
  id: string
  name: string
  path: string
  description: string
  createdAt: string
  updatedAt: string
}

const testProjectStore = {
  projects: new Map<string, TestProject>(),

  list(): TestProject[] {
    return Array.from(this.projects.values())
  },

  get(id: string): TestProject | undefined {
    return this.projects.get(id)
  },

  add(project: TestProject) {
    this.projects.set(project.id, project)
  },

  delete(id: string) {
    this.projects.delete(id)
  },

  clear() {
    this.projects.clear()
  },
}

// 对话存储
interface TestChat {
  id: string
  name: string
  projectId: string
  createdAt: string
  updatedAt: string
  archivedAt?: string
}

const testChatStore = {
  chats: new Map<string, TestChat>(),

  list(projectId?: string): TestChat[] {
    const allChats: TestChat[] = Array.from(this.chats.values())
    if (projectId) {
      return allChats.filter(c => c.projectId === projectId)
    }
    return allChats
  },

  get(id: string): TestChat | undefined {
    return this.chats.get(id)
  },

  add(chat: TestChat) {
    this.chats.set(chat.id, chat)
  },

  delete(id: string) {
    this.chats.delete(id)
  },

  archive(id: string) {
    const chat = this.chats.get(id)
    if (chat) {
      chat.archivedAt = new Date().toISOString()
    }
  },

  clear() {
    this.chats.clear()
  },
}

// Workspace 存储
interface TestWorkspace {
  id: string
  name: string
  workDir: string
  createdAt: string
  updatedAt: string
}

const testWorkspaceStore = {
  workspaces: new Map<string, TestWorkspace>(),

  list(): TestWorkspace[] {
    return Array.from(this.workspaces.values())
  },

  get(id: string): TestWorkspace | undefined {
    return this.workspaces.get(id)
  },

  add(workspace: TestWorkspace) {
    this.workspaces.set(workspace.id, workspace)
  },

  delete(id: string) {
    this.workspaces.delete(id)
  },

  clear() {
    this.workspaces.clear()
  },
}

// Ergatai Agent 存储
interface TestErgataiAgent {
  agent_id: string
  workspace_id?: string
  command: string
  status: 'starting' | 'running' | 'stopped'
  created_at: string
}

const testErgataiAgentStore = {
  agents: new Map<string, TestErgataiAgent>(),

  list(): TestErgataiAgent[] {
    return Array.from(this.agents.values())
  },

  get(id: string): TestErgataiAgent | undefined {
    return this.agents.get(id)
  },

  add(agent: TestErgataiAgent) {
    this.agents.set(agent.agent_id, agent)
  },

  delete(id: string) {
    this.agents.delete(id)
  },

  clear() {
    this.agents.clear()
  },
}

// Ergatai Conversation 存储
interface TestErgataiConversation {
  id: string
  chat_id?: string
  name: string
  created_at: string
  archived_at?: string
}

const testErgataiConversationStore = {
  conversations: new Map<string, TestErgataiConversation>(),

  list(): TestErgataiConversation[] {
    return Array.from(this.conversations.values())
  },

  get(id: string): TestErgataiConversation | undefined {
    return this.conversations.get(id)
  },

  add(conversation: TestErgataiConversation) {
    this.conversations.set(conversation.id, conversation)
  },

  delete(id: string) {
    this.conversations.delete(id)
  },

  clear() {
    this.conversations.clear()
  },
}

// 文件操作日志
interface FileOperation {
  type: 'create' | 'write' | 'delete' | 'rename'
  path: string
  timestamp: string
  content?: string
}

const testFileOperationLog: FileOperation[] = []

// 消息存储 (按 conversation 分组)
interface TestMessage {
  id: string
  conversationId: string
  role: 'user' | 'agent' | 'assistant' | 'system'
  content: string
  senderAgentId?: string
  senderAgentName?: string
  messageType?: 'request' | 'response' | 'broadcast'
  correlationId?: string
  requiresReceipt?: boolean
  createdAt: string
  metadata?: Record<string, unknown>
}

const testMessageStore = {
  messages: new Map<string, TestMessage>(), // key: message id
  byConversation: new Map<string, Set<string>>(), // conversationId -> Set<messageId>

  list(conversationId: string): TestMessage[] {
    const ids = this.byConversation.get(conversationId)
    if (!ids) return []
    return Array.from(ids)
      .map(id => this.messages.get(id))
      .filter((m): m is TestMessage => !!m)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  },

  add(msg: TestMessage) {
    this.messages.set(msg.id, msg)
    if (!this.byConversation.has(msg.conversationId)) {
      this.byConversation.set(msg.conversationId, new Set())
    }
    this.byConversation.get(msg.conversationId)!.add(msg.id)
  },

  clear() {
    this.messages.clear()
    this.byConversation.clear()
  },
}

// Agent Output 存储
interface TestAgentOutput {
  id: string
  conversationId: string
  agentId: string
  turnIndex: number
  thinking?: string
  toolCalls?: Array<{ name: string; input: unknown; output?: string }>
  responseText?: string
  createdAt: string
}

const testAgentOutputStore = {
  outputs: new Map<string, TestAgentOutput>(),

  list(conversationId: string): TestAgentOutput[] {
    return Array.from(this.outputs.values())
      .filter(o => o.conversationId === conversationId)
      .sort((a, b) => a.turnIndex - b.turnIndex)
  },

  get(agentId: string): TestAgentOutput | undefined {
    // Return the most recent output for an agent
    return Array.from(this.outputs.values())
      .filter(o => o.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  },

  add(output: TestAgentOutput) {
    this.outputs.set(output.id, output)
  },

  clear() {
    this.outputs.clear()
  },
}

// Agent Profile 存储
interface TestAgentProfile {
  name: string
  command: string
  agent_type: string
  instruction?: string
  env_overrides?: Record<string, string>
  createdAt: string
}

const testAgentProfileStore = {
  profiles: new Map<string, TestAgentProfile>(),

  list(): TestAgentProfile[] {
    return Array.from(this.profiles.values())
  },

  get(name: string): TestAgentProfile | undefined {
    return this.profiles.get(name)
  },

  add(profile: TestAgentProfile) {
    this.profiles.set(profile.name, profile)
  },

  delete(name: string) {
    this.profiles.delete(name)
  },

  clear() {
    this.profiles.clear()
  },
}

// File Lock 存储
interface TestFileLock {
  token: string
  agentId: string
  path: string
  acquiredAt: string
  expiresAt: string
}

const testLockStore = {
  locks: new Map<string, TestFileLock>(), // key: token
  auditLog: Array<{ timestamp: string; agentId: string; path: string; action: string }>(),

  list(): TestFileLock[] {
    return Array.from(this.locks.values())
  },

  acquire(agentId: string, filePath: string): TestFileLock {
    const token = uniqueId('lock')
    const lock: TestFileLock = {
      token,
      agentId,
      path: filePath,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min TTL
    }
    this.locks.set(token, lock)
    this.auditLog.push({ timestamp: lock.acquiredAt, agentId, path: filePath, action: 'acquire' })
    return lock
  },

  release(token: string): boolean {
    const lock = this.locks.get(token)
    if (!lock) return false
    this.locks.delete(token)
    this.auditLog.push({ timestamp: new Date().toISOString(), agentId: lock.agentId, path: lock.path, action: 'release' })
    return true
  },

  clear() {
    this.locks.clear()
    this.auditLog.length = 0
  },
}

// Rate Limiter mock state (sliding window simulation)
interface RateLimitState {
  agentId: string
  windowMs: number // 60_000
  maxRequests: number // 60
  requests: number[] // timestamps
}

const testRateLimiterState = {
  byAgent: new Map<string, RateLimitState>(),

  check(agentId: string): { allowed: boolean; remaining: number; resetAt: string } {
    const now = Date.now()
    const windowMs = 60_000
    const maxRequests = 60

    if (!this.byAgent.has(agentId)) {
      this.byAgent.set(agentId, { agentId, windowMs, maxRequests, requests: [] })
    }
    const state = this.byAgent.get(agentId)!

    // Prune old requests
    state.requests = state.requests.filter(t => now - t < windowMs)

    const allowed = state.requests.length < maxRequests

    // Record this request
    if (allowed) {
      state.requests.push(now)
    }

    // Calculate remaining AFTER recording
    const remaining = Math.max(0, maxRequests - state.requests.length)

    const resetAt = state.requests.length > 0
      ? new Date(state.requests[0] + windowMs).toISOString()
      : new Date(now + windowMs).toISOString()

    return { allowed, remaining, resetAt }
  },

  clear() {
    this.byAgent.clear()
  },
}

export const testRouter = router({
  /**
   * 检查测试模式是否启用
   */
  isTestMode: publicProcedure.query(() => {
    return isTestMode()
  }),

  /**
   * 项目/Workspace 测试 API
   * 直接操作数据，不依赖 ergatai API 服务器
   */
  projects: router({
    /**
     * 列出所有项目（从内存存储读取）
     */
    list: testProcedure.query(async () => {
      // 从内存存储读取项目列表
      return testProjectStore.list()
    }),

    /**
     * 获取单个项目
     */
    get: testProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        const project = testProjectStore.get(input.id)
        if (!project) {
          throw new Error('Project not found')
        }
        return project
      }),

    /**
     * 创建测试项目（写入内存存储，不调用 ergatai API）
     */
    create: testProcedure
      .input(
        z.object({
          name: z.string().min(1, 'Name is required'),
          path: z.string().min(1, 'Path is required'),
          description: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        // 生成符合 projectIdSchema 的 ID (legacy 格式: proj_ + 32 hex chars)
        const hexId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
        const project = {
          id: `proj_${hexId}`,
          name: input.name,
          path: input.path,
          description: input.description || '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        testProjectStore.add(project)
        return project
      }),

    /**
     * 删除项目（测试用）
     */
    delete: testProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        testProjectStore.delete(input.id)
        return { success: true }
      }),
  }),

  /**
   * Workspace 测试 API
   */
  workspaces: router({
    list: testProcedure.query(async () => {
      return testWorkspaceStore.list()
    }),

    get: testProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        const workspace = testWorkspaceStore.get(input.id)
        if (!workspace) {
          throw new Error('Workspace not found')
        }
        return workspace
      }),

    create: testProcedure
      .input(
        z.object({
          name: z.string().min(1, 'Name is required'),
          workDir: z.string().min(1, 'WorkDir is required'),
        })
      )
      .mutation(async ({ input }) => {
        const workspace = {
          id: uniqueId('ws'),
          name: input.name,
          workDir: input.workDir,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        testWorkspaceStore.add(workspace)
        return workspace
      }),

    delete: testProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        testWorkspaceStore.delete(input.id)
        return { success: true }
      }),
  }),

  /**
   * 对话/Chat 测试 API
   */
  chats: router({
    list: testProcedure
      .input(z.object({ projectId: z.string().optional() }).optional())
      .query(async ({ input }) => {
        return testChatStore.list(input?.projectId)
      }),

    get: testProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        const chat = testChatStore.get(input.id)
        if (!chat) {
          throw new Error('Chat not found')
        }
        return chat
      }),

    create: testProcedure
      .input(
        z.object({
          name: z.string().min(1, 'Name is required'),
          projectId: z.string().min(1, 'ProjectId is required'),
        })
      )
      .mutation(async ({ input }) => {
        const chat = {
          id: uniqueId('chat'),
          name: input.name,
          projectId: input.projectId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        testChatStore.add(chat)
        return chat
      }),

    archive: testProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        testChatStore.archive(input.id)
        return { success: true }
      }),

    delete: testProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        testChatStore.delete(input.id)
        return { success: true }
      }),
  }),

  /**
   * 文件操作测试 API
   */
  files: router({
    /**
     * 创建测试文件
     */
    create: testProcedure
      .input(
        z.object({
          path: z.string().min(1),
          content: z.string(),
        })
      )
      .mutation(async ({ input }) => {
        const fullPath = validateTestPath(input.path)
        const dir = path.dirname(fullPath)

        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(fullPath, input.content, 'utf-8')

        testFileOperationLog.push({
          type: 'create',
          path: fullPath,
          timestamp: new Date().toISOString(),
          content: input.content,
        })

        return { success: true, path: fullPath }
      }),

    /**
     * 读取测试文件
     */
    read: testProcedure
      .input(z.object({ path: z.string().min(1) }))
      .query(async ({ input }) => {
        const fullPath = validateTestPath(input.path)
        try {
          const content = await fs.readFile(fullPath, 'utf-8')
          return { success: true, content, path: fullPath }
        } catch (error) {
          throw new Error(`File not found: ${fullPath}`)
        }
      }),

    /**
     * 删除测试文件
     */
    delete: testProcedure
      .input(z.object({ path: z.string().min(1) }))
      .mutation(async ({ input }) => {
        const fullPath = validateTestPath(input.path)
        try {
          await fs.unlink(fullPath)
          testFileOperationLog.push({
            type: 'delete',
            path: fullPath,
            timestamp: new Date().toISOString(),
          })
          return { success: true }
        } catch (error) {
          throw new Error(`File not found: ${fullPath}`)
        }
      }),

    /**
     * 获取文件操作日志
     */
    getOperationLog: testProcedure.query(async () => {
      return testFileOperationLog
    }),
  }),

  /**
   * Agent 文件测试 API
   */
  agents: router({
    /**
     * 列出所有 agent 文件
     */
    list: testProcedure
      .input(
        z
          .object({
            cwd: z.string().optional(),
          })
          .optional()
      )
      .query(async ({ input }) => {
        const userAgentsDir = path.join(os.homedir(), ".claude", "agents")
        const agents: Array<{ name: string; source: string; path: string }> = []

        // 扫描用户 agent
        try {
          const files = await fs.readdir(userAgentsDir)
          for (const file of files) {
            if (file.endsWith(".md")) {
              agents.push({
                name: file.replace(".md", ""),
                source: "user",
                path: path.join(userAgentsDir, file),
              })
            }
          }
        } catch {
          // 目录不存在
        }

        // 扫描项目 agent
        if (input?.cwd) {
          const validatedCwd = validateTestPath(input.cwd)
          const projectAgentsDir = path.join(validatedCwd, ".claude", "agents")
          try {
            const files = await fs.readdir(projectAgentsDir)
            for (const file of files) {
              if (file.endsWith(".md")) {
                agents.push({
                  name: file.replace(".md", ""),
                  source: "project",
                  path: path.join(projectAgentsDir, file),
                })
              }
            }
          } catch {
            // 目录不存在
          }
        }

        return agents
      }),

    /**
     * 创建测试 agent（直接写文件）
     *
     * SECURITY: Only allows creating agents with names starting with "test-"
     * to prevent accidental overwrite of real user agents in ~/.claude/agents/.
     */
    create: testProcedure
      .input(
        z.object({
          name: z.string(),
          description: z.string(),
          prompt: z.string(),
          source: z.enum(["user", "project"]),
          cwd: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const safeName = input.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")
        if (!safeName) {
          throw new Error("Invalid agent name")
        }

        // SECURITY: Enforce test- prefix for user agents to prevent overwriting real agents
        if (input.source === "user" && !safeName.startsWith("test-")) {
          throw new Error(
            `User agent name must start with "test-" in test mode (got: "${safeName}"). ` +
            `This prevents accidental overwrite of real user agents.`
          )
        }

        let targetDir: string
        if (input.source === "project") {
          if (!input.cwd) {
            throw new Error("Project path (cwd) required for project agents")
          }
          const validatedCwd = validateTestPath(input.cwd)
          targetDir = path.join(validatedCwd, ".claude", "agents")
        } else {
          targetDir = path.join(os.homedir(), ".claude", "agents")
        }

        await fs.mkdir(targetDir, { recursive: true })
        const agentPath = path.join(targetDir, `${safeName}.md`)

        // 写入简单的 agent 配置
        const content = `---
name: ${safeName}
description: ${input.description}
---

# ${input.name}

${input.prompt}
`
        await fs.writeFile(agentPath, content, "utf-8")

        return {
          name: safeName,
          path: agentPath,
          source: input.source,
        }
      }),

    /**
     * 删除测试 agent
     *
     * SECURITY: Only allows deleting agents with names starting with "test-"
     * to prevent accidental deletion of real user agents in ~/.claude/agents/.
     */
    delete: testProcedure
      .input(
        z.object({
          name: z.string(),
          source: z.enum(["user", "project"]),
          cwd: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const safeName = input.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")

        // SECURITY: Enforce test- prefix for user agents to prevent deleting real agents
        if (input.source === "user" && !safeName.startsWith("test-")) {
          throw new Error(
            `User agent name must start with "test-" in test mode (got: "${safeName}"). ` +
            `This prevents accidental deletion of real user agents.`
          )
        }

        let targetDir: string
        if (input.source === "project") {
          if (!input.cwd) {
            throw new Error("Project path (cwd) required for project agents")
          }
          const validatedCwd = validateTestPath(input.cwd)
          targetDir = path.join(validatedCwd, ".claude", "agents")
        } else {
          targetDir = path.join(os.homedir(), ".claude", "agents")
        }

        const agentPath = path.join(targetDir, `${safeName}.md`)

        try {
          await fs.unlink(agentPath)
          return { deleted: true }
        } catch {
          return { deleted: false, error: "Agent not found" }
        }
      }),
  }),

  /**
   * Ergatai IPC Mock - Agent/Conversation/Workspace/DAG/System 管理
   * 模拟 ergatai router 的主要操作
   */
  ergatai: router({
    // Agent 管理
    listAgents: testProcedure.query(() => {
      return testErgataiAgentStore.list()
    }),

    getAgent: testProcedure
      .input(z.object({ agentId: z.string() }))
      .query(({ input }) => {
        const agent = testErgataiAgentStore.get(input.agentId)
        if (!agent) {
          throw new Error(`Agent not found: ${input.agentId}`)
        }
        return agent
      }),

    spawnAgent: testProcedure
      .input(z.object({
        workspaceId: z.string().optional(),
        command: z.string().min(1, 'Command is required'),
      }))
      .mutation(({ input }) => {
        const agent: TestErgataiAgent = {
          agent_id: uniqueId('agent'),
          workspace_id: input.workspaceId,
          command: input.command,
          status: 'starting',
          created_at: new Date().toISOString(),
        }
        testErgataiAgentStore.add(agent)
        return agent
      }),

    killAgent: testProcedure
      .input(z.object({ agentId: z.string() }))
      .mutation(({ input }) => {
        const deleted = testErgataiAgentStore.delete(input.agentId)
        return { success: true, deleted }
      }),

    sendMessage: testProcedure
      .input(z.object({
        agentId: z.string(),
        message: z.string(),
        conversationId: z.string().optional(),
        messageType: z.enum(['request', 'response', 'broadcast']).optional(),
      }))
      .mutation(({ input }) => {
        // Enhanced mock - track messages per conversation
        const messageId = uniqueId('msg')
        const conversationId = input.conversationId || uniqueId('conv')

        // Generate correlationId for request messages
        const correlationId = input.messageType === 'request' ? uniqueId('corr') : undefined

        const msg: TestMessage = {
          id: messageId,
          conversationId,
          role: 'agent',
          content: input.message,
          senderAgentId: input.agentId,
          messageType: input.messageType || 'request',
          correlationId,
          requiresReceipt: input.messageType === 'request',
          createdAt: new Date().toISOString(),
        }

        testMessageStore.add(msg)

        return {
          status: "queued" as const,
          messageId,
          conversationId,
          correlationId,
        }
      }),

    promptAgent: testProcedure
      .input(z.object({
        agentId: z.string(),
        prompt: z.string(),
        interrupt: z.boolean().optional(),
      }))
      .mutation(({ input }) => {
        // Mock prompt agent - 返回 queued 状态
        return { status: "queued" as const, promptId: uniqueId('prompt') }
      }),

    // Message history mocks
    getConversationMessages: testProcedure
      .input(z.object({ conversationId: z.string() }))
      .query(({ input }) => {
        return testMessageStore.list(input.conversationId)
      }),

    getAgentOutputs: testProcedure
      .input(z.object({ conversationId: z.string() }))
      .query(({ input }) => {
        return testAgentOutputStore.list(input.conversationId)
      }),

    getAgentCurrentOutput: testProcedure
      .input(z.object({ agentId: z.string() }))
      .query(({ input }) => {
        const output = testAgentOutputStore.get(input.agentId)
        if (!output) {
          return { id: null, agentId: input.agentId, turnIndex: 0 }
        }
        return output
      }),

    // Conversation 管理
    listConversations: testProcedure.query(() => {
      return testErgataiConversationStore.list()
    }),

    createConversation: testProcedure
      .input(z.object({
        name: z.string().min(1, 'Name is required'),
        chatId: z.string().optional(),
      }))
      .mutation(({ input }) => {
        const conversation: TestErgataiConversation = {
          id: uniqueId('conv'),
          chat_id: input.chatId,
          name: input.name,
          created_at: new Date().toISOString(),
        }
        testErgataiConversationStore.add(conversation)
        return conversation
      }),

    getConversation: testProcedure
      .input(z.object({ id: z.string() }))
      .query(({ input }) => {
        const conversation = testErgataiConversationStore.get(input.id)
        if (!conversation) {
          throw new Error(`Conversation not found: ${input.id}`)
        }
        return conversation
      }),

    deleteConversation: testProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ input }) => {
        testErgataiConversationStore.delete(input.id)
        return { success: true }
      }),

    // Workspace 管理 (复用 testWorkspaceStore)
    listManagedWorkspaces: testProcedure.query(() => {
      return testWorkspaceStore.list()
    }),

    getManagedWorkspace: testProcedure
      .input(z.object({ id: z.string() }))
      .query(({ input }) => {
        const workspace = testWorkspaceStore.get(input.id)
        if (!workspace) {
          throw new Error(`Workspace not found: ${input.id}`)
        }
        return workspace
      }),

    createManagedWorkspace: testProcedure
      .input(z.object({
        name: z.string().min(1, 'Name is required'),
        workDir: z.string().min(1, 'WorkDir is required'),
      }))
      .mutation(({ input }) => {
        const workspace: TestWorkspace = {
          id: uniqueId('ws'),
          name: input.name,
          workDir: input.workDir,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        testWorkspaceStore.add(workspace)
        return workspace
      }),

    deleteManagedWorkspaces: testProcedure
      .input(z.object({ workspaceId: z.string() }))
      .mutation(({ input }) => {
        testWorkspaceStore.delete(input.workspaceId)
        return { success: true }
      }),

    // DAG/编排
    validateDagYaml: testProcedure
      .input(z.object({ yaml: z.string() }))
      .mutation(({ input }) => {
        // Enhanced YAML validator implementing all 9 strict rules from CLAUDE.md
        const yaml = input.yaml
        const errors: string[] = []

        // Raw lines preserve indentation for top-level detection
        const rawLines = yaml.split('\n')
        const trimmedLines = rawLines.map(l => l.trim()).filter(l => l && !l.startsWith('#'))

        // Allowed top-level fields
        const allowedTopLevel = new Set([
          'name', 'description', 'priority', 'tasks', 'communication',
          'parameters', 'max_agent_calls', 'stall_timeout_secs',
          'node_timeout_secs', 'timeout'
        ])

        // Rule 1: Check for unknown top-level fields
        // A top-level field is a non-empty, non-comment line starting at column 0
        // (no leading whitespace) that contains ':'
        const topLevelFields = rawLines
          .filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith(' ') && !l.startsWith('\t') && !l.startsWith('-') && l.includes(':'))
          .map(l => l.split(':')[0].trim())

        for (const field of topLevelFields) {
          if (!allowedTopLevel.has(field)) {
            errors.push(`Rule 1: Unknown top-level field '${field}'`)
          }
        }

        // Extract task names from tasks: section only (not parameters:)
        const tasksBlockMatch = yaml.match(/^tasks:\s*\n((?:\s+.*\n)*)/m)
        const taskNames: string[] = []
        if (tasksBlockMatch) {
          const tasksBlock = tasksBlockMatch[1]
          const taskNameMatches = tasksBlock.matchAll(/^\s*-\s*name:\s*(.+)$/gm)
          for (const match of taskNameMatches) {
            // Strip quotes and trim
            let name = match[1].trim().replace(/^["']|["']$/g, '').trim()
            taskNames.push(name)
          }
        }

        // Rule 2: Task name non-empty
        for (const name of taskNames) {
          if (!name || name.trim() === '') {
            errors.push('Rule 2: Task name cannot be empty')
          }
        }

        // Rule 3: Task name uniqueness
        const uniqueNames = new Set(taskNames)
        if (uniqueNames.size !== taskNames.length) {
          errors.push('Rule 3: Duplicate task names detected')
        }

        // Rule 4: Priority enum validation (case-insensitive) - DAG level and task level
        const dagPriorityMatch = yaml.match(/^priority:\s*(.+)$/m)
        if (dagPriorityMatch) {
          const priority = dagPriorityMatch[1].trim().replace(/^["']|["']$/g, '').toLowerCase()
          if (!['low', 'medium', 'high'].includes(priority)) {
            errors.push(`Rule 4: Invalid priority '${dagPriorityMatch[1].trim()}' (must be low|medium|high)`)
          }
        }
        // Task-level priority
        if (tasksBlockMatch) {
          const taskPriorityMatches = tasksBlockMatch[1].matchAll(/^\s*priority:\s*(.+)$/gm)
          for (const match of taskPriorityMatches) {
            const priority = match[1].trim().replace(/^["']|["']$/g, '').toLowerCase()
            if (!['low', 'medium', 'high'].includes(priority)) {
              errors.push(`Rule 4: Invalid task priority '${match[1].trim()}' (must be low|medium|high)`)
            }
          }
        }

        // Rule 5: Positive values for timeout fields (handle negative numbers and task-level)
        const timeoutFields = ['timeout', 'max_agent_calls', 'stall_timeout_secs', 'node_timeout_secs']
        for (const field of timeoutFields) {
          // Match both top-level and task-level (indented) fields, handle negative numbers
          const fieldMatches = yaml.matchAll(new RegExp(`^\\s*${field}:\\s*(-?\\d+)`, 'gm'))
          for (const match of fieldMatches) {
            const value = parseInt(match[1])
            if (value <= 0) {
              errors.push(`Rule 5: ${field} must be > 0 (got ${value})`)
            }
          }
        }

        // Rule 6: Communication format validation
        const commMatch = yaml.match(/^communication:\s*(.+)$/m)
        if (commMatch) {
          const comm = commMatch[1].trim()
          if (!['open', 'adjacent'].includes(comm) && !comm.startsWith('star:')) {
            errors.push(`Rule 6: Invalid communication format '${comm}' (must be open|adjacent|star:{hub})`)
          }
          if (comm.startsWith('star:')) {
            const hub = comm.substring(5).trim()
            // Check if hub is a valid agent (simplified: just check it's not empty)
            if (!hub) {
              errors.push('Rule 6: star communication requires a hub agent')
            }
          }
        }

        // Rule 7: Template variable reference (skip if no parameters)
        const paramsMatch = yaml.match(/^parameters:\s*$/m)
        if (!paramsMatch) {
          // No parameters declared, skip check
        } else {
          // Extract declared parameters from within the parameters: section only
          // Find the parameters block: from "parameters:" to the next top-level field
          const paramsBlockMatch = yaml.match(/^parameters:\s*\n((?:\s+.*\n)*)/m)
          const paramNames = new Set<string>()
          if (paramsBlockMatch) {
            const paramBlock = paramsBlockMatch[1]
            const paramNameMatches = paramBlock.matchAll(/^\s*-\s*name:\s*(.+)$/gm)
            for (const match of paramNameMatches) {
              paramNames.add(match[1].trim())
            }
          }

          // Check for {{var}} references
          const varRefs = yaml.matchAll(/\{\{(\w+)\}\}/g)
          for (const match of varRefs) {
            const varName = match[1]
            if (!paramNames.has(varName)) {
              errors.push(`Rule 7: Template variable '{{${varName}}}' references undeclared parameter`)
            }
          }
        }

        // Rule 8: Dependency existence - handle both inline [a, b] and YAML list format
        // Inline format: depends_on: [task1, task2]
        const inlineDepsMatches = yaml.matchAll(/depends_on:\s*\[(.+)\]/g)
        for (const match of inlineDepsMatches) {
          const deps = match[1].split(',').map(d => d.trim().replace(/['"]/g, ''))
          for (const dep of deps) {
            if (!taskNames.includes(dep)) {
              errors.push(`Rule 8: Dependency '${dep}' does not exist in tasks`)
            }
          }
        }
        // YAML list format: depends_on:\n  - task1\n  - task2
        const yamlListDepsMatches = yaml.matchAll(/depends_on:[ \t]*\n((?:[ \t]+-[ \t]+[\w-]+[ \t]*(?:\n|$))*)/g)
        for (const match of yamlListDepsMatches) {
          const listBlock = match[1]
          const depItems = listBlock.matchAll(/^[ \t]+-[ \t]+([\w-]+)[ \t]*$/gm)
          for (const item of depItems) {
            const dep = item[1].trim()
            if (dep && !taskNames.includes(dep)) {
              errors.push(`Rule 8: Dependency '${dep}' does not exist in tasks`)
            }
          }
        }

        // Rule 9: Scope glob validity (must be relative path)
        const scopeMatches = yaml.matchAll(/scope:\s*(.+)/g)
        for (const match of scopeMatches) {
          // Strip quotes
          const scope = match[1].trim().replace(/^["']|["']$/g, '')
          // Check if it's an absolute path
          if (scope.startsWith('/') || scope.match(/^[a-zA-Z]:\\/)) {
            errors.push(`Rule 9: Scope glob must be relative path (got '${scope}')`)
          }
          // Check for invalid glob patterns (simplified)
          if (scope.includes('[') && !scope.includes(']')) {
            errors.push(`Rule 9: Invalid glob pattern in scope '${scope}'`)
          }
        }

        // Return result
        if (errors.length > 0) {
          return {
            valid: false,
            error: errors.join('; '),
          }
        }

        // Build summary
        const taskSummaries = taskNames.map(name => {
          // Extract agent for this task (simplified)
          const agentMatch = yaml.match(new RegExp(`- name:\\s*${name}[\\s\\S]*?agent:\\s*(\\w+)`))
          const complexityMatch = yaml.match(new RegExp(`- name:\\s*${name}[\\s\\S]*?complexity:\\s*(\\w+)`))
          return {
            name,
            agent: agentMatch ? agentMatch[1] : 'unknown',
            complexity: complexityMatch ? complexityMatch[1].toLowerCase() : 'medium',
          }
        })

        return {
          valid: true,
          summary: {
            taskCount: taskNames.length || 3,
            tasks: taskSummaries,
            communication: commMatch ? commMatch[1].trim() : 'open',
            priority: dagPriorityMatch ? dagPriorityMatch[1].trim().replace(/^["']|["']$/g, '').toLowerCase() : 'medium',
          },
        }
      }),

    getDagStatus: testProcedure
      .input(z.object({ dagId: z.string() }))
      .query(({ input }) => {
        // Mock DAG 状态
        return {
          dagId: input.dagId,
          status: 'running',
          progress: 50,
          tasks: [],
        }
      }),

    // System
    getSystemStatus: testProcedure.query(() => {
      return {
        agents: testErgataiAgentStore.list().length,
        workspaces: testWorkspaceStore.list().length,
        uptime: 12345,
      }
    }),

    getStats: testProcedure.query(() => {
      return {
        totalAgents: testErgataiAgentStore.list().length,
        totalConversations: testErgataiConversationStore.list().length,
        totalWorkspaces: testWorkspaceStore.list().length,
      }
    }),
  }),

  /**
   * Agent Profiles Mock - 模板注册表
   */
  agentProfiles: router({
    list: testProcedure.query(() => {
      return testAgentProfileStore.list()
    }),

    get: testProcedure
      .input(z.object({ name: z.string() }))
      .query(({ input }) => {
        const profile = testAgentProfileStore.get(input.name)
        if (!profile) {
          throw new Error(`Agent profile not found: ${input.name}`)
        }
        return profile
      }),

    register: testProcedure
      .input(z.object({
        name: z.string().min(1, 'Name is required'),
        command: z.string().min(1, 'Command is required'),
        agent_type: z.string().min(1, 'Agent type is required'),
        instruction: z.string().optional(),
        env_overrides: z.record(z.string()).optional(),
      }))
      .mutation(({ input }) => {
        if (testAgentProfileStore.get(input.name)) {
          throw new Error(`Agent profile already exists: ${input.name}`)
        }
        const profile: TestAgentProfile = {
          name: input.name,
          command: input.command,
          agent_type: input.agent_type,
          instruction: input.instruction,
          env_overrides: input.env_overrides,
          createdAt: new Date().toISOString(),
        }
        testAgentProfileStore.add(profile)
        return profile
      }),

    delete: testProcedure
      .input(z.object({ name: z.string() }))
      .mutation(({ input }) => {
        testAgentProfileStore.delete(input.name)
        return { success: true }
      }),
  }),

  /**
   * File Locks Mock - 零信任文件访问控制
   */
  locks: router({
    list: testProcedure.query(() => {
      return testLockStore.list()
    }),

    getAuditLog: testProcedure.query(() => {
      return testLockStore.auditLog
    }),

    getContention: testProcedure.query(() => {
      // Mock contention detection - return locks that are close to expiry
      const now = Date.now()
      const locks = testLockStore.list()
      const contention = locks.filter(lock => {
        const expiresAt = new Date(lock.expiresAt).getTime()
        return expiresAt - now < 5 * 60 * 1000 // Less than 5 minutes remaining
      })
      return {
        contendedLocks: contention,
        totalActive: locks.length,
      }
    }),

    acquireLock: testProcedure
      .input(z.object({
        agentId: z.string(),
        path: z.string(),
      }))
      .mutation(({ input }) => {
        const lock = testLockStore.acquire(input.agentId, input.path)
        return lock
      }),

    releaseLock: testProcedure
      .input(z.object({ token: z.string() }))
      .mutation(({ input }) => {
        const success = testLockStore.release(input.token)
        return { success }
      }),
  }),

  /**
   * Rate Limiter Mock - 滑动窗口速率限制
   */
  rateLimiter: router({
    checkRate: testProcedure
      .input(z.object({ agentId: z.string() }))
      .query(({ input }) => {
        return testRateLimiterState.check(input.agentId)
      }),
  }),

  /**
   * GroupChat IPC Mock - 群聊管理
   */
  groupChat: router({
    listMembers: testProcedure
      .input(z.object({ chatId: z.string() }))
      .query(({ input }) => {
        // 返回空数组或测试数据
        return []
      }),

    addMember: testProcedure
      .input(z.object({
        chatId: z.string(),
        agentCommand: z.string(),
        agentName: z.string(),
        workspaceId: z.string().optional(),
      }))
      .mutation(({ input }) => {
        // 抛出错误（后端已禁用）
        throw new Error("Adding group chat members is no longer supported")
      }),

    removeMember: testProcedure
      .input(z.object({ chatId: z.string(), agentId: z.string() }))
      .mutation(({ input }) => {
        throw new Error("Removing group chat members is no longer supported")
      }),

    sendToAgent: testProcedure
      .input(z.object({
        chatId: z.string(),
        agentCommand: z.string(),
        message: z.string(),
        correlationId: z.string().nullable().optional(),
        images: z.array(z.object({
          base64Data: z.string(),
          mediaType: z.string(),
          filename: z.string().optional(),
        })).nullable().optional(),
      }))
      .mutation(({ input }) => {
        return { success: true, conversationId: uniqueId('conv') }
      }),
  }),

  /**
   * BackendTerminal IPC Mock - 终端管理
   */
  backendTerminal: router({
    attach: testProcedure
      .input(z.object({
        paneId: z.string(),
        workspaceId: z.string(),
        cwd: z.string().optional(),
      }))
      .mutation(({ input }) => {
        return { paneId: input.paneId, isNew: true, serializedState: '{}' }
      }),

    write: testProcedure
      .input(z.object({ paneId: z.string(), data: z.string() }))
      .mutation(() => {
        // no-op
      }),

    signal: testProcedure
      .input(z.object({ paneId: z.string(), signal: z.string().optional() }))
      .mutation(() => {
        // no-op
      }),

    kill: testProcedure
      .input(z.object({ paneId: z.string() }))
      .mutation(() => {
        // no-op
      }),

    resize: testProcedure
      .input(z.object({ paneId: z.string(), cols: z.number(), rows: z.number() }))
      .mutation(() => {
        // no-op
      }),

    detach: testProcedure
      .input(z.object({ paneId: z.string(), serializedState: z.string().optional() }))
      .mutation(() => {
        // no-op
      }),

    clearScrollback: testProcedure
      .input(z.object({ paneId: z.string() }))
      .mutation(() => {
        // no-op
      }),

    stream: testProcedure
      .input(z.string())
      .subscription(() => {
        // 返回空的 observable
        return observable((emit) => {
          // 不发送任何数据
          return () => {
            // cleanup
          }
        })
      }),
  }),

  /**
   * 测试辅助方法
   */
  helpers: router({
    /**
     * 清理所有测试数据
     */
    cleanup: testProcedure.mutation(async () => {
      const results = {
        deletedAgents: 0,
        deletedProjects: 0,
        deletedChats: 0,
        deletedWorkspaces: 0,
        deletedFiles: 0,
        deletedErgataiAgents: 0,
        deletedErgataiConversations: 0,
      }

      // 清理测试 agent（以 test- 开头的）
      const userAgentsDir = path.join(os.homedir(), ".claude", "agents")
      try {
        const files = await fs.readdir(userAgentsDir)
        for (const file of files) {
          if (file.startsWith("test-") && file.endsWith(".md")) {
            await fs.unlink(path.join(userAgentsDir, file))
            results.deletedAgents++
          }
        }
      } catch {
        // 目录不存在
      }

      // 清理测试项目（以 test- 开头的）
      const projects = testProjectStore.list()
      for (const project of projects) {
        if (project.name?.startsWith("test-")) {
          testProjectStore.delete(project.id)
          results.deletedProjects++
        }
      }

      // 清理测试对话
      const chats = testChatStore.list()
      for (const chat of chats) {
        if (chat.name?.startsWith("test-")) {
          testChatStore.delete(chat.id)
          results.deletedChats++
        }
      }

      // 清理测试 workspace
      const workspaces = testWorkspaceStore.list()
      for (const workspace of workspaces) {
        if (workspace.name?.startsWith("test-")) {
          testWorkspaceStore.delete(workspace.id)
          results.deletedWorkspaces++
        }
      }

      // 清理测试文件操作日志
      testFileOperationLog.length = 0

      // 清理 ergatai 内存存储
      results.deletedErgataiAgents = testErgataiAgentStore.list().length
      testErgataiAgentStore.clear()

      results.deletedErgataiConversations = testErgataiConversationStore.list().length
      testErgataiConversationStore.clear()

      // 清理新增的存储
      testMessageStore.clear()
      testAgentOutputStore.clear()
      testAgentProfileStore.clear()
      testLockStore.clear()
      testRateLimiterState.clear()

      return results
    }),

    /**
     * 获取测试环境信息
     */
    getEnv: testProcedure.query(() => {
      return {
        NODE_ENV: process.env.NODE_ENV,
        ELECTRON_TEST_MODE: process.env.ELECTRON_TEST_MODE,
        platform: process.platform,
        arch: process.arch,
        homeDir: os.homedir(),
      }
    }),
  }),
})
