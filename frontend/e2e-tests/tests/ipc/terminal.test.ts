/**
 * IPC 单元测试 - Terminal Router
 * 注意：createOrAttach、write、resize 等需要真实 PTY，使用 test.skip()
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'

describe('IPC: Terminal Router', () => {
  const ctx = createTestContext()

  describe('terminal.getActiveSessionCount', () => {
    test('应该返回数字', async () => {
      const count = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.terminal.getActiveSessionCount.query({ workspaceId: 'test-workspace' })
      })

      expect(typeof count).toBe('number')
      expect(count).toBeGreaterThanOrEqual(0)
    })
  })

  describe('terminal.listSessionsByScopeKey', () => {
    test('应该返回数组', async () => {
      const sessions = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.terminal.listSessionsByScopeKey.query({
          scopeKey: 'test',
        })
      })

      expect(Array.isArray(sessions)).toBe(true)
    })
  })

  describe('terminal.getWorkspaceCwd', () => {
    test('应该返回 null（当前实现）', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.terminal.getWorkspaceCwd.query('test-workspace')
      })

      // 当前实现总是返回 null
      expect(result).toBeNull()
    })
  })

  describe('terminal.createOrAttach', () => {
    test('应该创建新的 PTY session', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.terminal.createOrAttach.mutate({
          paneId: 'test-pane-pty-1',
          cols: 80,
          rows: 24,
          cwd: '/tmp',
        })
      })

      expect(result).toBeDefined()
      expect(result.paneId).toBe('test-pane-pty-1')
      expect(result.isNew).toBe(true)
      expect(result.serializedState).toBeDefined()
    })
  })

  describe('terminal.write', () => {
    test('应该向 PTY 写入数据', async () => {
      // 先创建 session
      await ctx.page.evaluate(async () => {
        return await (window as any).trpc.terminal.createOrAttach.mutate({
          paneId: 'test-pane-pty-2',
          cols: 80,
          rows: 24,
          cwd: '/tmp',
        })
      })

      // 写入命令 - 不应抛出错误
      await expect(ctx.page.evaluate(async () => {
        await (window as any).trpc.terminal.write.mutate({
          paneId: 'test-pane-pty-2',
          data: 'echo "hello"\n',
        })
      })).resolves.not.toThrow()
    })
  })

  describe('terminal.resize', () => {
    test('应该调整 PTY 大小', async () => {
      // 先创建 session
      await ctx.page.evaluate(async () => {
        return await (window as any).trpc.terminal.createOrAttach.mutate({
          paneId: 'test-pane-pty-3',
          cols: 80,
          rows: 24,
          cwd: '/tmp',
        })
      })

      // 调整大小 - 不应抛出错误
      await expect(ctx.page.evaluate(async () => {
        await (window as any).trpc.terminal.resize.mutate({
          paneId: 'test-pane-pty-3',
          cols: 120,
          rows: 40,
        })
      })).resolves.not.toThrow()
    })
  })

  describe('terminal.kill', () => {
    test('应该终止 PTY session', async () => {
      // 先创建 session
      await ctx.page.evaluate(async () => {
        return await (window as any).trpc.terminal.createOrAttach.mutate({
          paneId: 'test-pane-pty-4',
          cols: 80,
          rows: 24,
          cwd: '/tmp',
        })
      })

      // 终止 session - 不应抛出错误
      await expect(ctx.page.evaluate(async () => {
        await (window as any).trpc.terminal.kill.mutate({
          paneId: 'test-pane-pty-4',
        })
      })).resolves.not.toThrow()
    })
  })

  describe('terminal.listDirectory', () => {
    test('应该返回目录列表对象', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.terminal.listDirectory.query({
          dirPath: '/tmp',
        })
      })

      expect(result).toBeDefined()
      expect(typeof result).toBe('object')
      // 返回对象含有 currentPath, parentPath, items, error
      expect(result).toHaveProperty('currentPath')
      expect(result).toHaveProperty('items')
      expect(Array.isArray(result.items)).toBe(true)
    })
  })
})
