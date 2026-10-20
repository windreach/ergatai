/**
 * IPC 测试 - Chats Router (真实实现)
 * 测试真实的 chats router，通过 window.trpc.chats.* 调用后端 API
 * 需要后端运行在 http://localhost:3000
 */

import { test, expect, describe, beforeAll, afterAll } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'

describe('IPC: Chats Router (Real Backend)', () => {
  let electron: any
  let page: any

  beforeAll(async () => {
    electron = await launchElectron({
      extraEnv: {
        NODE_ENV: 'test',
        ELECTRON_TEST_MODE: 'true',
        ERGATAI_API_URL: 'http://localhost:3000'
      },
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

  describe('Chat 管理', () => {
    test('list 应该返回数组', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.chats.list.query({})
      })
      expect(Array.isArray(result)).toBe(true)
    })

    test('listArchived 应该返回数组', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.chats.listArchived.query({})
      })
      expect(Array.isArray(result)).toBe(true)
    })

    test('create 应该创建新 chat', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.chats.create.mutate({
          projectId: 'test-project',
          name: 'Test Chat',
          useWorktree: false,
        })
      })

      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      expect(result.id).toMatch(/^chat_/)
    })

    test('get 应该获取 chat 详情', async () => {
      // 先创建 chat
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.chats.create.mutate({
          projectId: 'test-project',
          name: 'Test Chat Get',
          useWorktree: false,
        })
      })

      const result = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.chats.get.query({ id })
      }, created.id)

      expect(result).toBeDefined()
      expect(result.id).toBe(created.id)
      expect(result.conversations).toBeDefined()
    })

    test('archive 应该归档 chat', async () => {
      // 先创建 chat
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.chats.create.mutate({
          projectId: 'test-project',
          name: 'Test Chat Archive',
          useWorktree: false,
        })
      })

      const result = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.chats.archive.mutate({ id })
      }, created.id)

      expect(result).toBeDefined()
      expect(result.id).toBe(created.id)
      expect(result.archivedAt).toBeDefined()
    })

    test('delete 应该删除 chat', async () => {
      // 先创建 chat
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.chats.create.mutate({
          projectId: 'test-project',
          name: 'Test Chat Delete',
          useWorktree: false,
        })
      })

      await expect(page.evaluate(async (id: string) => {
        await (window as any).trpc.chats.delete.mutate({ id })
      }, created.id)).resolves.not.toThrow()
    })
  })

  describe('Conversation 管理', () => {
    test('createConversation 应该创建对话', async () => {
      // 先创建 chat
      const chat = await page.evaluate(async () => {
        return await (window as any).trpc.chats.create.mutate({
          projectId: 'test-project',
          name: 'Test Chat Conv',
          useWorktree: false,
        })
      })

      const result = await page.evaluate(async (chatId: string) => {
        return await (window as any).trpc.chats.createConversation.mutate({
          chatId,
          name: 'Test Conversation',
        })
      }, chat.id)

      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      expect(result.chatId).toBe(chat.id)
    })

    test('getConversation 应该获取对话', async () => {
      // 先创建 chat 和 conversation
      const chat = await page.evaluate(async () => {
        return await (window as any).trpc.chats.create.mutate({
          projectId: 'test-project',
          name: 'Test Chat Conv Get',
          useWorktree: false,
        })
      })

      const conv = await page.evaluate(async (chatId: string) => {
        return await (window as any).trpc.chats.createConversation.mutate({
          chatId,
          name: 'Test Conversation Get',
        })
      }, chat.id)

      const result = await page.evaluate(async (conversationId: string) => {
        return await (window as any).trpc.chats.getConversation.query({ conversationId })
      }, conv.id)

      expect(result).toBeDefined()
      expect(result.id).toBe(conv.id)
    })

    test('deleteConversation 应该删除对话', async () => {
      // 先创建 chat 和 conversation
      const chat = await page.evaluate(async () => {
        return await (window as any).trpc.chats.create.mutate({
          projectId: 'test-project',
          name: 'Test Chat Conv Delete',
          useWorktree: false,
        })
      })

      const conv = await page.evaluate(async (chatId: string) => {
        return await (window as any).trpc.chats.createConversation.mutate({
          chatId,
          name: 'Test Conversation Delete',
        })
      }, chat.id)

      await expect(page.evaluate(async (conversationId: string) => {
        await (window as any).trpc.chats.deleteConversation.mutate({ conversationId })
      }, conv.id)).resolves.not.toThrow()
    })
  })

  describe('Git/Diff 操作', () => {
    test('getDiff 应该返回 diff 内容', async () => {
      // 先创建 chat
      const chat = await page.evaluate(async () => {
        return await (window as any).trpc.chats.create.mutate({
          projectId: 'test-project',
          name: 'Test Chat Diff',
          useWorktree: false,
        })
      })

      const result = await page.evaluate(async (chatId: string) => {
        return await (window as any).trpc.chats.getDiff.query({ chatId })
      }, chat.id)

      expect(result).toBeDefined()
      // diff 可能是空的，但应该返回字符串
      expect(typeof result).toBe('string')
    })

    test('getFileStats 应该返回文件统计', async () => {
      // 先创建 chat
      const chat = await page.evaluate(async () => {
        return await (window as any).trpc.chats.create.mutate({
          projectId: 'test-project',
          name: 'Test Chat Stats',
          useWorktree: false,
        })
      })

      const result = await page.evaluate(async (chatId: string) => {
        return await (window as any).trpc.chats.getFileStats.query({ chatId })
      }, chat.id)

      expect(result).toBeDefined()
      expect(typeof result).toBe('object')
    })
  })

  describe('PR 操作', () => {
    test('getPrStatus 应该返回 PR 状态', async () => {
      // 先创建 chat
      const chat = await page.evaluate(async () => {
        return await (window as any).trpc.chats.create.mutate({
          projectId: 'test-project',
          name: 'Test Chat PR',
          useWorktree: false,
        })
      })

      const result = await page.evaluate(async (chatId: string) => {
        return await (window as any).trpc.chats.getPrStatus.query({ chatId })
      }, chat.id)

      expect(result).toBeDefined()
      // PR 状态可能为 null（没有 PR），但应该返回对象或 null
      if (result) {
        expect(typeof result).toBe('object')
      } else {
        expect(result).toBeNull()
      }
    })
  })

  describe('导出和统计', () => {
    test('getChatStats 应该返回统计信息', async () => {
      // 先创建 chat
      const chat = await page.evaluate(async () => {
        return await (window as any).trpc.chats.create.mutate({
          projectId: 'test-project',
          name: 'Test Chat Stats',
          useWorktree: false,
        })
      })

      const result = await page.evaluate(async (chatId: string) => {
        return await (window as any).trpc.chats.getChatStats.query({ chatId })
      }, chat.id)

      expect(result).toBeDefined()
      expect(typeof result).toBe('object')
    })
  })
})
