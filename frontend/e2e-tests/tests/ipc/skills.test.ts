/**
 * IPC 单元测试 - Skills Router
 */

import { test, expect, describe, beforeAll, afterAll } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'

describe('IPC: Skills Router', () => {
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

  describe('skills.list', () => {
    test('应该返回空数组', async () => {
      const skills = await page.evaluate(async () => {
        return await (window as any).trpc.skills.list.query()
      })

      expect(Array.isArray(skills)).toBe(true)
      expect(skills.length).toBe(0)
    })

    test('接受可选的 cwd 参数', async () => {
      const skills = await page.evaluate(async () => {
        return await (window as any).trpc.skills.list.query({ cwd: '/tmp' })
      })

      expect(Array.isArray(skills)).toBe(true)
      expect(skills.length).toBe(0)
    })
  })

  describe('skills.listEnabled', () => {
    test('应该返回空数组', async () => {
      const skills = await page.evaluate(async () => {
        return await (window as any).trpc.skills.listEnabled.query()
      })

      expect(Array.isArray(skills)).toBe(true)
      expect(skills.length).toBe(0)
    })

    test('接受可选的 cwd 参数', async () => {
      const skills = await page.evaluate(async () => {
        return await (window as any).trpc.skills.listEnabled.query({ cwd: '/tmp' })
      })

      expect(Array.isArray(skills)).toBe(true)
      expect(skills.length).toBe(0)
    })
  })
})
