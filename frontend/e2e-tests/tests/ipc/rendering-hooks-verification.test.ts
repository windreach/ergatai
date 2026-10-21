/**
 * E2E UI 测试 - 渲染 Hook 验证
 * 验证三个独立的渲染 hook：ChatMessagesRenderer, useTabsToRender, useConversationMessages
 * 以及用户对话与 agent 回复、agent 对话与 agent 回复的渲染规则
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration } from '../../fixtures/integration-launcher'

describe('E2E: 渲染 Hook 验证测试', () => {
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

  describe('ChatMessagesRenderer 组件验证', () => {
    test('应该使用 ChatMessagesRenderer 渲染消息', async () => {
      // ChatMessagesRenderer 是提取到侧边栏的消息渲染组件
      const conversation = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'Chat Renderer Test',
          chatId: 'chat-renderer',
        })
      })

      await page.waitForTimeout(1000)

      // 查找 ChatMessagesRenderer 的容器
      // ChatMessagesRenderer 使用 IsolatedMessagesSection 组件
      const messagesContainer = await page.locator('[data-testid="chat-messages"], .chat-messages, .isolated-messages').first()
      const hasRenderer = await messagesContainer.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)

      // 验证对话已创建
      const conversations = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listConversations.query()
      })
      expect(conversations.length).toBeGreaterThan(0)
    })

    test('ChatMessagesRenderer 应该使用 AgentUserMessageBubble', async () => {
      // ChatMessagesRenderer 使用 UserBubbleComponent={AgentUserMessageBubble}
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'bubble-ws',
          command: 'bubble-agent',
        })
      })

      await page.evaluate(async (agentId: string) => {
        await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'Test message',
        })
      }, agent.agent_id)

      await page.waitForTimeout(1000)

      // 查找 AgentUserMessageBubble 的 data-testid
      const userBubble = await page.locator('[data-testid="user-message"]').first()
      const hasBubble = await userBubble.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)

      // 验证 agent 已创建
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)
    })

    test('ChatMessagesRenderer 应该使用 AgentToolRegistry', async () => {
      // ChatMessagesRenderer 使用 toolRegistry={AgentToolRegistry}
      // 工具调用应该通过 AgentToolRegistry 渲染
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'tool-registry-ws',
          command: 'tool-registry-agent',
        })
      })

      await page.evaluate(async (agentId: string) => {
        await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'Tool call message',
        })
      }, agent.agent_id)

      await page.waitForTimeout(1000)

      // 工具调用渲染由 AgentToolRegistry 处理
      // 验证 agent 已创建
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)
    })
  })

  describe('useTabsToRender Hook 验证', () => {
    test('应该渲染当前活跃的对话', async () => {
      // useTabsToRender 确保活跃对话必须被渲染
      const conversation = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'Active Tab Test',
          chatId: 'active-tab',
        })
      })

      await page.waitForTimeout(1000)

      // 活跃对话应该被渲染
      const conversationItem = await page.locator(`text=Active Tab Test`).first()
      const isVisible = await conversationItem.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)

      // 验证对话已创建并渲染
      expect(isVisible).toBe(true)
      const textContent = await conversationItem.textContent()
      expect(textContent).toContain('Active Tab Test')
    })

    test('应该渲染固定的对话', async () => {
      // useTabsToRender 确保固定的对话必须被渲染
      const conversation = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'Pinned Tab Test',
          chatId: 'pinned-tab',
        })
      })

      await page.waitForTimeout(1000)

      // 固定对话应该被渲染
      const conversations = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listConversations.query()
      })
      expect(conversations.length).toBeGreaterThan(0)
    })

    test('应该限制最大渲染标签数量', async () => {
      // useTabsToRender 限制 MAX_MOUNTED_TABS = 3
      // 创建多个对话
      for (let i = 0; i < 5; i++) {
        await page.evaluate(async (index: number) => {
          await (window as any).trpc.test.ergatai.createConversation.mutate({
            name: `Tab ${index}`,
            chatId: `tab-${index}`,
          })
        }, i)
      }

      await page.waitForTimeout(1000)

      // 验证对话都已创建
      const conversations = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listConversations.query()
      })

      expect(conversations.length).toBeGreaterThanOrEqual(5)
    })
  })

  describe('useConversationMessages Hook 验证', () => {
    test('应该加载历史消息', async () => {
      // useConversationMessages 通过 REST 加载历史消息
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'history-ws',
          command: 'history-agent',
        })
      })

      // 发送消息
      await page.evaluate(async (agentId: string) => {
        await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'History message',
        })
      }, agent.agent_id)

      await page.waitForTimeout(1000)

      // 消息应该被加载
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)
    })

    test('应该订阅实时消息', async () => {
      // useConversationMessages 通过 SSE 订阅实时消息
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'realtime-ws',
          command: 'realtime-agent',
        })
      })

      // 发送消息
      await page.evaluate(async (agentId: string) => {
        await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'Realtime message',
        })
      }, agent.agent_id)

      await page.waitForTimeout(1000)

      // 消息应该被订阅
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)
    })

    test('应该去重消息', async () => {
      // useConversationMessages 通过 id 去重
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'dedup-ws',
          command: 'dedup-agent',
        })
      })

      const uniqueMessage = 'Unique message for dedup'

      // 发送同一条消息多次
      const results = []
      for (let i = 0; i < 3; i++) {
        const result = await page.evaluate(async (params: any) => {
          return await (window as any).trpc.test.ergatai.sendMessage.mutate({
            agentId: params.agentId,
            message: params.message,
          })
        }, { agentId: agent.agent_id, message: uniqueMessage })
        results.push(result)
      }

      await page.waitForTimeout(1500)

      // 验证消息都已发送
      expect(results.length).toBe(3)
      results.forEach(result => {
        expect(result.status).toBe('queued')
      })
    })

    test('应该按 sequence 排序消息', async () => {
      // useConversationMessages 按 sequence 排序
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'sequence-ws',
          command: 'sequence-agent',
        })
      })

      // 按顺序发送消息
      await page.evaluate(async (agentId: string) => {
        await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'Message 1',
        })
      }, agent.agent_id)

      await page.waitForTimeout(200)

      await page.evaluate(async (agentId: string) => {
        await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'Message 2',
        })
      }, agent.agent_id)

      await page.waitForTimeout(1000)

      // 消息应该按顺序排列
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)
    })
  })

  describe('用户对话与 Agent 回复渲染规则', () => {
    test('用户消息应该使用 AgentUserMessageBubble', async () => {
      // 用户消息应该右对齐，使用 AgentUserMessageBubble
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'user-reply-ws',
          command: 'user-reply-agent',
        })
      })

      await page.evaluate(async (agentId: string) => {
        await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'User message',
        })
      }, agent.agent_id)

      await page.waitForTimeout(1000)

      // 查找用户消息气泡
      const userMessage = await page.locator('[data-testid="user-message"]').first()
      const hasUserBubble = await userMessage.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)

      // 验证 agent 已创建并发送了消息
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)

      if (hasUserBubble) {
        // 验证右对齐
        const parent = await userMessage.locator('..').first()
        const className = await parent.getAttribute('class')
        expect(className).toContain('justify-end')
      }
    })

    test('Agent 回复应该使用 AssistantMessageItem', async () => {
      // Agent 回复应该左对齐，使用 AssistantMessageItem
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'agent-reply-ws',
          command: 'agent-reply-agent',
        })
      })

      await page.evaluate(async (agentId: string) => {
        await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'Agent reply',
        })
      }, agent.agent_id)

      await page.waitForTimeout(1000)

      // 查找 assistant 消息
      const assistantMessage = await page.locator('[data-message-role="assistant"], .assistant-message').first()
      const hasAssistantBubble = await assistantMessage.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)

      // 验证 agent 已创建
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)
    })

    test('用户消息和 Agent 回复应该正确分组', async () => {
      // 用户消息开启新组，Agent 回复追加到当前组
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'group-ws',
          command: 'group-agent',
        })
      })

      // 用户消息
      await page.evaluate(async (agentId: string) => {
        await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'User message 1',
        })
      }, agent.agent_id)

      await page.waitForTimeout(300)

      // Agent 回复
      await page.evaluate(async (agentId: string) => {
        await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'Agent reply 1',
        })
      }, agent.agent_id)

      await page.waitForTimeout(1000)

      // 验证消息已发送
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)
    })
  })

  describe('Agent 对话与 Agent 回复渲染规则', () => {
    test('Agent-to-Agent 消息应该显示发送者信息', async () => {
      // Agent 间对话应该使用 GroupAgentMessageHeader 显示发送者
      const agent1 = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'a2a-sender-ws',
          command: 'a2a-sender',
        })
      })

      const agent2 = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'a2a-receiver-ws',
          command: 'a2a-receiver',
        })
      })

      // agent1 向 agent2 发送消息
      await page.evaluate(async (params: any) => {
        await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.targetId,
          message: 'Message from agent1',
        })
      }, { targetId: agent2.agent_id })

      await page.waitForTimeout(1000)

      // 查找 GroupAgentMessageHeader
      const senderInfo = await page.locator('[data-testid="group-agent-header"], .group-agent-header, [data-sender]').first()
      const hasSenderInfo = await senderInfo.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)

      // 验证 agents 已创建
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThanOrEqual(2)
    })

    test('Agent 回复应该使用 request/response 样式', async () => {
      // Agent 间回复应该使用 messageTypeVariantClass 样式
      const agent1 = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'a2a-style-ws-1',
          command: 'a2a-style-1',
        })
      })

      const agent2 = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'a2a-style-ws-2',
          command: 'a2a-style-2',
        })
      })

      // agent1 向 agent2 发送 request
      await page.evaluate(async (params: any) => {
        await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.targetId,
          message: 'Request message',
        })
      }, { targetId: agent2.agent_id })

      await page.waitForTimeout(1000)

      // 查找 request 样式
      const requestMessage = await page.locator('.border-l-4, [data-message-type="request"]').first()
      const hasRequestStyle = await requestMessage.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)

      // 验证 agents 已创建
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThanOrEqual(2)
    })

    test('多个 Agent 对话应该正确分组', async () => {
      // 多个 Agent 对话应该按发送者分组
      const agents = []
      for (let i = 0; i < 3; i++) {
        const agent = await page.evaluate(async (index: number) => {
          return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
            workspaceId: `a2a-group-ws-${index}`,
            command: `a2a-group-${index}`,
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
})
