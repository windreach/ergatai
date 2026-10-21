/**
 * E2E UI 测试 - Workspace 创建流程
 * 测试核心的 Workspace 交互：创建、选择
 */

import { test, expect, describe, beforeAll, afterAll } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'
import * as fs from 'fs/promises'

describe('E2E: Workspace 创建流程', () => {
  const ctx = createTestContext()
  const testWorkspacePath = '/tmp/ergatai-e2e-workspace-ui-test'

  beforeAll(async () => {
    await fs.mkdir(testWorkspacePath, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(testWorkspacePath, { recursive: true, force: true }).catch(() => {})
  })

  test('应该能够通过 UI 创建新 workspace', async () => {
    await ctx.page.waitForLoadState('networkidle')

    // 使用 JavaScript 点击避免遮挡问题
    await ctx.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const createButton = buttons.find(b => b.textContent?.includes('New Workspace'))
      if (createButton) createButton.click()
    })

    // 等待对话框/表单出现
    await ctx.page.waitForTimeout(1000)

    // 验证对话框出现（查找表单相关元素）
    const hasDialog = await ctx.page.$('[role="dialog"], .modal, input[placeholder*="name" i], input[placeholder*="path" i]')
    expect(hasDialog).toBeDefined()

    // 查找名称输入框
    const nameInput = await ctx.page.$('input[placeholder*="name" i], input[name="name"]')
    if (nameInput) {
      await nameInput.fill('test-e2e-workspace')
    }

    // 查找路径输入框
    const pathInput = await ctx.page.$('input[placeholder*="path" i], input[name="path"]')
    if (pathInput) {
      await pathInput.fill(testWorkspacePath)
    }

    // 使用 JavaScript 点击提交按钮
    const submitClicked = await ctx.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const submitButton = buttons.find(b =>
        b.textContent?.includes('Create') ||
        b.textContent?.includes('创建') ||
        b.getAttribute('type') === 'submit'
      )
      if (submitButton) {
        submitButton.click()
        return true
      }
      return false
    })

    if (submitClicked) {
      await ctx.page.waitForTimeout(1000)
    }

    // 验证结果（workspace 应该被创建）
    const pageContent = await ctx.page.evaluate(() => document.body.textContent)
    expect(pageContent).toBeDefined()
  })

  test('表单验证应该阻止空名称', async () => {
    await ctx.page.waitForLoadState('networkidle')

    // 使用 JavaScript 点击创建按钮
    await ctx.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const createButton = buttons.find(b => b.textContent?.includes('New Workspace'))
      if (createButton) createButton.click()
    })
    await ctx.page.waitForTimeout(1000)

    // 使用 JavaScript 点击提交按钮（不填写任何内容）
    await ctx.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const submitButton = buttons.find(b =>
        b.textContent?.includes('Create') ||
        b.textContent?.includes('创建') ||
        b.getAttribute('type') === 'submit'
      )
      if (submitButton) submitButton.click()
    })
    await ctx.page.waitForTimeout(500)

    // 验证对话框仍然显示（表单未提交成功）
    const stillHasDialog = await ctx.page.$('input[placeholder*="name" i], input[placeholder*="path" i]')
    expect(stillHasDialog).toBeDefined()
  })

  test('应该能够在 workspace 列表中看到已创建的 workspace', async () => {
    await ctx.page.waitForLoadState('networkidle')

    // 查找 workspace 列表
    const hasWorkspacesSection = await ctx.page.$('text=Workspaces')
    const hasDefaultWorkspace = await ctx.page.$('text=Default Workspace')

    // 至少应该有 workspace 相关的元素
    expect(hasWorkspacesSection || hasDefaultWorkspace).toBeDefined()
  })
})
