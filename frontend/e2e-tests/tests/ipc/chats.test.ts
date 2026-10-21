/**
 * IPC 单元测试 - 对话管理
 * 通过 test router 直接测试业务逻辑（不依赖 UI）
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'

describe('IPC: 对话管理', () => {
  const ctx = createTestContext()

  describe('test.chats', () => {
    test('创建对话', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.chats.create.mutate({
          name: 'test-chat-1',
          projectId: 'test-project-1',
        })
      })

      expect(result).toBeDefined()
      expect(result.name).toBe('test-chat-1')
      expect(result.projectId).toBe('test-project-1')
      expect(result.id).toMatch(/^chat-/)
    })

    test('列出对话（含项目过滤）', async () => {
      await ctx.page.evaluate(async () => {
        await (window as any).trpc.test.chats.create.mutate({ name: 'test-chat-1', projectId: 'project-1' })
        await (window as any).trpc.test.chats.create.mutate({ name: 'test-chat-2', projectId: 'project-1' })
        await (window as any).trpc.test.chats.create.mutate({ name: 'test-chat-3', projectId: 'project-2' })
      })

      const allChats = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.chats.list.query()
      })

      expect(allChats.length).toBeGreaterThanOrEqual(3)

      const project1Chats = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.chats.list.query({ projectId: 'project-1' })
      })

      expect(project1Chats.length).toBe(2)
      expect(project1Chats.every((c: any) => c.projectId === 'project-1')).toBe(true)
    })

    test('获取单个对话', async () => {
      const created = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.chats.create.mutate({
          name: 'test-chat-get',
          projectId: 'test-project-get',
        })
      })

      const chat = await ctx.page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.chats.get.query({ id })
      }, created.id)

      expect(chat.name).toBe('test-chat-get')
      expect(chat.id).toBe(created.id)
    })

    test('归档对话', async () => {
      const created = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.chats.create.mutate({
          name: 'test-chat-archive',
          projectId: 'test-project-archive',
        })
      })

      await ctx.page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.chats.archive.mutate({ id })
      }, created.id)

      const chat = await ctx.page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.chats.get.query({ id })
      }, created.id)

      expect(chat.archivedAt).toBeDefined()
    })

    test('删除对话', async () => {
      const created = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.chats.create.mutate({
          name: 'test-chat-delete',
          projectId: 'test-project-delete',
        })
      })

      await ctx.page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.chats.delete.mutate({ id })
      }, created.id)

      const chats = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.chats.list.query()
      })

      expect(chats.map((c: any) => c.id)).not.toContain(created.id)
    })

    test('缺少必填字段应报错', async () => {
      await expect(
        ctx.page.evaluate(async () => {
          return await (window as any).trpc.test.chats.create.mutate({ name: '', projectId: 'p1' })
        })
      ).rejects.toThrow()

      await expect(
        ctx.page.evaluate(async () => {
          return await (window as any).trpc.test.chats.create.mutate({ name: 'test-chat', projectId: '' })
        })
      ).rejects.toThrow()
    })
  })
})
