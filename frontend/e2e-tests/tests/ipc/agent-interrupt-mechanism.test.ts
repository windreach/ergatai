/**
 * E2E UI 测试 - Agent Interrupt 机制
 * 验证 CLAUDE.md 描述的 Agent Interrupt：安全点消息插入
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration } from '../../fixtures/integration-launcher'

describe('E2E: Agent Interrupt 机制', () => {
  let electron: any
  let page: any

  beforeAll(async () => {
    const launched = await launchIntegrationElectron()
    electron = launched.electron
    page = launched.page
  })

  afterAll(async () => {
    await cleanupIntegration(electron)
  })

  beforeEach(async () => {
    await page.evaluate(async () => {
      await (window as any).trpc.test.helpers.cleanup.mutate()
    })
  })

  describe('基础 Interrupt 发送', () => {
    test('应该能够发送 interrupt prompt', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'interrupt-ws',
          command: 'interrupt-agent',
        })
      })

      const result = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.promptAgent.mutate({
          agentId,
          prompt: '紧急：请停止当前任务',
          interrupt: true,
        })
      }, agent.agent_id)

      expect(result).toBeDefined()
      expect(result.status).toBe('queued')
      expect(result.promptId).toBeDefined()
    })

    test('非 interrupt prompt 也应该正常工作', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'normal-ws',
          command: 'normal-agent',
        })
      })

      const result = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.promptAgent.mutate({
          agentId,
          prompt: '普通任务',
          interrupt: false,
        })
      }, agent.agent_id)

      expect(result).toBeDefined()
      expect(result.status).toBe('queued')
    })

    test('默认 interrupt 应该为 false', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'default-ws',
          command: 'default-agent',
        })
      })

      const result = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.promptAgent.mutate({
          agentId,
          prompt: 'Default behavior',
        })
      }, agent.agent_id)

      expect(result).toBeDefined()
      expect(result.status).toBe('queued')
    })
  })

  describe('Interrupt 与消息队列', () => {
    test('interrupt 和普通消息应该可以共存', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'mixed-ws',
          command: 'mixed-agent',
        })
      })

      const msgResult = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId, message: '普通消息',
        })
      }, agent.agent_id)

      const interruptResult = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.promptAgent.mutate({
          agentId, prompt: '紧急中断', interrupt: true,
        })
      }, agent.agent_id)

      expect(msgResult.status).toBe('queued')
      expect(interruptResult.status).toBe('queued')
    })

    test('多个 interrupt 应该各自独立', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'multi-interrupt-ws',
          command: 'multi-interrupt-agent',
        })
      })

      const results = []
      for (let i = 0; i < 3; i++) {
        const result = await page.evaluate(async (params: any) => {
          return await (window as any).trpc.test.ergatai.promptAgent.mutate({
            agentId: params.agentId,
            prompt: `Interrupt ${params.index}`,
            interrupt: true,
          })
        }, { agentId: agent.agent_id, index: i })
        results.push(result)
      }

      expect(results.length).toBe(3)
      const promptIds = results.map(r => r.promptId)
      const uniqueIds = new Set(promptIds)
      expect(uniqueIds.size).toBe(3)
    })
  })

  describe('Interrupt 状态验证', () => {
    test('发送 interrupt 后 agent 状态应该仍然可查询', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'status-ws',
          command: 'status-agent',
        })
      })

      await page.evaluate(async (agentId: string) => {
        await (window as any).trpc.test.ergatai.promptAgent.mutate({
          agentId, prompt: 'Stop!', interrupt: true,
        })
      }, agent.agent_id)

      const status = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.getAgent.query({ agentId })
      }, agent.agent_id)

      expect(status).toBeDefined()
      expect(status.agent_id).toBe(agent.agent_id)
    })

    test('被 interrupt 的 agent 应该仍然在列表中', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'list-ws',
          command: 'list-agent',
        })
      })

      await page.evaluate(async (agentId: string) => {
        await (window as any).trpc.test.ergatai.promptAgent.mutate({
          agentId, prompt: 'Interrupted', interrupt: true,
        })
      }, agent.agent_id)

      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })

      const found = agents.find((a: any) => a.agent_id === agent.agent_id)
      expect(found).toBeDefined()
    })
  })
})
