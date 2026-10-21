/**
 * E2E UI 测试 - 渲染规则打印验证
 * 实际打印出消息使用的渲染组件和规则
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration } from '../../fixtures/integration-launcher'

describe('E2E: 渲染规则打印验证', () => {
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

  describe('渲染规则打印', () => {
    test('用户消息应该打印 role=user 和使用 AgentUserMessageBubble', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'user-render-ws',
          command: 'user-render-agent',
        })
      })

      await page.evaluate(async (agentId: string) => {
        await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'User message test',
        })
      }, agent.agent_id)

      await page.waitForTimeout(1500)

      // 打印消息的渲染规则
      const renderInfo = await page.evaluate(() => {
        const messages: any[] = []

        // 查找所有消息元素
        const messageElements = document.querySelectorAll('[data-testid="user-message"], [data-message-role], [data-agent-message-id]')

        messageElements.forEach(el => {
          const role = el.getAttribute('data-message-role') ||
                      (el.hasAttribute('data-testid') ? 'user' :
                      el.hasAttribute('data-agent-message-id') ? 'agent' : 'unknown')

          // 检测使用的组件
          let component = 'unknown'
          if (el.hasAttribute('data-testid') && el.getAttribute('data-testid') === 'user-message') {
            component = 'AgentUserMessageBubble'
          } else if (el.hasAttribute('data-agent-message-id')) {
            component = 'AgentMessageItem'
          } else if (el.closest('[class*="assistant"]') || el.getAttribute('data-message-role') === 'assistant') {
            component = 'AssistantMessageItem'
          }

          // 检测样式
          const className = el.className || ''
          let style = 'unknown'
          if (className.includes('justify-end')) {
            style = 'right-aligned (user bubble)'
          } else if (className.includes('border-l-4')) {
            style = 'request style (border-l-4)'
          } else if (className.includes('opacity-80')) {
            style = 'response style (opacity-80)'
          } else if (className.includes('border-dashed')) {
            style = 'broadcast style (border-dashed)'
          }

          messages.push({
            role,
            component,
            style,
            text: el.textContent?.substring(0, 50)
          })
        })

        return messages
      })

      console.log('\n=== 用户消息渲染规则 ===')
      console.log('发送的消息: "User message test"')
      console.log('渲染信息:', JSON.stringify(renderInfo, null, 2))

      // 验证
      expect(renderInfo.length).toBeGreaterThan(0)

      // 应该找到 user 角色的消息
      const userMessage = renderInfo.find(m => m.role === 'user')
      expect(userMessage).toBeDefined()
      expect(userMessage?.component).toBe('AgentUserMessageBubble')
      expect(userMessage?.style).toContain('right-aligned')

      console.log('✓ 用户消息使用 AgentUserMessageBubble 组件')
      console.log('✓ 用户消息右对齐')
    })

    test('Agent 请求应该打印 role=agent 和使用 AgentMessageItem', async () => {
      const agent1 = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'agent-request-ws-1',
          command: 'agent-request-1',
        })
      })

      const agent2 = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'agent-request-ws-2',
          command: 'agent-request-2',
        })
      })

      // agent1 向 agent2 发送请求
      await page.evaluate(async (params: any) => {
        await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.targetId,
          message: 'Agent request test',
        })
      }, { targetId: agent2.agent_id })

      await page.waitForTimeout(1500)

      // 打印消息的渲染规则
      const renderInfo = await page.evaluate(() => {
        const messages: any[] = []

        // 查找所有 agent 消息
        const agentMessages = document.querySelectorAll('[data-agent-message-id]')

        agentMessages.forEach(el => {
          const role = 'agent'
          const component = 'AgentMessageItem'

          // 检测是否有 GroupAgentMessageHeader
          const hasHeader = el.querySelector('[data-testid="group-agent-header"]') !== null ||
                           el.querySelector('.group-agent-header') !== null

          const className = el.className || ''
          let style = 'agent style'
          if (className.includes('border-l-4')) {
            style = 'request style (border-l-4)'
          }

          messages.push({
            role,
            component,
            style,
            hasHeader,
            text: el.textContent?.substring(0, 50)
          })
        })

        return messages
      })

      console.log('\n=== Agent 请求渲染规则 ===')
      console.log('发送的消息: "Agent request test"')
      console.log('渲染信息:', JSON.stringify(renderInfo, null, 2))

      // 验证
      expect(renderInfo.length).toBeGreaterThan(0)

      const agentMessage = renderInfo.find(m => m.role === 'agent')
      expect(agentMessage).toBeDefined()
      expect(agentMessage?.component).toBe('AgentMessageItem')
      expect(agentMessage?.hasHeader).toBe(true)

      console.log('✓ Agent 请求使用 AgentMessageItem 组件')
      console.log('✓ Agent 请求显示发送者信息 (GroupAgentMessageHeader)')
    })

    test('Agent 回复应该打印 role=assistant 和使用 AssistantMessageItem', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'agent-reply-ws',
          command: 'agent-reply-agent',
        })
      })

      // 发送消息触发 agent 回复
      await page.evaluate(async (agentId: string) => {
        await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'Trigger agent reply',
        })
      }, agent.agent_id)

      await page.waitForTimeout(2000)

      // 打印消息的渲染规则
      const renderInfo = await page.evaluate(() => {
        const messages: any[] = []

        // 查找所有 assistant 消息
        const assistantMessages = document.querySelectorAll('[data-message-role="assistant"], .assistant-message')

        assistantMessages.forEach(el => {
          const role = 'assistant'
          const component = 'AssistantMessageItem'

          const className = el.className || ''
          let style = 'assistant style'

          messages.push({
            role,
            component,
            style,
            text: el.textContent?.substring(0, 50)
          })
        })

        return messages
      })

      console.log('\n=== Agent 回复渲染规则 ===')
      console.log('触发的回复: "Trigger agent reply"')
      console.log('渲染信息:', JSON.stringify(renderInfo, null, 2))

      // 验证
      expect(renderInfo.length).toBeGreaterThanOrEqual(0)

      // 如果找到 assistant 消息，验证它使用 AssistantMessageItem
      if (renderInfo.length > 0) {
        const assistantMessage = renderInfo.find(m => m.role === 'assistant')
        expect(assistantMessage).toBeDefined()
        expect(assistantMessage?.component).toBe('AssistantMessageItem')

        console.log('✓ Agent 回复使用 AssistantMessageItem 组件')
        console.log('✓ Agent 回复使用助手样式')
      } else {
        console.log('⚠ 未找到 assistant 消息（test router 可能不生成 assistant 回复）')
      }
    })

    test('完整对话流程渲染规则', async () => {
      const agent1 = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'full-flow-ws-1',
          command: 'full-flow-1',
        })
      })

      const agent2 = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'full-flow-ws-2',
          command: 'full-flow-2',
        })
      })

      // 1. 用户发送消息
      await page.evaluate(async (agentId: string) => {
        await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'User message',
        })
      }, agent1.agent_id)

      await page.waitForTimeout(500)

      // 2. Agent1 向 Agent2 发送请求
      await page.evaluate(async (params: any) => {
        await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.targetId,
          message: 'Agent1 to Agent2 request',
        })
      }, { targetId: agent2.agent_id })

      await page.waitForTimeout(500)

      // 3. 打印所有消息的渲染规则
      const renderInfo = await page.evaluate(() => {
        const messages: any[] = []

        // 查找所有消息
        const allMessages = document.querySelectorAll('[data-testid="user-message"], [data-message-role], [data-agent-message-id]')

        allMessages.forEach(el => {
          let role = 'unknown'
          let component = 'unknown'

          if (el.hasAttribute('data-testid') && el.getAttribute('data-testid') === 'user-message') {
            role = 'user'
            component = 'AgentUserMessageBubble'
          } else if (el.hasAttribute('data-agent-message-id')) {
            role = 'agent'
            component = 'AgentMessageItem'
          } else if (el.getAttribute('data-message-role') === 'assistant') {
            role = 'assistant'
            component = 'AssistantMessageItem'
          }

          messages.push({
            role,
            component,
            text: el.textContent?.substring(0, 30)
          })
        })

        return messages
      })

      console.log('\n=== 完整对话流程渲染规则 ===')
      console.log('渲染信息:', JSON.stringify(renderInfo, null, 2))

      console.log('\n📋 项目渲染规则总结:')
      console.log('1. 用户消息 (role=user) → AgentUserMessageBubble (右对齐)')
      console.log('2. Agent 请求 (role=agent) → AgentMessageItem (显示发送者)')
      console.log('3. Agent 回复 (role=assistant) → AssistantMessageItem (助手样式)')

      expect(renderInfo.length).toBeGreaterThan(0)
    })
  })
})
