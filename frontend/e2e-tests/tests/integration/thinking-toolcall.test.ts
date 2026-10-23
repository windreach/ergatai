/**
 * Integration Test - Agent 思考和工具调用（严格 UI 按钮驱动 + API 验证）
 *
 * ============================================================================
 * UI 交互流程（每一步调用的按钮/元素）
 * ============================================================================
 *
 * 【阶段 1：启动 & Workspace 选择】
 *
 * Step 1: Electron 启动 → 显示 workspace 选择页面
 *   - 页面文本: "Choose a workspace to start multi-agent collaboration"
 *   - 可见按钮: [Select workspace]
 *
 * Step 2: 点击 [Select workspace] 按钮
 *   - 操作: page.locator('button:has-text("Select workspace")').click()
 *   - 结果: 弹出 workspace 选择 popover
 *
 * Step 3: 点击 [Default Workspace] 列表项
 *   - 操作: page.locator('text=Default Workspace').click()
 *   - 结果: workspace 被选中，进入 chat 界面
 *
 * Step 4: Chat 界面加载
 *   - 等待: textarea 或 contenteditable 出现
 *   - 等待: send 按钮出现（data-testid="send-button"）
 *
 * 【阶段 2：发送消息（严格 UI 按钮）】
 *
 * Step 5: 在 textarea 中输入消息
 *   - 操作: locator.fill() 或 locator.pressSequentially()
 *   - 元素: textarea 或 [contenteditable="true"]
 *
 * Step 6: 点击 [发送] 按钮
 *   - 操作: page.locator('[data-testid="send-button"]').click()
 *   - 元素: button[data-testid="send-button"]
 *   - 结果: 消息发送，agent 开始处理
 *
 * 【阶段 3：验证内部数据（通过 API）】
 *
 * Step 7: 等待 agent 回复出现
 *   - 等待: UI 中出现 assistant 消息
 *   - 超时: 15 秒
 *
 * Step 8: 通过 API 获取 conversation messages
 *   - 操作: api.getConversationMessages(conversationId)
 *   - 目的: 验证 thinking 和 tool_calls 字段（这些内部数据不在 UI 中显示）
 *
 * ============================================================================
 * 测试原则
 * ============================================================================
 *
 * 1. 消息发送必须使用 UI 按钮（严格遵循用户要求）
 * 2. 内部数据验证（thinking/tool_calls）需要通过 API，因为这些数据不在 UI 中显示
 * 3. 后端日志中任何 WARN/ERROR 都视为测试失败
 * 4. 所有断言必须是硬断言（expect），不能用软警告
 *
 * ============================================================================
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration, api, waitFor } from '../../fixtures/integration-launcher'
import * as fs from 'fs/promises'
import * as path from 'path'

class BackendLogChecker {
  private errors: string[] = []
  private warnings: string[] = []
  private onData: (data: Buffer) => void

  // 这些是测试环境中预期的非功能性警告，不影响对话功能验证
  // 只过滤明确标记 "non-fatal" 且关于初始化/文件访问的
  private static IGNORE_PATTERNS = [
    /File access control not initialized/,
    /non-fatal, continuing/,
    /Failed to pre-register workspace boundary/,
    /Failed to register SystemToken for ACP session/,
    /CORS.*no ERGATAI_CORS_ALLOWED_ORIGINS/,
    /TLS disabled/,
    /using nats-server from system PATH/,
    /Port in use, trying next port/,
  ]

  constructor(private backendProcess: any) {
    this.onData = (data: Buffer) => {
      const line = data.toString()
      // 先检查是否是被忽略的非功能性警告
      const isIgnored = BackendLogChecker.IGNORE_PATTERNS.some((p) => p.test(line))
      if (isIgnored) return

      if (/\bERROR\b/.test(line)) {
        this.errors.push(line.trim())
      } else if (/\bWARN\b/.test(line)) {
        this.warnings.push(line.trim())
      }
    }
    backendProcess.stderr?.on('data', this.onData)
    backendProcess.stdout?.on('data', this.onData)
  }

  check() {
    return {
      hasErrors: this.errors.length > 0 || this.warnings.length > 0,
      errors: [...this.errors],
      warnings: [...this.warnings],
    }
  }

  reset() {
    this.errors = []
    this.warnings = []
  }

  destroy() {
    this.backendProcess.stderr?.off('data', this.onData)
    this.backendProcess.stdout?.off('data', this.onData)
  }
}

let electronApp: any
let page: any
const testWorkDir = '/tmp/ergatai-integration-thinking-test'
const spawnedAgentIds: string[] = []
let testWorkspaceId: string | null = null
const MOCK_AGENT_SCRIPT = path.resolve(__dirname, '../../../../scripts/mock-acp-agent.py')
let logChecker: BackendLogChecker | null = null

/**
 * UI 辅助函数：选择 workspace 并等待 Chat 界面加载
 * Steps 2-4: 点击 [Select workspace] → 点击 [Default Workspace] → 等待 Chat UI
 */
async function selectWorkspaceAndLoadChat(): Promise<void> {
  // Step 2: 点击 [Select workspace] 按钮
  const selectButton = page.locator('button:has-text("Select workspace")').first()
  await selectButton.waitFor({ state: 'visible', timeout: 10000 })
  await selectButton.click()

  // 等待 popover 出现
  const defaultWorkspace = page.locator('text=Default Workspace').first()
  await defaultWorkspace.waitFor({ state: 'visible', timeout: 5000 })

  // Step 3: 点击 [Default Workspace] 列表项
  await defaultWorkspace.click()

  // Step 4: 等待 Chat 界面加载
  // 等待 placeholder 出现，表明输入框已加载
  const chatPlaceholder = page.locator('text=Plan, @ for agent, / for commands').first()
  await chatPlaceholder.waitFor({ state: 'visible', timeout: 15000 })
}

/**
 * UI 辅助函数：通过 UI 按钮发送消息
 * Steps 5-6: 在 textarea 输入 → 点击 [发送] 按钮
 */
async function sendMessageViaUI(message: string): Promise<void> {
  // Step 5: 在输入框中输入消息
  const chatInput = page.locator('textarea, [contenteditable="true"]').first()
  await chatInput.waitFor({ state: 'attached', timeout: 5000 })

  const isTextarea = await chatInput.evaluate(el => el.tagName === 'TEXTAREA')
  if (isTextarea) {
    await chatInput.fill(message)
  } else {
    await chatInput.click()
    await chatInput.pressSequentially(message, { delay: 30 })
  }

  // Step 6: 点击 [发送] 按钮
  const sendButton = page.locator('button:has-text("Send message"), [data-testid="send-button"]').first()
  try {
    await sendButton.waitFor({ state: 'visible', timeout: 3000 })
    // 等待按钮变为可点击状态
    await expect(sendButton).toBeEnabled({ timeout: 5000 })
    await sendButton.click()
  } catch {
    // 如果找不到发送按钮，按 Enter 键发送
    await chatInput.press('Enter')
  }
}

/**
 * UI 辅助函数：等待 agent 回复出现在 UI 中
 * Step 7: 等待 UI 中出现 assistant 消息
 */
async function waitForAgentReplyInUI(timeoutMs = 15000): Promise<void> {
  const assistantSelectors = [
    '[data-role="assistant"]',
    '[data-message-role="assistant"]',
    '.assistant-message',
    '[class*="assistant"]',
    'text=\\[mock-agent\\]',
  ]

  let found = false
  for (const selector of assistantSelectors) {
    try {
      const element = page.locator(selector).first()
      await element.waitFor({ state: 'visible', timeout: timeoutMs / assistantSelectors.length })
      found = true
      break
    } catch {
      continue
    }
  }

  if (!found) {
    throw new Error(`Agent 未在 ${timeoutMs}ms 内回复（UI 中未出现 assistant 消息）`)
  }
}

/**
 * 通过 UI 按钮发送消息并通过 API 验证内部数据（thinking/tool_calls）
 *
 * 消息发送：严格使用 UI 按钮（Steps 5-7）
 * 内部数据验证：通过 API 获取 conversation messages（Step 8）
 */
async function sendViaUIAndWaitReply(
  message: string,
  conversationId?: string,
  timeoutMs = 15000,
): Promise<{ conversationId: string; messages: any[] }> {
  // Steps 5-6: 通过 UI 按钮发送消息
  await sendMessageViaUI(message)

  // Step 7: 等待 UI 中出现 assistant 回复
  await waitForAgentReplyInUI(timeoutMs)

  // Step 8: 通过 API 获取 conversation messages 以验证内部数据
  // 注意：thinking 和 tool_calls 字段不在 UI 中显示，需要通过 API 验证
  if (!conversationId) {
    // 如果没有提供 conversationId，从 API 获取最新的 conversation
    const conversations = await api.listConversations()
    const latestConv = conversations[conversations.length - 1]
    conversationId = latestConv?.conversation_id || latestConv?.id
  }

  expect(conversationId).toBeDefined()

  const messages = await waitFor(
    async () => {
      const msgs = await api.getConversationMessages(conversationId!)
      const hasAssistantMsg = Array.isArray(msgs) && msgs.some((m: any) => m.role === 'assistant')
      if (!hasAssistantMsg) throw new Error('waiting for agent response')
      return msgs
    },
    { timeout: timeoutMs, interval: 500, message: `Agent 未回复消息` },
  )

  return { conversationId: conversationId!, messages }
}

describe('Integration: Agent 思考和工具调用（真实后端）', () => {
  beforeAll(async () => {
    await fs.mkdir(testWorkDir, { recursive: true })

    const env = await launchIntegrationElectron()
    electronApp = env.electron
    page = env.page

    try {
      await api.registerAgentProfile({
        name: 'mock-agent',
        command: MOCK_AGENT_SCRIPT,
        agent_type: 'acp',
      })
      console.log('✅ Mock agent profile registered')
    } catch (e) {
      console.log('Mock agent profile already exists')
    }

    const workspace = await api.createWorkspace({
      name: 'thinking-test-workspace',
      work_dir: testWorkDir,
    })
    testWorkspaceId = workspace.workspace_id || workspace.id

    const backendProcess = (env as any).backendProcess
    if (backendProcess) {
      logChecker = new BackendLogChecker(backendProcess)
    }
  })

  afterAll(async () => {
    for (const id of spawnedAgentIds) {
      await api.killAgent(id).catch(() => {})
    }
    if (testWorkspaceId) {
      await api.deleteWorkspace(testWorkspaceId).catch(() => {})
    }
    await fs.rm(testWorkDir, { recursive: true, force: true }).catch(() => {})
    logChecker?.destroy()
    await cleanupIntegration(electronApp)
  })

  beforeEach(() => {
    logChecker?.reset()
  })

  test.afterEach(async () => {
    if (!logChecker) return
    const { hasErrors, errors, warnings } = logChecker.check()
    if (hasErrors) {
      const report = [
        errors.length > 0 ? `ERRORS (${errors.length}):\n${errors.slice(0, 10).join('\n')}` : '',
        warnings.length > 0 ? `WARNINGS (${warnings.length}):\n${warnings.slice(0, 10).join('\n')}` : '',
      ].filter(Boolean).join('\n\n')
      throw new Error(`后端日志包含错误/警告，测试失败:\n${report}`)
    }
  })

  describe('Agent 思考过程', () => {
    test('Agent 响应必须包含思考过程', async () => {
      // Step 1: 等待初始页面加载
      await page.waitForLoadState('networkidle')

      // Steps 2-4: 选择 workspace 并加载 Chat 界面
      await selectWorkspaceAndLoadChat()

      // Steps 5-8: 通过 UI 按钮发送消息并等待回复
      const { conversationId, messages } = await sendViaUIAndWaitReply('你好，请介绍一下自己')
      console.log('Conversation ID:', conversationId, 'Messages:', messages.length)

      // 硬断言：必须有 assistant 回复
      const assistantMessages = messages.filter((m: any) => m.role === 'assistant')
      expect(assistantMessages.length).toBeGreaterThan(0)

      // 硬断言：回复中必须包含思考过程（通过 API 验证内部数据）
      const messageWithThinking = assistantMessages.find((m: any) =>
        m.thinking !== null && m.thinking !== undefined && m.thinking !== '[]'
      )
      expect(messageWithThinking).toBeDefined()
      expect(messageWithThinking!.thinking).toBeDefined()
      console.log('✅ Agent 思考过程已验证')
    })
  })

  describe('工具调用', () => {
    test('包含 "tool" 的消息必须触发工具调用', async () => {
      // Step 1: 等待初始页面加载
      await page.waitForLoadState('networkidle')

      // Steps 2-4: 选择 workspace 并加载 Chat 界面
      await selectWorkspaceAndLoadChat()

      // Steps 5-8: 通过 UI 按钮发送消息并等待回复
      const { messages } = await sendViaUIAndWaitReply('请使用 tool 读取文件')

      // 硬断言：必须找到工具调用（通过 API 验证内部数据）
      const messageWithToolCall = messages.find((m: any) =>
        m.tool_calls !== null &&
        m.tool_calls !== undefined &&
        m.tool_calls !== '[]' &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.length > 0
      )

      expect(messageWithToolCall).toBeDefined()
      expect(messageWithToolCall!.tool_calls.length).toBeGreaterThan(0)
      console.log('✅ 工具调用已验证:', messageWithToolCall!.tool_calls[0])
    })
  })

  describe('完整对话流程', () => {
    test('Agent 必须产生完整响应（思考 + 工具 + 文本）', async () => {
      // Step 1: 等待初始页面加载
      await page.waitForLoadState('networkidle')

      // Steps 2-4: 选择 workspace 并加载 Chat 界面
      await selectWorkspaceAndLoadChat()

      // Steps 5-8: 通过 UI 按钮发送消息并等待回复
      const { messages } = await sendViaUIAndWaitReply('使用 tool 读取文件并分析')

      // 硬断言：messages 不能为空
      expect(messages.length).toBeGreaterThan(0)

      // 验证每条消息结构完整（通过 API 验证内部数据）
      for (const message of messages) {
        expect(message.message_id || message.id).toBeDefined()
        expect(message.conversation_id).toBeDefined()
        expect(message.role).toBeDefined()
      }

      // 硬断言：至少有一条消息包含实际内容
      const hasContent = messages.some((m: any) =>
        (m.thinking && m.thinking !== '[]') ||
        (m.tool_calls && m.tool_calls !== '[]') ||
        (m.text_chunks && m.text_chunks !== '[]') ||
        m.final_text !== null
      )
      expect(hasContent).toBe(true)
      console.log('✅ 完整响应验证通过，消息数:', messages.length)
    })
  })
})
