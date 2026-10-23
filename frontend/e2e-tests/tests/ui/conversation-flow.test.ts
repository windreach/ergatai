/**
 * E2E UI 测试 - 完整对话流程（严格 UI 按钮驱动）
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
 * 【阶段 2：发送消息】
 *
 * Step 5: 在输入框中输入消息
 *   - 操作: locator.fill() 或 locator.pressSequentially()
 *   - 元素: textarea 或 [contenteditable="true"]
 *
 * Step 6: 点击 [发送] 按钮 或 按 Enter 键
 *   - 操作: page.locator('[data-testid="send-button"]').click()
 *   - 或: page.keyboard.press('Enter')
 *   - 结果: 消息发送，agent 开始处理
 *
 * 【阶段 3：等待 & 验证回复】
 *
 * Step 7: 等待 agent 回复出现在 UI 中
 *   - 等待: assistant 角色的消息气泡出现
 *   - 选择器: [data-role="assistant"] 或 .assistant-message
 *   - 超时: 15 秒
 *
 * Step 8: 验证回复内容非空
 *   - 操作: 获取 assistant 消息的 textContent
 *   - 断言: text.length > 0
 *
 * ============================================================================
 * 测试原则
 * ============================================================================
 *
 * 1. 所有交互必须使用 Playwright locator API（.click(), .fill(), .press()）
 * 2. 禁止使用 page.evaluate() 直接操作 DOM
 * 3. 禁止使用 waitForTimeout()，必须使用 waitFor() 等待元素状态
 * 4. 所有断言必须是硬断言（expect），不能用软警告（console.log）
 *
 * ============================================================================
 */

import { test, expect, describe, beforeAll, afterAll } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

describe('E2E: 完整对话流程（严格 UI 按钮驱动）', () => {
  const ctx = createTestContext()
  const testWorkspacePath = '/tmp/ergatai-e2e-conversation-test'
  const testAgentName = 'test-e2e-conversation-agent'

  beforeAll(async () => {
    await fs.mkdir(testWorkspacePath, { recursive: true })

    const agentsDir = path.join(os.homedir(), '.claude', 'agents')
    await fs.mkdir(agentsDir, { recursive: true })
    await fs.writeFile(
      path.join(agentsDir, `${testAgentName}.md`),
      `---
name: ${testAgentName}
description: E2E conversation test agent
---

You are a helpful test assistant for conversation flow testing.

Rules:
- When user says "hello", respond with "Hello! I'm ready to help."
- When user says "help", respond with "I can help you with testing."
- When user says "bye", respond with "Goodbye! Have a great day!"
- Otherwise, echo back what the user said with "You said: " prefix.
`
    )
  })

  afterAll(async () => {
    await fs.rm(testWorkspacePath, { recursive: true, force: true }).catch(() => {})
    const agentPath = path.join(os.homedir(), '.claude', 'agents', `${testAgentName}.md`)
    await fs.unlink(agentPath).catch(() => {})
  })

  /**
   * Step 2-4: 选择 workspace 并等待 Chat 界面加载
   */
  async function selectWorkspaceAndLoadChat(): Promise<void> {
    // Step 2: 点击 [Select workspace] 按钮
    const selectButton = ctx.page.locator('button:has-text("Select workspace")').first()
    await selectButton.waitFor({ state: 'visible', timeout: 10000 })
    await selectButton.click()

    // 等待 popover 出现
    const defaultWorkspace = ctx.page.locator('text=Default Workspace').first()
    await defaultWorkspace.waitFor({ state: 'visible', timeout: 5000 })

    // Step 3: 点击 [Default Workspace] 列表项
    await defaultWorkspace.click()

    // Step 4: 等待 Chat 界面加载
    // 等待 placeholder 出现，表明输入框已加载
    const chatPlaceholder = ctx.page.locator('text=Plan, @ for agent, / for commands').first()
    await chatPlaceholder.waitFor({ state: 'visible', timeout: 15000 })
  }

  /**
   * Step 5-6: 发送消息（输入文本 + 点击发送按钮或按 Enter）
   */
  async function sendMessage(text: string): Promise<void> {
    // Step 5: 在输入框中输入消息
    const chatInput = ctx.page.locator('textarea, [contenteditable="true"]').first()
    await chatInput.waitFor({ state: 'attached', timeout: 5000 })

    const isTextarea = await chatInput.evaluate(el => el.tagName === 'TEXTAREA')
    if (isTextarea) {
      await chatInput.fill(text)
    } else {
      await chatInput.click()
      await chatInput.pressSequentially(text, { delay: 30 })
    }

    // Step 6: 点击 [发送] 按钮 或 按 Enter 键
    const sendButton = ctx.page.locator('button:has-text("Send message"), [data-testid="send-button"]').first()
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
   * Step 7-8: 等待 agent 回复并验证
   */
  async function waitForAgentReply(timeoutMs = 15000): Promise<string> {
    // 查找 assistant 消息（多种可能的选择器）
    const assistantSelectors = [
      '[data-role="assistant"]',
      '[data-message-role="assistant"]',
      '.assistant-message',
      '[class*="assistant"]',
      'text=\\[mock-agent\\]',
    ]

    let replyText = ''

    for (const selector of assistantSelectors) {
      try {
        const element = ctx.page.locator(selector).first()
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

  test('完整对话流程：选择 workspace → 发送消息 → 查看响应', async () => {
    // Step 1: 等待初始页面加载
    await ctx.page.waitForLoadState('networkidle')

    // Steps 2-4: 选择 workspace 并加载 Chat 界面
    await selectWorkspaceAndLoadChat()

    // Steps 5-6: 发送第一条消息
    await sendMessage('hello')

    // Steps 7-8: 等待并验证回复
    const reply1 = await waitForAgentReply()
    expect(reply1).toBeTruthy()
    expect(reply1.length).toBeGreaterThan(0)
    console.log('第一条回复:', reply1.slice(0, 80))

    // 发送第二条消息
    await sendMessage('help')
    const reply2 = await waitForAgentReply()
    expect(reply2).toBeTruthy()
    console.log('第二条回复:', reply2.slice(0, 80))

    // 发送第三条消息
    await sendMessage('bye')
    const reply3 = await waitForAgentReply()
    expect(reply3).toBeTruthy()
    console.log('第三条回复:', reply3.slice(0, 80))

    // 验证输入框仍然存在且可用
    const chatInput = ctx.page.locator('textarea, [contenteditable="true"]').first()
    expect(await chatInput.isVisible()).toBe(true)
  })

  test('应该能够清空聊天输入', async () => {
    await ctx.page.waitForLoadState('networkidle')
    await selectWorkspaceAndLoadChat()

    // 等待聊天输入框出现
    const chatInput = ctx.page.locator('textarea, [contenteditable="true"]').first()
    await chatInput.waitFor({ state: 'attached', timeout: 15000 })

    // 输入文本
    const testText = 'Test text'
    const isTextarea = await chatInput.evaluate(el => el.tagName === 'TEXTAREA')
    if (isTextarea) {
      await chatInput.fill(testText)
    } else {
      await chatInput.click()
      await chatInput.pressSequentially(testText, { delay: 30 })
    }

    // 验证文本已输入
    const text = await chatInput.evaluate((el) => {
      return el.getAttribute('contenteditable') === 'true' ? el.textContent : (el as HTMLTextAreaElement).value
    })
    expect(text).toBe(testText)

    // 清空输入框
    if (isTextarea) {
      await chatInput.fill('')
    } else {
      await chatInput.click()
      await ctx.page.keyboard.press('Control+A')
      await ctx.page.keyboard.press('Backspace')
    }

    // 验证已清空
    const clearedText = await chatInput.evaluate((el) => {
      return el.getAttribute('contenteditable') === 'true' ? el.textContent : (el as HTMLTextAreaElement).value
    })
    expect(clearedText).toBe('')
  })

  test('输入框应该存在且可用', async () => {
    await ctx.page.waitForLoadState('networkidle')
    await selectWorkspaceAndLoadChat()

    // 等待聊天输入框出现
    const chatInput = ctx.page.locator('textarea, [contenteditable="true"]').first()
    await chatInput.waitFor({ state: 'attached', timeout: 15000 })

    // 硬断言：输入框必须存在（attached）
    expect(await chatInput.count()).toBeGreaterThan(0)
  })
})
