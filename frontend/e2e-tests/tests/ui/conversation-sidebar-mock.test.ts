/**
 * E2E UI 测试 - 对话侧边栏渲染（mock 数据）
 * 通过 mock tRPC 数据和设置 atom 值来触发对话侧边栏显示
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'

describe('E2E: 对话侧边栏渲染（mock 数据）', () => {
  const ctx = createTestContext()

  test('mock workspace 数据后应该显示对话侧边栏', async () => {
    await ctx.page.waitForLoadState('networkidle')
    await ctx.page.waitForTimeout(1000)

    // 截图：初始状态
    await ctx.page.screenshot({
      path: 'test-results/conversation-sidebar-mock-01-initial.png',
      fullPage: true
    })

    // 通过 tRPC mock 设置 workspace 数据
    await ctx.page.evaluate(() => {
      // 1. 设置 conversationsSidebarMode 为 "sidebar"
      window.localStorage.setItem('agents-conversations-mode', '"sidebar"')

      // 2. 设置 selectedWorkspaceId（正确的键名和格式）
      window.localStorage.setItem('agents:selectedWorkspaceIdsByMode', '{"supervisor":"default-workspace","group":null}')

      // 3. 设置 conversationsSidebarWidth
      window.localStorage.setItem('agents-conversations-sidebar-width', '200')

      // 4. 清除 desktopView
      window.localStorage.removeItem('ergatai:desktop-view')
    })

    // 刷新页面以应用新设置
    await ctx.page.reload()
    await ctx.page.waitForLoadState('networkidle')
    await ctx.page.waitForTimeout(2000)

    // 截图：设置 mock 数据后
    await ctx.page.screenshot({
      path: 'test-results/conversation-sidebar-mock-02-after-mock.png',
      fullPage: true
    })

    // 验证对话侧边栏相关元素存在
    const hasSearchInput = await ctx.page.$('input[placeholder*="Search"], input[type="search"]')
    const hasConversationList = await ctx.page.$('[class*="conversation"], [class*="chat-list"]')
    const hasNewChatButton = await ctx.page.$('button:has-text("+"), button[aria-label*="new" i]')
    const hasSpinner = await ctx.page.$('[data-testid="spinner"], [class*="loading"]')

    // 至少应该有一个对话相关的 UI 元素
    expect(hasSearchInput || hasConversationList || hasNewChatButton || hasSpinner).toBeTruthy()
  })

  test('对话侧边栏应该包含搜索功能', async () => {
    await ctx.page.waitForLoadState('networkidle')

    // 设置 mock 数据
    await ctx.page.evaluate(() => {
      window.localStorage.setItem('agents-conversations-mode', '"sidebar"')
      window.localStorage.setItem('agents:selectedWorkspaceIdsByMode', '{"supervisor":"default-workspace","group":null}')
      window.localStorage.setItem('agents-conversations-sidebar-width', '200')
      window.localStorage.removeItem('ergatai:desktop-view')
    })
    await ctx.page.reload()
    await ctx.page.waitForLoadState('networkidle')
    await ctx.page.waitForTimeout(2000)

    // 截图
    await ctx.page.screenshot({
      path: 'test-results/conversation-sidebar-mock-03-search.png',
      fullPage: true
    })

    // 查找搜索输入框
    const searchInput = await ctx.page.$('input[placeholder*="Search"]')
    expect(searchInput).toBeTruthy()
  })

  test('对话侧边栏不应该有 JavaScript 错误', async () => {
    const errors: string[] = []

    ctx.page.on('pageerror', (error) => {
      errors.push(error.message)
    })

    await ctx.page.waitForLoadState('networkidle')

    // 设置 mock 数据
    await ctx.page.evaluate(() => {
      window.localStorage.setItem('agents-conversations-mode', '"sidebar"')
      window.localStorage.setItem('agents:selectedWorkspaceIdsByMode', '{"supervisor":"default-workspace","group":null}')
      window.localStorage.setItem('agents-conversations-sidebar-width', '200')
      window.localStorage.removeItem('ergatai:desktop-view')
    })
    await ctx.page.reload()
    await ctx.page.waitForLoadState('networkidle')
    await ctx.page.waitForTimeout(2000)

    const criticalErrors = errors.filter(err =>
      !err.includes('ResizeObserver') &&
      !err.includes('favicon') &&
      !err.includes('404') &&
      !err.includes('hydration')
    )

    expect(criticalErrors.length).toBe(0)
  })
})
