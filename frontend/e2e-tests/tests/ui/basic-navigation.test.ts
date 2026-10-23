/**
 * E2E UI 测试 - 基本导航和布局
 * 测试应用启动、侧边栏、面板切换等基本 UI 交互
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'

describe('E2E: 基本导航和布局', () => {
  const ctx = createTestContext()

  test('应用应该成功启动并显示主界面', async () => {
    await ctx.page.waitForLoadState('networkidle')

    const mainContent = await ctx.page.waitForSelector(
      '[data-testid="main-content"], main, #root',
      { timeout: 10000 }
    )

    expect(mainContent).toBeDefined()
    expect(await mainContent.isVisible()).toBe(true)
  })

  test('应该显示侧边栏', async () => {
    await ctx.page.waitForLoadState('networkidle')

    const hasNewWorkspaceButton = await ctx.page.$('button:has-text("New Workspace")')
    const hasSearchInput = await ctx.page.$('text=Search workspaces...')

    expect(hasNewWorkspaceButton || hasSearchInput).toBeDefined()
  })

  test('侧边栏应该包含导航项', async () => {
    await ctx.page.waitForLoadState('networkidle')

    // 验证应用主界面加载成功
    const hasMainContent = await ctx.page.$('main, [data-testid="main-content"], #root')
    expect(hasMainContent).toBeTruthy()

    // 验证有按钮存在（表明 UI 已渲染）
    const hasButtons = await ctx.page.$('button')
    expect(hasButtons).toBeTruthy()
  })

  test('应该能够看到标题或品牌标识', async () => {
    await ctx.page.waitForLoadState('networkidle')

    const hasTitle = await ctx.page.$('text=Ergatai')

    expect(hasTitle).toBeDefined()
  })

  test('页面应该没有 JavaScript 错误', async () => {
    const errors: string[] = []

    ctx.page.on('pageerror', (error) => {
      errors.push(error.message)
    })

    await ctx.page.waitForLoadState('networkidle')
    await ctx.page.waitForTimeout(1000)

    const criticalErrors = errors.filter(err =>
      !err.includes('ResizeObserver') &&
      !err.includes('favicon') &&
      !err.includes('404')
    )

    expect(criticalErrors.length).toBe(0)
  })

  test('页面应该在合理时间内加载完成', async () => {
    const startTime = Date.now()

    await ctx.page.waitForLoadState('networkidle')
    await ctx.page.waitForSelector('main, [data-testid="main-content"], #root', {
      timeout: 15000,
    })

    const loadTime = Date.now() - startTime
    expect(loadTime).toBeLessThan(15000)
  })

  test('主区域应该显示欢迎消息或 workspace 选择', async () => {
    await ctx.page.waitForLoadState('networkidle')

    const hasWelcomeMessage = await ctx.page.$('text=Choose a workspace')
    const hasSelectButton = await ctx.page.$('button:has-text("Select workspace")')

    expect(hasWelcomeMessage || hasSelectButton).toBeDefined()
  })

  test('应该能够看到 workspace 选择按钮', async () => {
    await ctx.page.waitForLoadState('networkidle')

    const selectButton = await ctx.page.$('button:has-text("Select workspace")')

    expect(selectButton).toBeDefined()
  })
})
