/**
 * IPC 单元测试 - Plugins Router
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'

describe('IPC: Plugins Router', () => {
  const ctx = createTestContext()

  describe('plugins.list', () => {
    test('应该返回插件数组', async () => {
      const plugins = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.plugins.list.query()
      })

      expect(Array.isArray(plugins)).toBe(true)

      // 每个插件应该有必要的字段
      for (const plugin of plugins) {
        expect(typeof plugin.name).toBe('string')
        expect(typeof plugin.version).toBe('string')
        expect(typeof plugin.path).toBe('string')
        expect(typeof plugin.source).toBe('string')
        expect(typeof plugin.marketplace).toBe('string')
        expect(typeof plugin.isDisabled).toBe('boolean')
        expect(plugin.components).toBeDefined()
        expect(Array.isArray(plugin.components.commands)).toBe(true)
        expect(Array.isArray(plugin.components.skills)).toBe(true)
        expect(Array.isArray(plugin.components.agents)).toBe(true)
        expect(Array.isArray(plugin.components.mcpServers)).toBe(true)
      }
    })
  })

  describe('plugins.clearCache', () => {
    test('应该成功清除缓存', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.plugins.clearCache.mutate()
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })

    test('清除缓存后 list 应该重新扫描', async () => {
      // 先清除缓存
      await ctx.page.evaluate(async () => {
        await (window as any).trpc.plugins.clearCache.mutate()
      })

      // 再次列出插件
      const plugins = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.plugins.list.query()
      })

      expect(Array.isArray(plugins)).toBe(true)
    })
  })
})
