/**
 * E2E UI 测试 - Agent 交互流程（严格 UI 按钮驱动）
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
 * 【阶段 2：验证 UI 元素】
 *
 * Step 5: 验证聊天输入区域存在
 *   - 选择器: textarea 或 [contenteditable="true"]
 *   - 断言: 元素可见
 *
 * Step 6: 验证输入区域可接收文本
 *   - 操作: locator.fill() 或 locator.type()
 *   - 断言: 文本内容正确
 *
 * Step 7: 验证 workspace 选择按钮可见
 *   - 选择器: button:has-text("Select workspace")
 *   - 断言: 元素存在
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

describe('E2E: Agent 交互流程（严格 UI 按钮驱动）', () => {
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
    // Step 1: 等待初始页面加载
    await ctx.page.waitForLoadState('networkidle')

    // 验证应用主界面加载成功
    // 使用 Playwright locator 而不是 page.$()
    const mainContent = ctx.page.locator('main, [data-testid="main-content"], #root').first()
    await mainContent.waitFor({ state: 'visible', timeout: 10000 })

    // 验证有按钮存在（表明 UI 已渲染）
    const buttons = ctx.page.locator('button')
    const buttonCount = await buttons.count()
    expect(buttonCount).toBeGreaterThan(0)
  })

  test('应该能够看到聊天输入区域（选择 workspace 后）', async () => {
    await ctx.page.waitForLoadState('networkidle')

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
    // 验证聊天输入框存在（textarea 或 contenteditable DIV 或 mentions editor）
    // 等待 placeholder 文本出现（更可靠的选择器）
    const chatPlaceholder = ctx.page.locator('text=Plan, @ for agent, / for commands').first()
    await chatPlaceholder.waitFor({ state: 'visible', timeout: 15000 })

    // 硬断言：placeholder 必须可见（表明输入框已加载）
    expect(await chatPlaceholder.isVisible()).toBe(true)
  })

  test('聊天输入应该能够接收文本', async () => {
    await ctx.page.waitForLoadState('networkidle')

    // Step 2: 点击 [Select workspace] 按钮
    const selectButton = ctx.page.locator('button:has-text("Select workspace")').first()
    await selectButton.waitFor({ state: 'visible', timeout: 10000 })
    await selectButton.click()

    // Step 3: 点击 [Default Workspace] 列表项
    const defaultWorkspace = ctx.page.locator('text=Default Workspace').first()
    await defaultWorkspace.waitFor({ state: 'visible', timeout: 5000 })
    await defaultWorkspace.click()

    // Step 4: 等待 Chat 界面加载
    // 等待 placeholder 出现，表明输入框已加载
    const chatPlaceholder = ctx.page.locator('text=Plan, @ for agent, / for commands').first()
    await chatPlaceholder.waitFor({ state: 'visible', timeout: 15000 })

    // Step 5: 在输入框中输入文本（使用 Playwright API）
    // 找到实际的输入元素（textarea 或 contenteditable）
    const chatInput = ctx.page.locator('textarea, [contenteditable="true"]').first()
    await chatInput.waitFor({ state: 'attached', timeout: 5000 })

    const testMessage = 'Test message for E2E'
    const isTextarea = await chatInput.evaluate(el => el.tagName === 'TEXTAREA')
    if (isTextarea) {
      await chatInput.fill(testMessage)
    } else {
      await chatInput.click()
      await chatInput.pressSequentially(testMessage, { delay: 50 })
    }

    // Step 6: 验证文本已输入
    const text = await chatInput.evaluate((el) => {
      return el.getAttribute('contenteditable') === 'true' ? el.textContent : (el as HTMLTextAreaElement).value
    })
    expect(text).toBe(testMessage)

    // 清空输入框
    if (isTextarea) {
      await chatInput.fill('')
    } else {
      await chatInput.click()
      await ctx.page.keyboard.press('Control+A')
      await ctx.page.keyboard.press('Backspace')
    }

    const clearedText = await chatInput.evaluate((el) => {
      return el.getAttribute('contenteditable') === 'true' ? el.textContent : (el as HTMLTextAreaElement).value
    })
    expect(clearedText).toBe('')
  })

  test('应该能够看到 workspace 选择按钮', async () => {
    await ctx.page.waitForLoadState('networkidle')

    // 查找 workspace 选择按钮（使用 Playwright locator）
    const selectButton = ctx.page.locator('button:has-text("Select workspace")').first()

    // 等待按钮出现
    await selectButton.waitFor({ state: 'visible', timeout: 10000 })

    // 硬断言：按钮必须可见
    expect(await selectButton.isVisible()).toBe(true)
  })

  test('界面应该显示 workspace 相关信息', async () => {
    await ctx.page.waitForLoadState('networkidle')

    // 查找 workspace 相关元素（使用 Playwright locator）
    const hasWorkspacesSection = ctx.page.locator('text=Workspaces')
    const hasDefaultWorkspace = ctx.page.locator('text=Default Workspace')
    const hasSearchInput = ctx.page.locator('input[placeholder*="Search" i], input[placeholder*="workspace" i]')
    const hasWorkspaceButton = ctx.page.locator('button span:has-text("Workspace")')

    // 等待至少一个元素出现
    const elements = [hasWorkspacesSection, hasDefaultWorkspace, hasSearchInput, hasWorkspaceButton]
    let found = false

    for (const element of elements) {
      try {
        await element.first().waitFor({ state: 'visible', timeout: 3000 })
        found = true
        break
      } catch {
        continue
      }
    }

    // 硬断言：至少找到一个 workspace 相关元素
    expect(found).toBe(true)
  })
})
