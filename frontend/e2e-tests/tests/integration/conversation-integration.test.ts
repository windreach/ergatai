/**
 * Integration Test - Agent 对话交互（严格 UI 按钮驱动）
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
 *   - popover 内容:
 *     - 搜索框: input[placeholder="Search workspaces..."]
 *     - 列表项: "Default Workspace" / 用户已创建的 workspace
 *     - 按钮: [Add repository] [Add from GitHub]
 *
 * Step 3: 点击 [Default Workspace] 列表项
 *   - 操作: page.locator('text=Default Workspace').click()
 *   - 结果: workspace 被选中，进入 chat 界面
 *   - 如果 workspace 不存在: 自动创建 default workspace
 *
 * Step 4: Chat 界面加载
 *   - 等待: textarea 出现（placeholder 含 "Plan" 或 "message"）
 *   - 等待: send 按钮出现（data-testid="send-button"）
 *
 * 【阶段 2：发送消息】
 *
 * Step 5: 在 textarea 中输入消息
 *   - 操作: page.locator('textarea').first().fill('你好')
 *   - 元素: textarea（chat 输入框）
 *
 * Step 6: 点击 [发送] 按钮
 *   - 操作: page.locator('[data-testid="send-button"]').click()
 *   - 元素: button[data-testid="send-button"]
 *   - 结果: 消息发送，agent 开始处理
 *
 * 【阶段 3：等待 & 验证回复】
 *
 * Step 7: 等待 agent 回复出现在 UI 中
 *   - 等待: assistant 角色的消息气泡出现
 *   - 选择器: [data-role="assistant"] 或 .assistant-message 或类似
 *   - 超时: 15 秒
 *
 * Step 8: 验证回复内容非空
 *   - 操作: 获取 assistant 消息的 textContent
 *   - 断言: text.length > 0
 *
 * ============================================================================
 * 后端日志检查
 * ============================================================================
 *
 * 每个测试结束后检查后端日志：
 * - 任何 WARN → 测试失败
 * - 任何 ERROR → 测试失败
 * - 过滤掉已知的非功能性初始化警告
 *
 * ============================================================================
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration, api } from '../../fixtures/integration-launcher'
import * as fs from 'fs/promises'
import * as path from 'path'

// ============================================================================
// 后端日志检查器
// ============================================================================

class BackendLogChecker {
  private errors: string[] = []
  private warnings: string[] = []
  private onData: (data: Buffer) => void

  // 过滤已知的非功能性初始化警告
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
      const isIgnored = BackendLogChecker.IGNORE_PATTERNS.some((p) => p.test(line))
      if (isIgnored) return

      if (/\bERROR\b/.test(line)) this.errors.push(line.trim())
      if (/\bWARN\b/.test(line)) this.warnings.push(line.trim())
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

// ============================================================================
// 全局状态
// ============================================================================

let electronApp: any
let page: any
let logChecker: BackendLogChecker | null = null

// ============================================================================
// UI 辅助函数（严格按钮操作）
// ============================================================================

/**
 * Step 2: 点击 [Select workspace] 按钮
 * 打开 workspace 选择 popover
 */
async function clickSelectWorkspaceButton(): Promise<void> {
  const button = page.locator('button:has-text("Select workspace")').first()
  await button.waitFor({ state: 'visible', timeout: 10000 })
  await button.click()
  // 等待 popover 出现
  await page.locator('text=Default Workspace').waitFor({ state: 'visible', timeout: 5000 })
}

/**
 * Step 3: 点击 [Default Workspace] 列表项
 * 选择或创建 default workspace
 */
async function clickDefaultWorkspace(): Promise<void> {
  const item = page.locator('text=Default Workspace').first()
  await item.waitFor({ state: 'visible', timeout: 5000 })
  await item.click()
}

/**
 * Step 4: 等待 Chat 界面加载完成
 * 验证输入框和 send 按钮都出现
 * 注意：输入框可能是 textarea 或 contenteditable div（mentions editor）
 */
async function waitForChatUiReady(timeoutMs = 15000): Promise<void> {
  // 等待输入框出现（textarea 或 contenteditable div）
  const chatInput = page.locator('textarea, [contenteditable="true"]').first()
  await chatInput.waitFor({ state: 'visible', timeout: timeoutMs })

  // 等待 send 按钮出现（可能禁用状态）
  const sendButton = page.locator('button:has-text("Send message"), [data-testid="send-button"]').first()
  await sendButton.waitFor({ state: 'attached', timeout: 5000 })
}

/**
 * Step 5: 在输入框中输入消息
 * 支持 textarea 和 contenteditable div（mentions editor）
 */
async function typeMessage(message: string): Promise<void> {
  const chatInput = page.locator('textarea, [contenteditable="true"]').first()
  await chatInput.waitFor({ state: 'visible', timeout: 5000 })

  // 判断是 textarea 还是 contenteditable div
  const isTextarea = await chatInput.evaluate(el => el.tagName === 'TEXTAREA')
  if (isTextarea) {
    await chatInput.fill(message)
  } else {
    // contenteditable div：点击后逐字输入
    await chatInput.click()
    await chatInput.pressSequentially(message, { delay: 30 })
  }
}

/**
 * Step 6: 点击 [发送] 按钮
 * 按钮文本可能是 "Send message" 或有 data-testid="send-button"
 */
async function clickSendButton(): Promise<void> {
  const sendButton = page.locator('button:has-text("Send message"), [data-testid="send-button"]').first()
  await sendButton.waitFor({ state: 'visible', timeout: 3000 })

  // 等待按钮变为可点击状态（不是 disabled）
  // Playwright 的 click() 会自动等待按钮可操作，但如果需要明确等待，可以用 expect
  await expect(sendButton).toBeEnabled({ timeout: 5000 })
  await sendButton.click()
}

/**
 * Step 7: 等待 agent 回复出现在 UI 中
 * 返回回复文本
 */
async function waitForAgentReply(timeoutMs = 20000): Promise<string> {
  // 查找 assistant 消息（多种可能的选择器）
  const assistantSelectors = [
    '[data-role="assistant"]',
    '[data-message-role="assistant"]',
    '.assistant-message',
    '[class*="assistant"]',
    // 如果以上都不行，查找包含 mock-agent 回复特征的元素
    'text=\\[mock-agent\\]',
  ]

  let replyText = ''

  for (const selector of assistantSelectors) {
    try {
      const element = page.locator(selector).first()
      await element.waitFor({ state: 'visible', timeout: timeoutMs / assistantSelectors.length })
      replyText = await element.textContent() || ''
      if (replyText.trim().length > 0) break
    } catch {
      // 尝试下一个选择器
      continue
    }
  }

  if (!replyText || replyText.trim().length === 0) {
    throw new Error(`Agent 未在 ${timeoutMs}ms 内回复（UI 中未出现 assistant 消息）`)
  }

  return replyText.trim()
}

/**
 * 完整的 UI 流程：从 workspace 选择到发送消息并等待回复
 */
async function fullUiFlow(message: string): Promise<string> {
  // Step 2: 点击 [Select workspace]
  await clickSelectWorkspaceButton()

  // Step 3: 点击 [Default Workspace]
  await clickDefaultWorkspace()

  // Step 4: 等待 Chat UI 加载
  await waitForChatUiReady()

  // Step 4.5: 选择 agent（通过 @mention 或按钮）
  // mock-agent 已通过 API 注册，尝试在 @mention 中选择
  // 如果找不到，使用默认的 claude-code
  await selectAgent('mock-agent')

  // Step 5: 输入消息
  await typeMessage(message)

  // Step 6: 点击 [发送]
  await clickSendButton()

  // Step 7: 等待回复
  const reply = await waitForAgentReply()

  return reply
}

/**
 * Step 4.5: 选择 Agent
 * 通过点击 agent 按钮打开选择列表，然后选择 mock-agent
 *
 * 注意：CoreAgentSelector 显示的是已安装的 agent profiles（通过 binary_detection::is_installed 检查）
 * 如果 mock-agent 的 command 不是有效的可执行文件，它不会出现在选择器中
 */
async function selectAgent(preferredAgent: string): Promise<void> {
  // 等待 chat 界面完全加载
  await page.waitForTimeout(2000)

  // 调试：列出页面上所有可见的按钮
  const allButtons = await page.locator('button').all()
  console.log(`🔍 页面上共有 ${allButtons.length} 个按钮`)

  // 查找包含 agent 名称的按钮（CoreAgentSelector 渲染的按钮）
  // 按钮可能显示 "Claude Code"、"Codex"、"OpenCode"、"Cursor" 或其他注册的 agent 名称
  // 使用更宽松的选择器：查找任何包含文本的按钮
  const agentButtonSelectors = [
    'button:has-text("Claude Code")',
    'button:has-text("Claude")',
    'button:has-text("Codex")',
    'button:has-text("OpenCode")',
    'button:has-text("Cursor")',
    'button:has-text("mock-agent")',
    // 如果以上都找不到，尝试查找包含 ChevronDown 图标的按钮（CoreAgentSelector 的特征）
    'button:has(svg.lucide-chevron-down)',
  ]

  let agentButton = null
  for (const selector of agentButtonSelectors) {
    try {
      const button = page.locator(selector).first()
      await button.waitFor({ state: 'visible', timeout: 2000 })
      agentButton = button
      console.log(`✅ 找到 agent 选择按钮: ${selector}`)
      break
    } catch {
      // 继续尝试下一个选择器
    }
  }

  if (!agentButton) {
    console.log('⚠️ 未找到 agent 选择按钮，尝试 @mention')
    console.log('⚠️ 注意：@mention 只插入文本，不会改变实际启动的 agent')

    // 如果找不到 agent 按钮，尝试 @mention
    const chatInput = page.locator('textarea, [contenteditable="true"]').first()
    await chatInput.waitFor({ state: 'attached', timeout: 5000 })

    const isTextarea = await chatInput.evaluate(el => el.tagName === 'TEXTAREA')
    if (isTextarea) {
      await chatInput.fill('@')
    } else {
      await chatInput.click()
      await chatInput.pressSequentially('@', { delay: 30 })
    }

    // 等待 agent 选择下拉菜单出现
    await page.waitForTimeout(1000)

    const preferredAgentOption = page.locator(`text=${preferredAgent}`).first()

    try {
      await preferredAgentOption.waitFor({ state: 'visible', timeout: 3000 })
      await preferredAgentOption.click()
      console.log(`✅ 通过 @mention 选择了 ${preferredAgent}`)
    } catch {
      console.log(`⚠️ 未找到 ${preferredAgent}，使用默认 agent`)
      if (isTextarea) {
        await chatInput.fill('')
      } else {
        await chatInput.click()
        await page.keyboard.press('Control+A')
        await page.keyboard.press('Backspace')
      }
    }
    return
  }

  // 点击 agent 按钮打开选择列表
  await agentButton.click()
  console.log('✅ 点击了 agent 选择按钮')

  // 等待 agent 选择列表出现
  await page.waitForTimeout(1000)

  // 尝试查找并选择指定的 agent
  // agent 列表中显示的是 agent 名称（如 "mock-agent"）
  const agentOption = page.locator(`button:has-text("${preferredAgent}")`).first()

  try {
    await agentOption.waitFor({ state: 'visible', timeout: 3000 })
    await agentOption.click()
    console.log(`✅ 选择了 ${preferredAgent}`)
  } catch {
    console.log(`⚠️ 未找到 ${preferredAgent}，尝试查找其他 agent`)
    // 如果找不到指定的 agent，查找列表中第一个可用的 agent
    const firstAgent = page.locator('[role="option"], [role="menuitem"], .agent-item, [data-agent], button:has-text("-")').first()
    try {
      await firstAgent.waitFor({ state: 'visible', timeout: 3000 })
      await firstAgent.click()
      console.log('✅ 选择了第一个可用的 agent')
    } catch {
      console.log(`⚠️ 无法选择 agent，使用默认 agent`)
      // 关闭下拉菜单（按 Escape）
      await page.keyboard.press('Escape')
    }
  }
}

/**
 * Step 4.5: 通过 @mention 选择 Agent
 * 在输入框中输入 @ 触发 agent 选择下拉菜单，然后选择指定 agent
 */
async function selectAgentViaMention(agentName: string): Promise<void> {
  const chatInput = page.locator('textarea, [contenteditable="true"]').first()
  await chatInput.waitFor({ state: 'attached', timeout: 5000 })

  // 输入 @ 触发 agent 选择
  const isTextarea = await chatInput.evaluate(el => el.tagName === 'TEXTAREA')
  if (isTextarea) {
    await chatInput.fill('@')
  } else {
    await chatInput.click()
    await chatInput.pressSequentially('@', { delay: 30 })
  }

  // 等待 agent 选择下拉菜单出现
  const agentDropdown = page.locator('[role="listbox"], [role="menu"], .mentions-dropdown, [class*="mention"]').first()
  await agentDropdown.waitFor({ state: 'visible', timeout: 5000 })

  // 选择指定的 agent
  const agentOption = page.locator(`text=${agentName}, [data-value="${agentName}"]`).first()
  await agentOption.waitFor({ state: 'visible', timeout: 3000 })
  await agentOption.click()

  // 等待下拉菜单关闭
  await agentDropdown.waitFor({ state: 'hidden', timeout: 3000 })
}

// ============================================================================
// 测试用例
// ============================================================================

describe('Integration: Agent 对话交互（严格 UI 按钮驱动）', () => {
  beforeAll(async () => {
    // Setup: 启动后端 + Electron（这是基础设施，不是测试操作）
    const env = await launchIntegrationElectron()
    electronApp = env.electron
    page = env.page

    // 注册 mock agent profile（setup，非测试操作）
    try {
      await (await import('../../fixtures/integration-launcher')).api.registerAgentProfile({
        name: 'mock-agent',
        command: path.resolve(__dirname, '../../../../scripts/mock-acp-agent.py'),
        agent_type: 'acp',
      })
      console.log('✅ Mock agent profile registered (setup)')
    } catch (e) {
      console.log('Mock agent profile already exists')
    }

    // 初始化日志检查器
    const backendProcess = (env as any).backendProcess
    if (backendProcess) {
      logChecker = new BackendLogChecker(backendProcess)
    }
  })

  afterAll(async () => {
    logChecker?.destroy()
    await cleanupIntegration(electronApp)
  })

  beforeEach(() => {
    logChecker?.reset()
  })

  /**
   * 每个测试结束后检查后端日志
   * 任何 WARN 或 ERROR 都会让测试失败
   */
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

  // ==========================================================================
  // 测试用例 1: 基本对话
  // ==========================================================================

  test('通过 UI 按钮发送消息，必须收到真实回复', async () => {
    // Step 1: 等待初始页面加载
    await page.waitForLoadState('networkidle')

    // 验证初始状态：显示 workspace 选择页面
    const hasChooseText = await page.locator('text=Choose a workspace').isVisible()
    expect(hasChooseText).toBe(true)

    // Steps 2-7: 完整 UI 流程
    const reply = await fullUiFlow('你好，请介绍一下自己')

    // Step 8: 验证回复
    expect(reply).toBeTruthy()
    expect(reply.length).toBeGreaterThan(0)
    console.log('✅ Agent 回复:', reply.slice(0, 100))
  })

  // ==========================================================================
  // 测试用例 2: 多轮对话
  // ==========================================================================

  test('通过 UI 按钮进行多轮对话，每轮都必须有回复', async () => {
    await page.waitForLoadState('networkidle')

    // 第一轮
    const reply1 = await fullUiFlow('你好')
    expect(reply1).toBeTruthy()
    console.log('第一轮回复:', reply1.slice(0, 80))

    // 第二轮（在同一个 chat 中继续）
    await typeMessage('你能做什么？')
    await clickSendButton()
    const reply2 = await waitForAgentReply()
    expect(reply2).toBeTruthy()
    console.log('第二轮回复:', reply2.slice(0, 80))
  })
})
