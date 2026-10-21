/**
 * IPC 单元测试 - Debug Router
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'

describe('IPC: Debug Router', () => {
  const ctx = createTestContext()

  describe('debug.getSystemInfo', () => {
    test('应该返回系统信息', async () => {
      const info = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.debug.getSystemInfo.query()
      })

      expect(info).toBeDefined()
      expect(typeof info.version).toBe('string')
      expect(typeof info.platform).toBe('string')
      expect(typeof info.arch).toBe('string')
      expect(typeof info.isDev).toBe('boolean')
      expect(typeof info.userDataPath).toBe('string')
      expect(typeof info.protocolRegistered).toBe('boolean')
      expect(['linux', 'darwin', 'win32']).toContain(info.platform)
    })
  })

  describe('debug.getDbStats', () => {
    test.skip('应该返回数据库统计信息', async () => {
      // 跳过：需要真实的 ergatai API 服务器
    })
  })

  describe('debug.clearChats', () => {
    test.skip('应该成功清除所有聊天', async () => {
      // 跳过：需要真实的 ergatai API 服务器
    })
  })

  describe('debug.clearAllData', () => {
    test.skip('应该成功清除所有数据', async () => {
      // 跳过：需要真实的 ergatai API 服务器
    })
  })

  describe('debug.logout', () => {
    test('应该成功登出', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.debug.logout.mutate()
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })
  })

  describe('debug.openUserDataFolder', () => {
    test('应该成功打开用户数据文件夹', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.debug.openUserDataFolder.mutate()
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })
  })

  describe('debug.offlineSimulation', () => {
    test('getOfflineSimulation 应该返回状态', async () => {
      const status = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.debug.getOfflineSimulation.query()
      })

      expect(status).toBeDefined()
      expect(typeof status.enabled).toBe('boolean')
    })

    test('setOfflineSimulation 应该设置状态', async () => {
      // 启用离线模拟
      const enableResult = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.debug.setOfflineSimulation.mutate({ enabled: true })
      })

      expect(enableResult.success).toBe(true)
      expect(enableResult.enabled).toBe(true)

      // 验证状态已更改
      const status = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.debug.getOfflineSimulation.query()
      })
      expect(status.enabled).toBe(true)

      // 禁用离线模拟
      const disableResult = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.debug.setOfflineSimulation.mutate({ enabled: false })
      })

      expect(disableResult.success).toBe(true)
      expect(disableResult.enabled).toBe(false)

      // 验证状态已恢复
      const finalStatus = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.debug.getOfflineSimulation.query()
      })
      expect(finalStatus.enabled).toBe(false)
    })
  })
})
