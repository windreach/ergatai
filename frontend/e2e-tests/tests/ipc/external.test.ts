/**
 * IPC 单元测试 - External Router
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'

describe('IPC: External Router', () => {
  const ctx = createTestContext()

  describe('external.copyPath', () => {
    test('应该复制路径到剪贴板', async () => {
      const testPath = '/tmp/test-file.txt'

      const result = await ctx.page.evaluate(async (p: string) => {
        return await (window as any).trpc.external.copyPath.mutate(p)
      }, testPath)

      expect(result).toBeDefined()
      expect(result.success).toBe(true)

      // 验证剪贴板内容
      const clipboardContent = await ctx.page.evaluate(async () => {
        return await (window as any).desktopApi.clipboardRead()
      })
      expect(clipboardContent).toBe(testPath)
    })

    test('应该支持 ~ 路径展开', async () => {
      const testPath = '~/test-file.txt'

      const result = await ctx.page.evaluate(async (p: string) => {
        return await (window as any).trpc.external.copyPath.mutate(p)
      }, testPath)

      expect(result.success).toBe(true)

      // 验证剪贴板内容是展开后的路径
      const clipboardContent = await ctx.page.evaluate(async () => {
        return await (window as any).desktopApi.clipboardRead()
      })
      expect(clipboardContent).toBe(testPath)
    })
  })

  describe('external.openInFinder', () => {
    test('应该成功调用（打开文件管理器）', async () => {
      const testPath = '/tmp'

      const result = await ctx.page.evaluate(async (p: string) => {
        return await (window as any).trpc.external.openInFinder.mutate(p)
      }, testPath)

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })

    test('应该支持 ~ 路径', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.external.openInFinder.mutate('~')
      })

      expect(result.success).toBe(true)
    })
  })

  describe('external.openInApp', () => {
    test('应该成功调用 finder', async () => {
      const result = await ctx.page.evaluate(async () => {
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

      const result = await ctx.page.evaluate(async (p: string) => {
        return await (window as any).trpc.external.openFileInEditor.mutate({
          path: p,
        })
      }, testPath)

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(typeof result.editor).toBe('string')
    })

    test('应该支持可选的 cwd 参数', async () => {
      const result = await ctx.page.evaluate(async () => {
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

      const result = await ctx.page.evaluate(async (u: string) => {
        return await (window as any).trpc.external.openExternal.mutate(u)
      }, testUrl)

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })

    test('无效 URL 应该报错', async () => {
      await expect(
        ctx.page.evaluate(async () => {
          return await (window as any).trpc.external.openExternal.mutate('not-a-valid-url')
        })
      ).rejects.toThrow()
    })
  })
})
