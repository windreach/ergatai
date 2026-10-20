/**
 * IPC 单元测试 - 对话管理
 * 通过 test router 直接测试业务逻辑（不依赖 UI）
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'

describe('IPC: 对话管理', () => {
  let electron: any
  let page: any

  beforeAll(async () => {
    electron = await launchElectron({
      extraEnv: {
        NODE_ENV: 'test',
        ELECTRON_TEST_MODE: 'true',
      },
    })
    page = electron.page

    process.on('exit', async () => {
      if (electron) {
        try { await electron.close() } catch (e) { /* ignore */ }
      }
    })

    process.on('SIGINT', async () => {
      if (electron) { await electron.close() }
      process.exit(130)
    })
  })

  afterAll(async () => {
    await page.evaluate(async () => {
      await (window as any).trpc.test.helpers.cleanup.mutate()
    })
    await electron.close()
  })

  beforeEach(async () => {
    await page.evaluate(async () => {
      await (window as any).trpc.test.helpers.cleanup.mutate()
    })
  })

  describe('test.chats', () => {
    test('创建对话', async () => {
      const result = await page.evaluate(async () => {
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
      await page.evaluate(async () => {
        await (window as any).trpc.test.chats.create.mutate({ name: 'test-chat-1', projectId: 'project-1' })
        await (window as any).trpc.test.chats.create.mutate({ name: 'test-chat-2', projectId: 'project-1' })
        await (window as any).trpc.test.chats.create.mutate({ name: 'test-chat-3', projectId: 'project-2' })
      })

      const allChats = await page.evaluate(async () => {
        return await (window as any).trpc.test.chats.list.query()
      })

      expect(allChats.length).toBeGreaterThanOrEqual(3)

      const project1Chats = await page.evaluate(async () => {
        return await (window as any).trpc.test.chats.list.query({ projectId: 'project-1' })
      })

      expect(project1Chats.length).toBe(2)
      expect(project1Chats.every((c: any) => c.projectId === 'project-1')).toBe(true)
    })

    test('获取单个对话', async () => {
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.test.chats.create.mutate({
          name: 'test-chat-get',
          projectId: 'test-project-get',
        })
      })

      const chat = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.chats.get.query({ id })
      }, created.id)

      expect(chat.name).toBe('test-chat-get')
      expect(chat.id).toBe(created.id)
    })

    test('归档对话', async () => {
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.test.chats.create.mutate({
          name: 'test-chat-archive',
          projectId: 'test-project-archive',
        })
      })

      await page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.chats.archive.mutate({ id })
      }, created.id)

      const chat = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.chats.get.query({ id })
      }, created.id)

      expect(chat.archivedAt).toBeDefined()
    })

    test('删除对话', async () => {
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.test.chats.create.mutate({
          name: 'test-chat-delete',
          projectId: 'test-project-delete',
        })
      })

      await page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.chats.delete.mutate({ id })
      }, created.id)

      const chats = await page.evaluate(async () => {
        return await (window as any).trpc.test.chats.list.query()
      })

      expect(chats.map((c: any) => c.id)).not.toContain(created.id)
    })

    test('缺少必填字段应报错', async () => {
      await expect(
        page.evaluate(async () => {
          return await (window as any).trpc.test.chats.create.mutate({ name: '', projectId: 'p1' })
        })
      ).rejects.toThrow()

      await expect(
        page.evaluate(async () => {
          return await (window as any).trpc.test.chats.create.mutate({ name: 'test-chat', projectId: '' })
        })
      ).rejects.toThrow()
    })
  })
})
