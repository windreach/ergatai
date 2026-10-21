/**
 * IPC 单元测试 - Workspace 管理
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'

describe('IPC: Workspace 管理', () => {
  const ctx = createTestContext()

  describe('test.workspaces', () => {
    test('创建 workspace', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.workspaces.create.mutate({
          name: 'test-ws-1',
          workDir: '/tmp/test-ws-1',
        })
      })

      expect(result).toBeDefined()
      expect(result.name).toBe('test-ws-1')
      expect(result.workDir).toBe('/tmp/test-ws-1')
      expect(result.id).toMatch(/^ws-/)
    })

    test('列出 workspace', async () => {
      await ctx.page.evaluate(async () => {
        await (window as any).trpc.test.workspaces.create.mutate({ name: 'test-ws-1', workDir: '/tmp/ws1' })
        await (window as any).trpc.test.workspaces.create.mutate({ name: 'test-ws-2', workDir: '/tmp/ws2' })
      })

      const workspaces = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.workspaces.list.query()
      })

      expect(workspaces.length).toBeGreaterThanOrEqual(2)
    })

    test('获取单个 workspace', async () => {
      const created = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.workspaces.create.mutate({
          name: 'test-ws-get',
          workDir: '/tmp/ws-get',
        })
      })

      const workspace = await ctx.page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.workspaces.get.query({ id })
      }, created.id)

      expect(workspace.name).toBe('test-ws-get')
      expect(workspace.id).toBe(created.id)
    })

    test('删除 workspace', async () => {
      const created = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.workspaces.create.mutate({
          name: 'test-ws-del',
          workDir: '/tmp/ws-del',
        })
      })

      await ctx.page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.workspaces.delete.mutate({ id })
      }, created.id)

      const workspaces = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.workspaces.list.query()
      })

      expect(workspaces.map((w: any) => w.id)).not.toContain(created.id)
    })

    test('获取不存在的 workspace 应报错', async () => {
      await expect(
        ctx.page.evaluate(async () => {
          return await (window as any).trpc.test.workspaces.get.query({ id: 'non-existent' })
        })
      ).rejects.toThrow('Workspace not found')
    })

    test('缺少必填字段应报错', async () => {
      await expect(
        ctx.page.evaluate(async () => {
          return await (window as any).trpc.test.workspaces.create.mutate({ name: '', workDir: '/tmp/x' })
        })
      ).rejects.toThrow()

      await expect(
        ctx.page.evaluate(async () => {
          return await (window as any).trpc.test.workspaces.create.mutate({ name: 'test-ws', workDir: '' })
        })
      ).rejects.toThrow()
    })
  })
})
