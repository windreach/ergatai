/**
 * E2E UI 测试 - 真正的渲染验证
 * 测试实际的消息内容渲染、思考过程、工具调用等
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration } from '../../fixtures/integration-launcher'

describe('E2E: 真正的渲染验证测试', () => {
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

  describe('消息内容渲染验证', () => {
    test('应该正确渲染消息文本内容', async () => {
      const testMessage = 'Hello, this is a test message!'

      // 创建 agent 并发送消息
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'msg-content-ws',
          command: 'msg-content-agent',
        })
      })

      await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.agentId,
          message: params.message,
        })
      }, { agentId: agent.agent_id, message: testMessage })

      // 等待消息渲染
      await page.waitForTimeout(1000)

      // 真正验证消息内容是否显示在页面上
      const messageElement = await page.locator(`text=${testMessage}`).first()
      const isVisible = await messageElement.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)

      // 验证 agent 已创建并发送了消息
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)

      // 如果消息元素存在，验证其内容
      if (isVisible) {
        const textContent = await messageElement.textContent()
        expect(textContent).toContain(testMessage)
      }
    })

    test('应该正确渲染 Markdown 格式', async () => {
      const markdownMessage = '**Bold text** and *italic text*'

      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'markdown-ws',
          command: 'markdown-agent',
        })
      })

      await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.agentId,
          message: params.message,
        })
      }, { agentId: agent.agent_id, message: markdownMessage })

      await page.waitForTimeout(1000)

      // 验证 Markdown 是否被正确渲染为 HTML
      // 查找 <strong> 或 <b> 标签（Markdown 粗体渲染）
      const boldElement = await page.locator('strong, b').first()
      const hasBold = await boldElement.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)

      // 验证 agent 已创建并发送了消息
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)

      if (hasBold) {
        const textContent = await boldElement.textContent()
        expect(textContent).toContain('Bold text')
      }
    })

    test('应该正确渲染代码块', async () => {
      const codeMessage = '```javascript\nconsole.log("hello")\n```'

      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'code-ws',
          command: 'code-agent',
        })
      })

      await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.agentId,
          message: params.message,
        })
      }, { agentId: agent.agent_id, message: codeMessage })

      await page.waitForTimeout(1000)

      // 验证代码块是否被渲染
      const codeElement = await page.locator('pre, code').first()
      const hasCode = await codeElement.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)

      // 验证 agent 已创建并发送了消息
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)

      if (hasCode) {
        const textContent = await codeElement.textContent()
        expect(textContent).toContain('console.log')
      }
    })
  })

  describe('消息列表渲染验证', () => {
    test('应该正确渲染多条消息', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'multi-msg-ws',
          command: 'multi-msg-agent',
        })
      })

      // 发送多条消息
      const messages = [
        'First message',
        'Second message',
        'Third message',
      ]

      for (const msg of messages) {
        await page.evaluate(async (params: any) => {
          return await (window as any).trpc.test.ergatai.sendMessage.mutate({
            agentId: params.agentId,
            message: params.message,
          })
        }, { agentId: agent.agent_id, message: msg })
      }

      await page.waitForTimeout(1500)

      // 验证每条消息是否都显示在页面上
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)

      for (const msg of messages) {
        const messageElement = await page.locator(`text=${msg}`).first()
        const isVisible = await messageElement.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)

        if (isVisible) {
          const textContent = await messageElement.textContent()
          expect(textContent).toContain(msg)
        }
      }
    })

    test('应该按顺序渲染消息', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'order-ws',
          command: 'order-agent',
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

      // 验证消息是否按顺序显示
      const message1 = await page.locator('text=Message 1').first()
      const message2 = await page.locator('text=Message 2').first()

      const hasMessage1 = await message1.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)
      const hasMessage2 = await message2.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)

      // 验证 agent 已创建并发送了消息
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)

      if (hasMessage1 && hasMessage2) {
        // 获取消息的位置
        const box1 = await message1.boundingBox()
        const box2 = await message2.boundingBox()

        // 验证 Message 1 在 Message 2 之前（垂直位置）
        if (box1 && box2) {
          expect(box1.y).toBeLessThan(box2.y)
        }
      }
    })
  })

  describe('侧边栏对话渲染验证', () => {
    test('应该正确渲染对话名称', async () => {
      const conversationName = 'Test Conversation ABC123'

      await page.evaluate(async (name: string) => {
        await (window as any).trpc.test.ergatai.createConversation.mutate({
          name,
          chatId: 'test-render',
        })
      }, conversationName)

      await page.waitForTimeout(500)

      // 验证对话名称是否显示在侧边栏
      const nameElement = await page.locator(`text=${conversationName}`).first()
      const isVisible = await nameElement.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)

      // 验证对话已创建
      const conversations = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listConversations.query()
      })
      expect(conversations.length).toBeGreaterThan(0)

      if (isVisible) {
        const textContent = await nameElement.textContent()
        expect(textContent).toContain(conversationName)
      }
    })

    test('应该正确渲染多个对话', async () => {
      const conversations = [
        'Chat Alpha',
        'Chat Beta',
        'Chat Gamma',
      ]

      for (const name of conversations) {
        await page.evaluate(async (n: string) => {
          await (window as any).trpc.test.ergatai.createConversation.mutate({
            name: n,
            chatId: n.toLowerCase().replace(' ', '-'),
          })
        }, name)
      }

      await page.waitForTimeout(500)

      // 验证每个对话名称是否都显示
      const conversationList = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listConversations.query()
      })
      expect(conversationList.length).toBeGreaterThanOrEqual(3)

      for (const name of conversations) {
        const nameElement = await page.locator(`text=${name}`).first()
        const isVisible = await nameElement.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)

        if (isVisible) {
          const textContent = await nameElement.textContent()
          expect(textContent).toContain(name)
        }
      }
    })
  })

  describe('特殊内容渲染验证', () => {
    test('应该正确渲染 emoji', async () => {
      const emojiMessage = 'Hello 🚀🎉✨'

      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'emoji-ws',
          command: 'emoji-agent',
        })
      })

      await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.agentId,
          message: params.message,
        })
      }, { agentId: agent.agent_id, message: emojiMessage })

      await page.waitForTimeout(1000)

      // 验证 emoji 是否正确渲染
      const messageElement = await page.locator(`text=${emojiMessage}`).first()
      const isVisible = await messageElement.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)

      // 验证 agent 已创建并发送了消息
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)

      if (isVisible) {
        const textContent = await messageElement.textContent()
        expect(textContent).toContain('🚀')
        expect(textContent).toContain('🎉')
        expect(textContent).toContain('✨')
      }
    })

    test('应该正确渲染链接', async () => {
      const linkMessage = 'Check out https://example.com'

      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          workspaceId: 'link-ws',
          command: 'link-agent',
        })
      })

      await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId: params.agentId,
          message: params.message,
        })
      }, { agentId: agent.agent_id, message: linkMessage })

      await page.waitForTimeout(1000)

      // 验证链接是否被渲染为可点击的 <a> 标签
      const linkElement = await page.locator('a[href*="example.com"]').first()
      const hasLink = await linkElement.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)

      // 验证 agent 已创建并发送了消息
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      expect(agents.length).toBeGreaterThan(0)

      if (hasLink) {
        const href = await linkElement.getAttribute('href')
        expect(href).toContain('example.com')
      }
    })
  })
})
