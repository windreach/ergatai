/**
 * E2E UI 测试 - 对话流程（简化版）
 * 测试核心对话交互：创建、列表、归档、删除
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'
import * as fs from 'fs/promises'

describe('E2E: 对话流程', () => {
  let electron: any
  let page: any
  let testWorkspaceId: string
  const testWorkspacePath = '/tmp/ergatai-conversation-test'

  beforeAll(async () => {
    electron = await launchElectron({
      extraEnv: { NODE_ENV: 'test', ELECTRON_TEST_MODE: 'true' },
    })
    page = electron.page

    await fs.mkdir(testWorkspacePath, { recursive: true })

    const workspace = await page.evaluate(async (workspacePath: string) => {
      return await (window as any).trpc.test.projects.create.mutate({
        name: 'test-conversation-workspace',
        path: workspacePath,
      })
    }, testWorkspacePath)
    testWorkspaceId = workspace.id

    process.on('exit', async () => {
      if (electron) { try { await electron.close() } catch (e) { /* ignore */ } }
    })
  })

  afterAll(async () => {
    await page.evaluate(async () => {
      await (window as any).trpc.test.helpers.cleanup.mutate()
    })
    await fs.rm(testWorkspacePath, { recursive: true, force: true }).catch(() => {})
    await electron.close()
  })

  beforeEach(async () => {
    await page.evaluate(async () => {
      await (window as any).trpc.test.helpers.cleanup.mutate()
    })
  })

  describe('对话创建', () => {
    test('应该能够通过 IPC 创建新对话', async () => {
      const conversation = await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.chats.create.mutate({
          name: 'test-conversation',
          projectId: params.workspaceId,
        })
      }, { workspaceId: testWorkspaceId })

      expect(conversation).toBeDefined()
      expect(conversation.id).toMatch(/^chat-/)
      expect(conversation.name).toBe('test-conversation')
    })

    test('创建的对话应该出现在对话列表中', async () => {
      await page.evaluate(async (params: any) => {
        await (window as any).trpc.test.chats.create.mutate({
          name: 'list-test-conversation',
          projectId: params.workspaceId,
        })
      }, { workspaceId: testWorkspaceId })

      const conversations = await page.evaluate(async () => {
        return await (window as any).trpc.test.chats.list.query()
      })

      const names = conversations.map((c: any) => c.name)
      expect(names).toContain('list-test-conversation')
    })
  })

  describe('对话归档', () => {
    test('应该能够归档对话', async () => {
      const conversation = await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.chats.create.mutate({
          name: 'archive-test',
          projectId: params.workspaceId,
        })
      }, { workspaceId: testWorkspaceId })

      await page.evaluate(async (id: string) => {
        await (window as any).trpc.test.chats.archive.mutate({ id })
      }, conversation.id)

      // 获取单个对话验证
      const archivedConversation = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.chats.get.query({ id })
      }, conversation.id)

      expect(archivedConversation).toBeDefined()
      expect(archivedConversation.archivedAt).toBeDefined()
    })
  })

  describe('对话删除', () => {
    test('应该能够删除对话', async () => {
      const conversation = await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.chats.create.mutate({
          name: 'delete-test',
          projectId: params.workspaceId,
        })
      }, { workspaceId: testWorkspaceId })

      await page.evaluate(async (id: string) => {
        await (window as any).trpc.test.chats.delete.mutate({ id })
      }, conversation.id)

      const conversations = await page.evaluate(async () => {
        return await (window as any).trpc.test.chats.list.query()
      })

      const ids = conversations.map((c: any) => c.id)
      expect(ids).not.toContain(conversation.id)
    })
  })
})
