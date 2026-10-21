/**
 * E2E UI 测试 - 系统状态与统计
 * 测试系统状态聚合、统计信息和 managed workspace
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'

describe('E2E: 系统状态与统计', () => {
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

  describe('系统状态', () => {
    test('应该能够获取系统状态', async () => {
      const status = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.getSystemStatus.query()
      })

      expect(status).toBeDefined()
      expect(typeof status.agents).toBe('number')
      expect(typeof status.workspaces).toBe('number')
      expect(typeof status.uptime).toBe('number')
    })
  })

  describe('统计信息', () => {
    test('应该能够获取统计信息', async () => {
      const stats = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.getStats.query()
      })

      expect(stats).toBeDefined()
      expect(typeof stats.totalAgents).toBe('number')
      expect(typeof stats.totalConversations).toBe('number')
      expect(typeof stats.totalWorkspaces).toBe('number')
    })

    test('统计信息应该反映 spawn 的 agent 数量', async () => {
      // Spawn 2 agents
      await page.evaluate(async () => {
        await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'claude',
          workspaceId: 'ws-1',
        })
        await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'cursor',
          workspaceId: 'ws-1',
        })
      })

      const stats = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.getStats.query()
      })

      expect(stats.totalAgents).toBeGreaterThanOrEqual(2)
    })
  })

  describe('Managed Workspaces', () => {
    test('应该能够创建 managed workspace', async () => {
      const workspace = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createManagedWorkspace.mutate({
          name: 'test-managed-workspace',
          workDir: '/tmp/test-managed-workspace',
        })
      })

      expect(workspace).toBeDefined()
      expect(workspace.id).toBeDefined()
      expect(workspace.name).toBe('test-managed-workspace')
      expect(workspace.workDir).toBe('/tmp/test-managed-workspace')
    })

    test('创建的 managed workspace 应该出现在列表中', async () => {
      await page.evaluate(async () => {
        await (window as any).trpc.test.ergatai.createManagedWorkspace.mutate({
          name: 'list-test-workspace',
          workDir: '/tmp/list-test-workspace',
        })
      })

      const workspaces = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listManagedWorkspaces.query()
      })

      const names = workspaces.map((w: any) => w.name)
      expect(names).toContain('list-test-workspace')
    })

    test('应该能够通过 ID 获取 managed workspace', async () => {
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createManagedWorkspace.mutate({
          name: 'get-test-workspace',
          workDir: '/tmp/get-test-workspace',
        })
      })

      const workspace = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.ergatai.getManagedWorkspace.query({ id })
      }, created.id)

      expect(workspace).toBeDefined()
      expect(workspace.id).toBe(created.id)
      expect(workspace.name).toBe('get-test-workspace')
    })

    test('应该能够删除 managed workspace', async () => {
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createManagedWorkspace.mutate({
          name: 'delete-test-workspace',
          workDir: '/tmp/delete-test-workspace',
        })
      })

      await page.evaluate(async (workspaceId: string) => {
        await (window as any).trpc.test.ergatai.deleteManagedWorkspaces.mutate({ workspaceId })
      }, created.id)

      const workspaces = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listManagedWorkspaces.query()
      })

      const ids = workspaces.map((w: any) => w.id)
      expect(ids).not.toContain(created.id)
    })
  })

  describe('Ergatai Conversations', () => {
    test('应该能够创建 ergatai conversation', async () => {
      const conversation = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'Test Conversation',
        })
      })

      expect(conversation).toBeDefined()
      expect(conversation.id).toBeDefined()
      expect(conversation.name).toBe('Test Conversation')
    })

    test('创建的 conversation 应该出现在列表中', async () => {
      await page.evaluate(async () => {
        await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'List Test Conversation',
        })
      })

      const conversations = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listConversations.query()
      })

      const names = conversations.map((c: any) => c.name)
      expect(names).toContain('List Test Conversation')
    })

    test('应该能够通过 ID 获取 conversation', async () => {
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'Get Test Conversation',
        })
      })

      const conversation = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.ergatai.getConversation.query({ id })
      }, created.id)

      expect(conversation).toBeDefined()
      expect(conversation.id).toBe(created.id)
    })

    test('应该能够删除 conversation', async () => {
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'Delete Test Conversation',
        })
      })

      await page.evaluate(async (id: string) => {
        await (window as any).trpc.test.ergatai.deleteConversation.mutate({ id })
      }, created.id)

      const conversations = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listConversations.query()
      })

      const ids = conversations.map((c: any) => c.id)
      expect(ids).not.toContain(created.id)
    })
  })
})
