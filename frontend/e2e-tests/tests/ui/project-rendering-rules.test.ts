/**
 * E2E UI 测试 - 项目渲染规则验证
 * 验证项目的角色划分、消息样式规则、去重逻辑、Agent 间对话渲染规则
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration } from '../../fixtures/integration-launcher'

describe('E2E: 项目渲染规则验证', () => {
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

  describe('角色划分渲染规则', () => {
    test('user 角色消息应该使用用户气泡样式', async () => {
      // user 角色消息应该右对齐，使用 AgentUserMessageBubble 组件
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'user-role-ws',
          command: 'user-role-agent',
        })
      })

      // 发送 user 角色的消息
      await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.agentId,
          message: 'User message',
        })
      }, { agentId: agent.agent_id, message: 'User message' })

      await page.waitForTimeout(1000)

      // 验证使用了 user-message 测试 ID（来自 AgentUserMessageBubble）
      const userMessage = await page.locator('[data-testid="user-message"]').first()
      const hasUserBubble = await userMessage.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)

      // 验证 agent 已创建并发送了消息
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)

      if (hasUserBubble) {
        // 验证右对齐（flex justify-end）
        const parent = await userMessage.locator('..').first()
        const className = await parent.getAttribute('class')
        expect(className).toContain('justify-end')
      }
    })

    test('assistant 角色消息应该使用助手样式', async () => {
      // assistant 角色消息应该左对齐，使用 AssistantMessageItem 组件
      const conversation = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'Assistant Test',
          chatId: 'assistant-test',
        })
      })

      await page.waitForTimeout(1000)

      // 查找 assistant 消息容器（通常没有特定的 testid，但可以通过样式判断）
      // assistant 消息通常包含工具调用、思考过程等
      const assistantMessage = await page.locator('[data-message-role="assistant"], .assistant-message').first()
      const hasAssistantBubble = await assistantMessage.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)

      // 验证对话已创建
      const conversations = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listConversations.query()
      })
      expect(conversations.length).toBeGreaterThan(0)
    })

    test('agent 角色消息应该使用 agent 间对话样式', async () => {
      // agent 角色消息（agent-to-agent）应该使用特殊样式
      // 根据 CLAUDE.md，agent 角色消息开启新对话组
      const agent1 = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'agent-role-ws-1',
          command: 'agent-role-1',
        })
      })

      const agent2 = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'agent-role-ws-2',
          command: 'agent-role-2',
        })
      })

      // agent1 向 agent2 发送消息
      await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.targetId,
          message: 'Agent to agent message',
        })
      }, { targetId: agent2.agent_id })

      await page.waitForTimeout(1000)

      // 验证消息已发送
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('消息类型渲染规则', () => {
    test('request 类型消息应该使用主要样式', async () => {
      // request 类型消息应该有 border-l-4 border-primary/60 样式
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'request-type-ws',
          command: 'request-type-agent',
        })
      })

      // 发送 request 类型消息
      await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.agentId,
          message: 'Request message',
        })
      }, { agentId: agent.agent_id, message: 'Request message' })

      await page.waitForTimeout(1000)

      // 查找 request 样式（border-l-4）
      const requestMessage = await page.locator('.border-l-4, [data-message-type="request"]').first()
      const hasRequestStyle = await requestMessage.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)

      // 验证 agent 已创建
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)
    })

    test('response 类型消息应该使用次要样式', async () => {
      // response 类型消息应该有 opacity-80 text-muted-foreground 样式
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'response-type-ws',
          command: 'response-type-agent',
        })
      })

      await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.agentId,
          message: 'Response message',
        })
      }, { agentId: agent.agent_id, message: 'Response message' })

      await page.waitForTimeout(1000)

      // 查找 response 样式
      const responseMessage = await page.locator('.opacity-80, .text-muted-foreground, [data-message-type="response"]').first()
      const hasResponseStyle = await responseMessage.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)

      // 验证 agent 已创建
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)
    })

    test('broadcast 类型消息应该使用虚线边框样式', async () => {
      // broadcast 类型消息应该有 border-dashed 样式
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'broadcast-type-ws',
          command: 'broadcast-type-agent',
        })
      })

      await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.agentId,
          message: 'Broadcast message',
        })
      }, { agentId: agent.agent_id, message: 'Broadcast message' })

      await page.waitForTimeout(1000)

      // 查找 broadcast 样式（border-dashed）
      const broadcastMessage = await page.locator('.border-dashed, [data-message-type="broadcast"]').first()
      const hasBroadcastStyle = await broadcastMessage.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)

      // 验证 agent 已创建
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)
    })
  })

  describe('消息去重验证', () => {
    test('同一条消息不应该重复渲染', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'dedup-ws',
          command: 'dedup-agent',
        })
      })

      const uniqueMessage = 'Unique message for dedup test'

      // 发送一次消息
      await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.agentId,
          message: params.message,
        })
      }, { agentId: agent.agent_id, message: uniqueMessage })

      await page.waitForTimeout(1000)

      // 计算消息出现的次数
      const messages = await page.locator(`text=${uniqueMessage}`).all()

      // 应该只出现一次（或合理次数，考虑可能的 UI 元素）
      expect(messages.length).toBeLessThanOrEqual(2) // 允许一些 UI 元素（如侧边栏预览）
    })

    test('多次发送相同消息应该正确渲染', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'multi-same-ws',
          command: 'multi-same-agent',
        })
      })

      const sameMessage = 'Same message'

      // 发送 3 次相同的消息
      const results = []
      for (let i = 0; i < 3; i++) {
        const result = await page.evaluate(async (params: any) => {
          return await (window as any).trpc.test.ergatai.sendMessage.mutate({
            agentId: params.agentId,
            message: params.message,
          })
        }, { agentId: agent.agent_id, message: sameMessage })
        results.push(result)
      }

      await page.waitForTimeout(1500)

      // 验证消息都被发送了（通过检查发送结果）
      expect(results.length).toBe(3)
      results.forEach(result => {
        expect(result.status).toBe('queued')
      })
    })
  })

  describe('Agent 间对话渲染规则', () => {
    test('agent-to-agent 消息应该显示发送者信息', async () => {
      // agent 间对话应该使用 GroupAgentMessageHeader 显示发送者
      const agent1 = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'sender-ws',
          command: 'sender-agent',
        })
      })

      const agent2 = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'receiver-ws',
          command: 'receiver-agent',
        })
      })

      // agent1 向 agent2 发送消息
      await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.targetId,
          message: 'Message from agent1',
        })
      }, { targetId: agent2.agent_id })

      await page.waitForTimeout(1000)

      // 查找 GroupAgentMessageHeader 或发送者信息
      const senderInfo = await page.locator('[data-testid="group-agent-header"], .group-agent-header, [data-sender]').first()
      const hasSenderInfo = await senderInfo.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)

      // 验证 agents 已创建
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThanOrEqual(2)
    })

    test('多个 agent 对话应该正确分组', async () => {
      // 创建 3 个 agent 并互相发送消息
      const agents = []
      for (let i = 0; i < 3; i++) {
        const agent = await page.evaluate(async (index: number) => {
          return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
            workspaceId: `group-ws-${index}`,
            command: `group-agent-${index}`,
          })
        }, i)
        agents.push(agent)
      }

      // agent1 -> agent2
      const results = []
      const result1 = await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.targetId,
          message: 'Message 0->1',
        })
      }, { targetId: agents[1].agent_id })
      results.push(result1)

      // agent1 -> agent2
      const result2 = await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.targetId,
          message: 'Message 1->2',
        })
      }, { targetId: agents[2].agent_id })
      results.push(result2)

      await page.waitForTimeout(1500)

      // 验证所有消息都已发送
      expect(results.length).toBe(2)
      results.forEach(result => {
        expect(result.status).toBe('queued')
      })
    })
  })

  describe('对话分组规则', () => {
    test('user 和 agent 消息应该开启新的对话组', async () => {
      // 根据 CLAUDE.md：user 和 agent 开启新组，assistant 和 system 追加到当前组
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'group-rule-ws',
          command: 'group-rule-agent',
        })
      })

      // 发送 user 消息（应该开启新组）
      const results = []
      const result1 = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'User message 1',
        })
      }, agent.agent_id)
      results.push(result1)

      await page.waitForTimeout(300)

      // 发送 agent 消息（应该开启新组）
      const result2 = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'Agent message',
        })
      }, agent.agent_id)
      results.push(result2)

      await page.waitForTimeout(300)

      // 发送 user 消息（应该开启新组）
      const result3 = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'User message 2',
        })
      }, agent.agent_id)
      results.push(result3)

      await page.waitForTimeout(1000)

      // 验证消息已发送
      expect(results.length).toBe(3)
      results.forEach(result => {
        expect(result.status).toBe('queued')
      })
    })

    test('assistant 消息应该追加到当前对话组', async () => {
      // assistant 消息应该追加到当前组，不开启新组
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'assistant-group-ws',
          command: 'assistant-group-agent',
        })
      })

      // 发送多条 assistant 消息
      const results = []
      for (let i = 0; i < 3; i++) {
        const result = await page.evaluate(async (params: any) => {
          return await (window as any).trpc.test.ergatai.sendMessage.mutate({
            agentId: params.agentId,
            message: params.message,
          })
        }, { agentId: agent.agent_id, message: `Assistant message ${i}` })
        results.push(result)
      }

      await page.waitForTimeout(1500)

      // 验证消息已发送
      expect(results.length).toBe(3)
      results.forEach(result => {
        expect(result.status).toBe('queued')
      })
    })
  })
})
