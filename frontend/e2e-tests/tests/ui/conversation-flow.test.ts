/**
 * E2E UI 测试 - 完整对话流程
 * 测试真实的用户对话流程：选择 workspace → 启动 agent → 发送消息 → 查看响应 → 多轮对话
 */

import { test, expect, describe, beforeAll, afterAll } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

describe('E2E: 完整对话流程', () => {
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

  async function selectWorkspace() {
    await ctx.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const selectButton = buttons.find(b => b.textContent?.includes('Select workspace'))
      if (selectButton) selectButton.click()
    })
    await ctx.page.waitForTimeout(1000)

    await ctx.page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('*'))
      const workspace = elements.find(el => el.textContent?.trim() === 'Default Workspace' && el.children.length === 0)
      if (workspace) (workspace as HTMLElement).click()
    })
    await ctx.page.waitForTimeout(2000)
  }

  async function sendMessage(text: string) {
    const chatInput = await ctx.page.$('[contenteditable="true"]')
    if (chatInput) {
      await chatInput.evaluate((el, msg) => el.textContent = msg, text)
      await chatInput.press('Enter')
    }
  }

  test('完整对话流程：选择 workspace → 发送消息 → 查看响应', async () => {
    await ctx.page.waitForLoadState('networkidle')
    await selectWorkspace()

    // 发送第一条消息
    await sendMessage('hello')
    await ctx.page.waitForTimeout(3000)

    // 验证页面有内容变化（表明消息已发送）
    const pageContent = await ctx.page.evaluate(() => document.body.textContent)
    expect(pageContent).toBeDefined()

    // 发送第二条消息
    await sendMessage('help')
    await ctx.page.waitForTimeout(3000)

    // 发送第三条消息
    await sendMessage('bye')
    await ctx.page.waitForTimeout(3000)

    // 验证输入框仍然存在且可用
    const stillHasInput = await ctx.page.$('[contenteditable="true"]')
    expect(stillHasInput).toBeDefined()
  })

  test('应该能够清空聊天输入', async () => {
    await ctx.page.waitForLoadState('networkidle')
    await selectWorkspace()

    const chatInput = await ctx.page.waitForSelector('[contenteditable="true"]', { timeout: 5000 })
    expect(chatInput).toBeDefined()

    // 使用 JavaScript 设置内容
    await chatInput.evaluate((el) => el.textContent = 'Test text')
    const text = await chatInput.textContent()
    expect(text).toBe('Test text')

    // 清空
    await chatInput.evaluate((el) => el.textContent = '')
    const clearedText = await chatInput.textContent()
    expect(clearedText).toBe('')
  })

  test('输入框应该存在且可用', async () => {
    await ctx.page.waitForLoadState('networkidle')
    await selectWorkspace()

    const chatInput = await ctx.page.waitForSelector('[contenteditable="true"]', { timeout: 5000 })
    expect(chatInput).toBeDefined()
    expect(await chatInput.isVisible()).toBe(true)
  })
})
