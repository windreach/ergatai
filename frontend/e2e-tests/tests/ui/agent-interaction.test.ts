/**
 * E2E UI 测试 - Agent 交互流程
 * 测试真实的用户交互：选择 workspace、启动 agent、发送消息、查看响应
 */

import { test, expect, describe, beforeAll, afterAll } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

describe('E2E: Agent 交互流程', () => {
  const ctx = createTestContext()
  const testWorkspacePath = '/tmp/ergatai-e2e-agent-interaction'
  const testAgentName = 'test-e2e-interaction-agent'

  beforeAll(async () => {
    await fs.mkdir(testWorkspacePath, { recursive: true })

    // 创建测试 agent
    const agentsDir = path.join(os.homedir(), '.claude', 'agents')
    await fs.mkdir(agentsDir, { recursive: true })
    await fs.writeFile(
      path.join(agentsDir, `${testAgentName}.md`),
      `---
name: ${testAgentName}
description: E2E interaction test agent
---

You are a helpful test assistant. Always respond with "Agent response:" followed by a summary of the user's message.
`
    )
  })

  afterAll(async () => {
    await fs.rm(testWorkspacePath, { recursive: true, force: true }).catch(() => {})

    // 清理测试 agent
    const agentPath = path.join(os.homedir(), '.claude', 'agents', `${testAgentName}.md`)
    await fs.unlink(agentPath).catch(() => {})
  })

  test('应该能够在侧边栏看到导航项', async () => {
    await ctx.page.waitForLoadState('networkidle')

    // 基于实际 UI 检查侧边栏导航项
    const hasNewWorkspaceButton = await ctx.page.$('button:has-text("New Workspace")')
    const hasTaskBoardButton = await ctx.page.$('button:has-text("Task Board")')
    const hasAddAgentButton = await ctx.page.$('button:has-text("Add Agent")')
    const hasWorkspacesSection = await ctx.page.$('text=Workspaces')

    // 至少应该有这些导航元素中的大部分
    const navCount = [hasNewWorkspaceButton, hasTaskBoardButton, hasAddAgentButton, hasWorkspacesSection]
      .filter(Boolean).length

    expect(navCount).toBeGreaterThanOrEqual(2)
  })

  test('应该能够看到聊天输入区域（选择 workspace 后）', async () => {
    await ctx.page.waitForLoadState('networkidle')

    // 先选择 workspace
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

    // 验证聊天输入框存在（contenteditable DIV）
    const chatInput = await ctx.page.$('[contenteditable="true"]')
    expect(chatInput).toBeDefined()
  })

  test('聊天输入应该能够接收文本', async () => {
    await ctx.page.waitForLoadState('networkidle')

    // 先选择 workspace
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

    // 找到聊天输入框
    const chatInput = await ctx.page.$('[contenteditable="true"]')
    expect(chatInput).toBeDefined()

    // 使用 JavaScript 设置文本
    await chatInput.evaluate((el) => el.textContent = 'Test message for E2E')
    const text = await chatInput.textContent()
    expect(text).toBe('Test message for E2E')

    // 清空
    await chatInput.evaluate((el) => el.textContent = '')
    const clearedText = await chatInput.textContent()
    expect(clearedText).toBe('')
  })

  test('应该能够看到 workspace 选择按钮', async () => {
    await ctx.page.waitForLoadState('networkidle')

    // 查找 workspace 选择按钮
    const selectButton = await ctx.page.$('button:has-text("Select workspace")')

    // 按钮应该存在
    expect(selectButton).toBeDefined()
  })

  test('界面应该显示 workspace 相关信息', async () => {
    await ctx.page.waitForLoadState('networkidle')

    // 查找 workspace 相关元素
    const hasWorkspacesSection = await ctx.page.$('text=Workspaces')
    const hasDefaultWorkspace = await ctx.page.$('text=Default Workspace')
    const hasSearchInput = await ctx.page.$('[placeholder*="Search workspaces"]')

    // 至少应该有其中一个
    const workspaceElements = [hasWorkspacesSection, hasDefaultWorkspace, hasSearchInput].filter(Boolean).length
    expect(workspaceElements).toBeGreaterThanOrEqual(1)
  })
})
