/**
 * IPC 单元测试 - Claude Code Router
 * 测试 claudeCode router 的基本功能
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'

describe('IPC: Claude Code Router', () => {
  const ctx = createTestContext()

  describe('claudeCode.hasExistingCliConfig', () => {
    test('应该返回配置对象', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.claudeCode.hasExistingCliConfig.query()
      })

      expect(typeof result).toBe('object')
      expect(result).toHaveProperty('hasConfig')
      expect(typeof result.hasConfig).toBe('boolean')
    })
  })

  describe('claudeCode.getIntegration', () => {
    test('应该返回集成状态', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.claudeCode.getIntegration.query()
      })

      expect(result).toBeDefined()
    })
  })

  describe('claudeCode.getSystemToken', () => {
    test('应该返回 token 对象', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.claudeCode.getSystemToken.query()
      })

      // 返回对象 { token: string | null }
      expect(typeof result).toBe('object')
      expect(result).toHaveProperty('token')
      expect(result.token === null || typeof result.token === 'string').toBe(true)
    })
  })

  describe('claudeCode.getToken', () => {
    test('应该返回 token 对象', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.claudeCode.getToken.query()
      })

      // 返回对象 { token: string | null }
      expect(typeof result).toBe('object')
      expect(result).toHaveProperty('token')
      expect(result.token === null || typeof result.token === 'string').toBe(true)
    })
  })
})
