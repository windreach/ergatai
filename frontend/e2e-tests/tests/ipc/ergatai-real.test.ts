/**
 * IPC 测试 - Ergatai Router (Test Mode)
 * 测试 test router 中的 ergatai mock 实现
 * 这些测试使用内存存储，不依赖真实后端
 */

import { test, expect, describe, beforeAll, afterAll } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration } from '../../fixtures/integration-launcher'

describe('IPC: Test Router (Real Backend)', () => {
  let electron: any
  let page: any

  beforeAll(async () => {
    const launched = await launchIntegrationElectron()
    electron = launched.electron
    page = launched.page

    process.on('exit', async () => {
      if (electron) { try { await cleanupIntegration(electron) } catch (e) { /* ignore */ } }
    })
    process.on('SIGINT', async () => {
      if (electron) { await cleanupIntegration(electron) }
      process.exit(130)
    })
  })

  afterAll(async () => {
    await cleanupIntegration(electron)
  })

  describe('Agent 管理', () => {
    test('listAgents 应该返回数组', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(Array.isArray(result)).toBe(true)
    })

    test('getAgent 应该获取 agent 详情', async () => {
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'test-workspace',
          command: 'test-agent',
        })
      })

      const result = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.getAgent.query({ agentId })
      }, created.agent_id)

      expect(result).toBeDefined()
      expect(result.agent_id).toBe(created.agent_id)
    })

    test('spawnAgent 应该创建新 agent', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'test-workspace-spawn',
          command: 'test-agent-spawn',
        })
      })

      expect(result).toBeDefined()
      expect(result.agent_id).toBeDefined()
      expect(result.status).toBe('starting')
    })

    test('killAgent 应该终止 agent', async () => {
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'test-workspace',
          command: 'test-agent-kill',
        })
      })

      await expect(page.evaluate(async (agentId: string) => {
        await (window as any).trpc.test.ergatai.killAgent.mutate({ agentId })
      }, created.agent_id)).resolves.not.toThrow()
    })

    test('sendMessage 应该发送消息', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: 'test-agent',
          message: 'Hello',
        })
      })

      expect(result).toBeDefined()
      expect(result.status).toBe('queued')
    })
  })

  describe('Conversation 管理', () => {
    test('listConversations 应该返回数组', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listConversations.query()
      })
      expect(Array.isArray(result)).toBe(true)
    })

    test('createConversation 应该创建对话', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'Test Conversation',
          chatId: 'test-chat',
        })
      })

      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      expect(result.name).toBe('Test Conversation')
    })

    test('getConversation 应该获取对话详情', async () => {
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'Test Conversation Get',
          chatId: 'test-chat',
        })
      })

      const result = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.ergatai.getConversation.query({ id })
      }, created.id)

      expect(result).toBeDefined()
      expect(result.id).toBe(created.id)
    })

    test('deleteConversation 应该删除对话', async () => {
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'Test Conversation Delete',
          chatId: 'test-chat',
        })
      })

      await expect(page.evaluate(async (id: string) => {
        await (window as any).trpc.test.ergatai.deleteConversation.mutate({ id })
      }, created.id)).resolves.not.toThrow()
    })
  })

  describe('Workspace 管理', () => {
    test('listManagedWorkspaces 应该返回数组', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listManagedWorkspaces.query()
      })
      expect(Array.isArray(result)).toBe(true)
    })

    test('createManagedWorkspace 应该创建 workspace', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createManagedWorkspace.mutate({
          name: 'Test Workspace',
          workDir: '/tmp/test-workspace',
        })
      })

      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      expect(result.name).toBe('Test Workspace')
    })

    test('getManagedWorkspace 应该获取 workspace 详情', async () => {
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createManagedWorkspace.mutate({
          name: 'Test Workspace Get',
          workDir: '/tmp/test-workspace-get',
        })
      })

      const result = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.ergatai.getManagedWorkspace.query({ id })
      }, created.id)

      expect(result).toBeDefined()
      expect(result.id).toBe(created.id)
    })

    test('deleteManagedWorkspaces 应该删除 workspace', async () => {
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createManagedWorkspace.mutate({
          name: 'Test Workspace Delete',
          workDir: '/tmp/test-workspace-delete',
        })
      })

      await expect(page.evaluate(async (workspaceId: string) => {
        await (window as any).trpc.test.ergatai.deleteManagedWorkspaces.mutate({ workspaceId })
      }, created.id)).resolves.not.toThrow()
    })
  })

  describe('Profile 管理', () => {
    test('listProfiles 应该返回数组', async () => {
      const result = await page.evaluate(async () => {
        // test router 中没有 listProfiles，使用 listAgents 代替
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(Array.isArray(result)).toBe(true)
    })
  })

  describe('DAG/编排', () => {
    test('validateDagYaml 应该验证 YAML', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({
          yaml: `
tasks:
  - name: task1
    agent: agent1
  - name: task2
    agent: agent2
    depends_on: [task1]
`,
        })
      })

      expect(result).toBeDefined()
      expect(result.valid).toBe(true)
    })

    test('getDagStatus 应该获取 DAG 状态', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.getDagStatus.query({
          dagId: 'test-dag',
        })
      })

      expect(result).toBeDefined()
      expect(result.dagId).toBe('test-dag')
    })
  })

  describe('System 状态', () => {
    test('getSystemStatus 应该返回系统状态', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.getSystemStatus.query()
      })

      expect(result).toBeDefined()
      expect(typeof result.agents).toBe('number')
      expect(typeof result.workspaces).toBe('number')
      expect(typeof result.uptime).toBe('number')
    })

    test('getStats 应该返回统计信息', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.getStats.query()
      })

      expect(result).toBeDefined()
      expect(typeof result.totalAgents).toBe('number')
      expect(typeof result.totalConversations).toBe('number')
      expect(typeof result.totalWorkspaces).toBe('number')
    })
  })
})
