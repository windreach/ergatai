/**
 * IPC 单元测试 - External Router
 */

import { test, expect, describe, beforeAll, afterAll } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'

describe('IPC: External Router', () => {
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

  describe('external.copyPath', () => {
    test('应该复制路径到剪贴板', async () => {
      const testPath = '/tmp/test-file.txt'

      const result = await page.evaluate(async (p: string) => {
        return await (window as any).trpc.external.copyPath.mutate(p)
      }, testPath)

      expect(result).toBeDefined()
      expect(result.success).toBe(true)

      // 验证剪贴板内容
      const clipboardContent = await page.evaluate(async () => {
        return await (window as any).desktopApi.clipboardRead()
      })
      expect(clipboardContent).toBe(testPath)
    })

    test('应该支持 ~ 路径展开', async () => {
      const testPath = '~/test-file.txt'

      const result = await page.evaluate(async (p: string) => {
        return await (window as any).trpc.external.copyPath.mutate(p)
      }, testPath)

      expect(result.success).toBe(true)

      // 验证剪贴板内容是展开后的路径
      const clipboardContent = await page.evaluate(async () => {
        return await (window as any).desktopApi.clipboardRead()
      })
      expect(clipboardContent).toBe(testPath)
    })
  })

  describe('external.openInFinder', () => {
    test('应该成功调用（打开文件管理器）', async () => {
      const testPath = '/tmp'

      const result = await page.evaluate(async (p: string) => {
        return await (window as any).trpc.external.openInFinder.mutate(p)
      }, testPath)

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })

    test('应该支持 ~ 路径', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.external.openInFinder.mutate('~')
      })

      expect(result.success).toBe(true)
    })
  })

  describe('external.openInApp', () => {
    test('应该成功调用 finder', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.external.openInApp.mutate({
          path: '/tmp',
          app: 'finder',
        })
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })
  })

  describe('external.openFileInEditor', () => {
    test('应该成功打开文件（使用可用编辑器）', async () => {
      const testPath = '/tmp/test.txt'

      const result = await page.evaluate(async (p: string) => {
        return await (window as any).trpc.external.openFileInEditor.mutate({
          path: p,
        })
      }, testPath)

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(typeof result.editor).toBe('string')
    })

    test('应该支持可选的 cwd 参数', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.external.openFileInEditor.mutate({
          path: '/tmp/test.txt',
          cwd: '/tmp',
        })
      })

      expect(result.success).toBe(true)
    })
  })

  describe('external.openExternal', () => {
    test('应该成功打开有效 URL', async () => {
      const testUrl = 'https://example.com'

      const result = await page.evaluate(async (u: string) => {
        return await (window as any).trpc.external.openExternal.mutate(u)
      }, testUrl)

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })

    test('无效 URL 应该报错', async () => {
      await expect(
        page.evaluate(async () => {
          return await (window as any).trpc.external.openExternal.mutate('not-a-valid-url')
        })
      ).rejects.toThrow()
    })
  })
})
