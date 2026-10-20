/**
 * IPC 单元测试 - Plugins Router
 */

import { test, expect, describe, beforeAll, afterAll } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'

describe('IPC: Plugins Router', () => {
  let electron: any
  let page: any

  beforeAll(async () => {
    electron = await launchElectron({
      extraEnv: { NODE_ENV: 'test', ELECTRON_TEST_MODE: 'true' },
    })
    page = electron.page

    process.on('exit', async () => {
      if (electron) { try { await electron.close() } catch (e) { /* ignore */ } }
    })
    process.on('SIGINT', async () => {
      if (electron) { await electron.close() }
      process.exit(130)
    })
  })

  afterAll(async () => {
    await electron.close()
  })

  describe('plugins.list', () => {
    test('应该返回插件数组', async () => {
      const plugins = await page.evaluate(async () => {
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
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.plugins.clearCache.mutate()
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })

    test('清除缓存后 list 应该重新扫描', async () => {
      // 先清除缓存
      await page.evaluate(async () => {
        await (window as any).trpc.plugins.clearCache.mutate()
      })

      // 再次列出插件
      const plugins = await page.evaluate(async () => {
        return await (window as any).trpc.plugins.list.query()
      })

      expect(Array.isArray(plugins)).toBe(true)
    })
  })
})
