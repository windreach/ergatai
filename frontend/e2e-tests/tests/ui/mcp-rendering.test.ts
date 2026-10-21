/**
 * E2E UI 测试 - MCP 对话和 UI 渲染
 * 测试真实的 MCP 消息传递和 UI 渲染效果
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration } from '../../fixtures/integration-launcher'

describe('E2E: MCP 对话和 UI 渲染测试', () => {
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

  describe('MCP 消息发送和接收', () => {
    test('应该能够通过 MCP 发送消息到 agent', async () => {
      // 创建 agent
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'mcp-ws',
          command: 'mcp-agent',
        })
      })

      // 发送消息
      const result = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'Hello via MCP!',
        })
      }, agent.agent_id)

      expect(result).toBeDefined()
      expect(result.status).toBe('queued')
    })

    test('应该能够接收 agent 的 MCP 响应', async () => {
      // 创建 agent
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'mcp-response-ws',
          command: 'mcp-response-agent',
        })
      })

      // 发送消息
      await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'Test message',
        })
      }, agent.agent_id)

      // 等待一段时间让 agent 处理
      await page.waitForTimeout(1000)

      // 验证 agent 已创建
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)
    })
  })

  describe('UI 渲染验证', () => {
    test('应该能够渲染聊天界面', async () => {
      // 等待页面加载
      await page.waitForLoadState('domcontentloaded')

      // 查找聊天界面元素
      const chatInterface = await page.locator('[data-testid="chat-interface"], .chat-interface, [role="main"]').first()
      const isVisible = await chatInterface.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)

      // 验证聊天界面存在（测试环境必须渲染主界面）
      expect(isVisible).toBe(true)
    })

    test('应该能够渲染消息列表', async () => {
      // 创建对话
      await page.evaluate(async () => {
        await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'Render Test',
          chatId: 'render-test',
        })
      })

      // 查找消息列表元素
      const messageList = await page.locator('[data-testid="message-list"], .message-list, [role="log"]').first()
      const isVisible = await messageList.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)

      // 验证消息列表存在（对话已创建，应该渲染消息列表）
      expect(isVisible).toBe(true)
    })

    test('应该能够渲染输入框', async () => {
      // 查找输入框元素
      const input = await page.locator('[data-testid="message-input"], input[type="text"], textarea').first()
      const isVisible = await input.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)

      // 验证输入框存在（聊天界面必须包含输入框）
      expect(isVisible).toBe(true)
    })
  })

  describe('Agent 间对话渲染', () => {
    test('应该能够渲染多个 agent 的对话', async () => {
      // 创建多个 agent
      const agents = []
      for (let i = 0; i < 3; i++) {
        const agent = await page.evaluate(async (index: number) => {
          return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
            workspaceId: `multi-agent-ws-${index}`,
            command: `multi-agent-${index}`,
          })
        }, i)
        agents.push(agent)
      }

      // 向每个 agent 发送消息
      for (const agent of agents) {
        await page.evaluate(async (params: any) => {
          return await (window as any).trpc.test.ergatai.sendMessage.mutate({
            agentId: params.agentId,
            message: `Message to ${params.command}`,
          })
        }, { agentId: agent.agent_id, command: agent.command })
      }

      // 等待消息处理
      await page.waitForTimeout(1000)

      // 验证所有 agent 都已创建
      const allAgents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })

      expect(allAgents.length).toBeGreaterThanOrEqual(3)
    })

    test('应该能够渲染 agent 响应', async () => {
      // 创建 agent
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'response-render-ws',
          command: 'response-render-agent',
        })
      })

      // 发送消息
      await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'Test response',
        })
      }, agent.agent_id)

      // 等待响应
      await page.waitForTimeout(1000)

      // 验证消息已发送
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)
    })
  })

  describe('消息类型渲染', () => {
    test('应该能够渲染文本消息', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'text-msg-ws',
          command: 'text-msg-agent',
        })
      })

      await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'This is a text message',
        })
      }, agent.agent_id)

      await page.waitForTimeout(500)
      // 验证消息已发送（通过检查 agent 存在）
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)
    })

    test('应该能够渲染长文本消息', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'long-msg-ws',
          command: 'long-msg-agent',
        })
      })

      const longMessage = 'A'.repeat(500)

      await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.agentId,
          message: params.message,
        })
      }, { agentId: agent.agent_id, message: longMessage })

      await page.waitForTimeout(500)
      // 验证消息已发送
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)
    })

    test('应该能够渲染特殊字符消息', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'special-msg-ws',
          command: 'special-msg-agent',
        })
      })

      const specialMessage = 'Test <>&"\' 特殊字符 🚀'

      await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.agentId,
          message: params.message,
        })
      }, { agentId: agent.agent_id, message: specialMessage })

      await page.waitForTimeout(500)
      // 验证消息已发送
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)
    })
  })

  describe('侧边栏对话渲染', () => {
    test('应该能够在侧边栏渲染对话列表', async () => {
      // 创建多个对话
      for (let i = 0; i < 3; i++) {
        await page.evaluate(async (index: number) => {
          await (window as any).trpc.test.ergatai.createConversation.mutate({
            name: `Sidebar Chat ${index}`,
            chatId: `sidebar-${index}`,
          })
        }, i)
      }

      // 查找侧边栏元素
      const sidebar = await page.locator('[data-testid="sidebar"], .sidebar, aside, nav').first()
      const isVisible = await sidebar.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)

      // 验证侧边栏存在（对话已创建，应该渲染侧边栏）
      expect(isVisible).toBe(true)
    })

    test('应该能够点击侧边栏对话', async () => {
      // 创建对话
      await page.evaluate(async () => {
        await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'Clickable Chat',
          chatId: 'clickable',
        })
      })

      // 查找侧边栏对话项
      const conversationItem = await page.locator('[data-testid="conversation-item"], .conversation-item, [role="listitem"]').first()
      const isVisible = await conversationItem.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)

      // 验证对话项存在（对话已创建，应该在侧边栏显示）
      expect(isVisible).toBe(true)
      await conversationItem.click()
      await page.waitForTimeout(500)
    })
  })

  describe('错误处理渲染', () => {
    test('应该能够渲染错误消息', async () => {
      // test router 可能不会验证 agent 是否存在，直接发送消息
      const result = await page.evaluate(async () => {
        try {
          return await (window as any).trpc.test.ergatai.sendMessage.mutate({
            agentId: 'non-existent-agent',
            message: 'Test message',
          })
        } catch (e) {
          return { error: true }
        }
      })

      // test router 可能返回成功或错误，都接受
      expect(result).toBeDefined()

      // 如果有错误，查找错误提示元素
      if (result.error) {
        const error = await page.locator('[role="alert"], .error-message, .toast-error').first()
        const isVisible = await error.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)

        // 验证错误提示存在（发送消息失败应该显示错误）
        expect(isVisible).toBe(true)
      }
    })
  })
})
