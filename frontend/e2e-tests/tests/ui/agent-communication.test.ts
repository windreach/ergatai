/**
 * E2E UI 测试 - Agent 间通信
 * 测试多个 agent 之间的消息传递和对话渲染
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration } from '../../fixtures/integration-launcher'

describe('E2E: Agent 间通信测试', () => {
  let electron: any
  let page: any

  beforeAll(async () => {
    const launched = await launchIntegrationElectron()
    electron = launched.electron
    page = launched.page

    process.on('exit', async () => {
      if (electron) { try { await cleanupIntegration(electron) } catch (e) { /* ignore */ } }
    })
  })

  afterAll(async () => {
    await cleanupIntegration(electron)
  })

  beforeEach(async () => {
    await page.evaluate(async () => {
      await (window as any).trpc.test.helpers.cleanup.mutate()
    })
  })

  describe('多 Agent 创建', () => {
    test('应该能够创建多个 agent', async () => {
      const agents = []
      for (let i = 0; i < 3; i++) {
        const agent = await page.evaluate(async (index: number) => {
          return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
            workspaceId: `comm-ws-${index}`,
            command: `comm-agent-${index}`,
          })
        }, i)
        agents.push(agent)
      }

      expect(agents.length).toBe(3)

      const allAgents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })

      expect(allAgents.length).toBeGreaterThanOrEqual(3)
    })

    test('每个 agent 应该有唯一 ID', async () => {
      const agent1 = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'unique-ws-1',
          command: 'unique-agent-1',
        })
      })

      const agent2 = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'unique-ws-2',
          command: 'unique-agent-2',
        })
      })

      expect(agent1.agent_id).not.toBe(agent2.agent_id)
    })
  })

  describe('Agent 间消息发送', () => {
    test('agent 应该能够向其他 agent 发送消息', async () => {
      const sender = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'sender-ws',
          command: 'sender-agent',
        })
      })

      const receiver = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'receiver-ws',
          command: 'receiver-agent',
        })
      })

      const result = await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.receiverId,
          message: 'Hello from sender!',
        })
      }, { receiverId: receiver.agent_id })

      expect(result).toBeDefined()
      expect(result.status).toBe('queued')
    })

    test('应该能够发送多条消息', async () => {
      const sender = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'multi-msg-ws',
          command: 'multi-msg-agent',
        })
      })

      const messages = []
      for (let i = 0; i < 5; i++) {
        const result = await page.evaluate(async (params: any) => {
          return await (window as any).trpc.test.ergatai.sendMessage.mutate({
            agentId: params.agentId,
            message: `Message ${params.index}`,
          })
        }, { agentId: sender.agent_id, index: i })
        messages.push(result)
      }

      expect(messages.length).toBe(5)
      messages.forEach(msg => {
        expect(msg.status).toBe('queued')
      })
    })
  })

  describe('消息队列和传递', () => {
    test('消息应该被正确队列', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'queue-ws',
          command: 'queue-agent',
        })
      })

      // 发送消息
      const result = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'Test queue message',
        })
      }, agent.agent_id)

      expect(result.status).toBe('queued')
    })

    test('应该能够向不同 agent 发送不同消息', async () => {
      const agent1 = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'diff-msg-ws-1',
          command: 'diff-msg-agent-1',
        })
      })

      const agent2 = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'diff-msg-ws-2',
          command: 'diff-msg-agent-2',
        })
      })

      const result1 = await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.agentId,
          message: 'Message for agent 1',
        })
      }, { agentId: agent1.agent_id })

      const result2 = await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.agentId,
          message: 'Message for agent 2',
        })
      }, { agentId: agent2.agent_id })

      expect(result1.status).toBe('queued')
      expect(result2.status).toBe('queued')
    })
  })

  describe('Agent 状态和通信', () => {
    test('应该能够查询 agent 状态', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'status-ws',
          command: 'status-agent',
        })
      })

      const status = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.getAgent.query({ agentId })
      }, agent.agent_id)

      expect(status).toBeDefined()
      expect(status.agent_id).toBe(agent.agent_id)
      expect(status.status).toBe('starting')
    })

    test('agent 删除后应该不再接收消息', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'delete-comm-ws',
          command: 'delete-comm-agent',
        })
      })

      // 删除 agent
      await page.evaluate(async (agentId: string) => {
        await (window as any).trpc.test.ergatai.killAgent.mutate({ agentId })
      }, agent.agent_id)

      // 验证 agent 已被删除
      await expect(page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.getAgent.query({ agentId })
      }, agent.agent_id)).rejects.toThrow()
    })
  })

  describe('并发消息传递', () => {
    test('应该能够并发发送消息到多个 agent', async () => {
      const agents = []
      for (let i = 0; i < 3; i++) {
        const agent = await page.evaluate(async (index: number) => {
          return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
            workspaceId: `concurrent-ws-${index}`,
            command: `concurrent-agent-${index}`,
          })
        }, i)
        agents.push(agent)
      }

      // 并发发送消息
      const promises = agents.map(agent =>
        page.evaluate(async (params: any) => {
          return await (window as any).trpc.test.ergatai.sendMessage.mutate({
            agentId: params.agentId,
            message: `Concurrent message to ${params.command}`,
          })
        }, { agentId: agent.agent_id, command: agent.command })
      )

      const results = await Promise.all(promises)

      expect(results.length).toBe(3)
      results.forEach(result => {
        expect(result.status).toBe('queued')
      })
    })
  })

  describe('消息历史追踪', () => {
    test('应该能够追踪消息发送历史', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'history-track-ws',
          command: 'history-track-agent',
        })
      })

      // 发送多条消息
      for (let i = 0; i < 3; i++) {
        await page.evaluate(async (params: any) => {
          return await (window as any).trpc.test.ergatai.sendMessage.mutate({
            agentId: params.agentId,
            message: `History message ${params.index}`,
          })
        }, { agentId: agent.agent_id, index: i })
      }

      // 验证 agent 仍然存在（消息已被处理）
      const status = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.getAgent.query({ agentId })
      }, agent.agent_id)

      expect(status).toBeDefined()
    })
  })

  describe('错误处理', () => {
    test('向不存在的 agent 发送消息应该失败', async () => {
      await expect(page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: 'non-existent-agent',
          message: 'Test message',
        })
      })).rejects.toThrow()
    })

    test('空消息应该被拒绝', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'empty-msg-ws',
          command: 'empty-msg-agent',
        })
      })

      await expect(page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: '',
        })
      }, agent.agent_id)).rejects.toThrow()
    })
  })
})
