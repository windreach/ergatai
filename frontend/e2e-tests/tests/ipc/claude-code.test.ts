/**
 * IPC 单元测试 - Claude Code Router
 * 测试 claudeCode router 的基本功能
 */

import { test, expect, describe, beforeAll, afterAll } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'

describe('IPC: Claude Code Router', () => {
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

  describe('claudeCode.hasExistingCliConfig', () => {
    test('应该返回配置对象', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.claudeCode.hasExistingCliConfig.query()
      })

      expect(typeof result).toBe('object')
      expect(result).toHaveProperty('hasConfig')
      expect(typeof result.hasConfig).toBe('boolean')
    })
  })

  describe('claudeCode.getIntegration', () => {
    test('应该返回集成状态', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.claudeCode.getIntegration.query()
      })

      expect(result).toBeDefined()
    })
  })

  describe('claudeCode.getSystemToken', () => {
    test('应该返回 token 对象', async () => {
      const result = await page.evaluate(async () => {
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
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.claudeCode.getToken.query()
      })

      // 返回对象 { token: string | null }
      expect(typeof result).toBe('object')
      expect(result).toHaveProperty('token')
      expect(result.token === null || typeof result.token === 'string').toBe(true)
    })
  })
})
