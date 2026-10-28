/**
 * E2E UI 测试 - 对话侧边栏渲染
 * 验证 AgentsConversationsSidebar 组件在真实 Electron 环境中的渲染
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'

describe('E2E: 对话侧边栏渲染', () => {
  const ctx = createTestContext()

  test('通过 localStorage 触发对话侧边栏', async () => {
    await ctx.page.waitForLoadState('networkidle')
    await ctx.page.waitForTimeout(1000)

    // 截图：初始状态
    await ctx.page.screenshot({
      path: 'test-results/conversation-sidebar-01-initial.png',
      fullPage: true
    })

    // 通过 localStorage 设置 conversationsSidebarMode 为 "sidebar"
    await ctx.page.evaluate(() => {
      window.localStorage.setItem('agents-conversations-mode', '"sidebar"')
    })

    // 刷新页面以应用新设置
    await ctx.page.reload()
    await ctx.page.waitForLoadState('networkidle')
    await ctx.page.waitForTimeout(1000)

    // 截图：设置 sidebar 模式后
    await ctx.page.screenshot({
      path: 'test-results/conversation-sidebar-02-sidebar-mode.png',
      fullPage: true
    })

    // 验证对话侧边栏相关元素存在
    const hasSearchInput = await ctx.page.$('input[placeholder*="Search"], input[type="search"]')
    const hasConversationList = await ctx.page.$('[class*="conversation"], [class*="chat-list"]')
    const hasNewChatButton = await ctx.page.$('button:has-text("+"), button[aria-label*="new" i]')

    // 至少应该有一个对话相关的 UI 元素
    expect(hasSearchInput || hasConversationList || hasNewChatButton).toBeTruthy()
  })

  test('对话侧边栏应该包含搜索功能', async () => {
    await ctx.page.waitForLoadState('networkidle')

    // 设置 sidebar 模式
    await ctx.page.evaluate(() => {
      window.localStorage.setItem('agents-conversations-mode', '"sidebar"')
    })
    await ctx.page.reload()
    await ctx.page.waitForLoadState('networkidle')
    await ctx.page.waitForTimeout(1000)

    // 截图
    await ctx.page.screenshot({
      path: 'test-results/conversation-sidebar-03-search.png',
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

    // 设置 sidebar 模式
    await ctx.page.evaluate(() => {
      window.localStorage.setItem('agents-conversations-mode', '"sidebar"')
    })
    await ctx.page.reload()
    await ctx.page.waitForLoadState('networkidle')
    await ctx.page.waitForTimeout(1000)

    const criticalErrors = errors.filter(err =>
      !err.includes('ResizeObserver') &&
      !err.includes('favicon') &&
      !err.includes('404') &&
      !err.includes('hydration')
    )

    expect(criticalErrors.length).toBe(0)
  })
})
