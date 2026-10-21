/**
 * E2E UI 测试 - Ergatai Agent 生命周期（内存存储版）
 * 测试 ergatai router 的 agent 操作：spawn、kill、send message
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'

describe('E2E: Ergatai Agent 生命周期', () => {
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

  describe('Agent Spawn', () => {
    test('应该能够 spawn 新 agent', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'claude',
          workspaceId: 'ws-1',
        })
      })

      expect(agent).toBeDefined()
      expect(agent.agent_id).toBeDefined()
      expect(agent.command).toBe('claude')
      expect(agent.workspace_id).toBe('ws-1')
      expect(agent.status).toBe('starting')
    })

    test('spawn 的 agent 应该出现在 agent 列表中', async () => {
      await page.evaluate(async () => {
        await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'claude',
          workspaceId: 'ws-1',
        })
      })

      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })

      expect(agents.length).toBeGreaterThan(0)
      expect(agents[0].command).toBe('claude')
    })

    test('应该能够通过 ID 获取特定 agent', async () => {
      const spawned = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'claude',
          workspaceId: 'ws-1',
        })
      })

      const agent = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.getAgent.query({ agentId })
      }, spawned.agent_id)

      expect(agent).toBeDefined()
      expect(agent.agent_id).toBe(spawned.agent_id)
      expect(agent.command).toBe('claude')
    })
  })

  describe('Agent Kill', () => {
    test('应该能够 kill agent', async () => {
      const spawned = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'claude',
          workspaceId: 'ws-1',
        })
      })

      const result = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.killAgent.mutate({ agentId })
      }, spawned.agent_id)

      expect(result.success).toBe(true)

      // 验证 agent 已从列表移除
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      const ids = agents.map((a: any) => a.agent_id)
      expect(ids).not.toContain(spawned.agent_id)
    })
  })

  describe('Agent Messaging', () => {
    test('应该能够向 agent 发送消息', async () => {
      const spawned = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'claude',
          workspaceId: 'ws-1',
        })
      })

      const result = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'Hello, agent!',
        })
      }, spawned.agent_id)

      expect(result).toBeDefined()
      expect(result.status).toBe('queued')
      expect(result.messageId).toBeDefined()
    })
  })

  describe('Agent Prompt', () => {
    test('应该能够向 agent 发送 prompt', async () => {
      const spawned = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'claude',
          workspaceId: 'ws-1',
        })
      })

      const result = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.promptAgent.mutate({
          agentId,
          prompt: 'Please help me with a task',
        })
      }, spawned.agent_id)

      expect(result).toBeDefined()
      expect(result.status).toBe('queued')
      expect(result.promptId).toBeDefined()
    })
  })

  describe('Multi-Agent Management', () => {
    test('应该能够 spawn 多个 agent', async () => {
      await page.evaluate(async () => {
        await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'claude',
          workspaceId: 'ws-1',
        })
        await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'cursor',
          workspaceId: 'ws-1',
        })
        await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'codex',
          workspaceId: 'ws-2',
        })
      })

      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })

      expect(agents.length).toBeGreaterThanOrEqual(3)
      const commands = agents.map((a: any) => a.command)
      expect(commands).toContain('claude')
      expect(commands).toContain('cursor')
      expect(commands).toContain('codex')
    })
  })
})
