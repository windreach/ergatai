/**
 * IPC 单元测试 - Agents Router (真实 router，非 test.agents)
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

describe('IPC: Agents Router (Real)', () => {
  const ctx = createTestContext({ skipAutoCleanup: true })
  const testAgentName = 'test-real-agent'

  ctx.afterAll(async () => {
    // 清理测试 agent
    const agentPath = path.join(os.homedir(), '.claude', 'agents', `${testAgentName}.md`)
    await fs.unlink(agentPath).catch(() => {})
  })

  test.beforeEach(async () => {
    // 每个测试前清理
    const agentPath = path.join(os.homedir(), '.claude', 'agents', `${testAgentName}.md`)
    await fs.unlink(agentPath).catch(() => {})
  })

  describe('agents.list', () => {
    test('应该返回 agent 数组', async () => {
      const agents = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.agents.list.query()
      })

      expect(Array.isArray(agents)).toBe(true)

      // 每个 agent 应该有必要的字段
      for (const agent of agents) {
        expect(typeof agent.name).toBe('string')
        expect(typeof agent.source).toBe('string')
        expect(['user', 'project', 'plugin']).toContain(agent.source)
        expect(typeof agent.path).toBe('string')
      }
    })

    test('接受可选的 cwd 参数', async () => {
      const agents = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.agents.list.query({ cwd: '/tmp' })
      })

      expect(Array.isArray(agents)).toBe(true)
    })
  })

  describe('agents.listEnabled', () => {
    test('应该返回 agent 数组（与 list 相同）', async () => {
      const agents = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.agents.listEnabled.query()
      })

      expect(Array.isArray(agents)).toBe(true)
    })
  })

  describe('agents.create', () => {
    test('应该创建 user agent', async () => {
      const result = await ctx.page.evaluate(async (name: string) => {
        return await (window as any).trpc.agents.create.mutate({
          name,
          description: 'Test agent',
          prompt: 'You are a test agent',
          source: 'user',
        })
      }, testAgentName)

      expect(result).toBeDefined()
      expect(result.name).toBe(testAgentName)
      expect(result.source).toBe('user')
      expect(typeof result.path).toBe('string')

      // 验证文件已创建
      const agentPath = path.join(os.homedir(), '.claude', 'agents', `${testAgentName}.md`)
      const exists = await fs.access(agentPath).then(() => true).catch(() => false)
      expect(exists).toBe(true)

      // 验证文件内容
      const content = await fs.readFile(agentPath, 'utf-8')
      expect(content).toContain(testAgentName)
      expect(content).toContain('Test agent')
    })

    test('名称应该被规范化为 kebab-case', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.agents.create.mutate({
          name: 'Test Agent With Spaces',
          description: 'Test',
          prompt: 'Test',
          source: 'user',
        })
      })

      expect(result.name).toBe('test-agent-with-spaces')

      // 清理
      const agentPath = path.join(os.homedir(), '.claude', 'agents', 'test-agent-with-spaces.md')
      await fs.unlink(agentPath).catch(() => {})
    })
  })

  describe('agents.get', () => {
    test('应该获取已存在的 agent', async () => {
      // 先创建 agent
      await ctx.page.evaluate(async (name: string) => {
        await (window as any).trpc.agents.create.mutate({
          name,
          description: 'Test agent',
          prompt: 'You are a test agent',
          source: 'user',
        })
      }, testAgentName)

      // 获取 agent
      const agent = await ctx.page.evaluate(async (name: string) => {
        return await (window as any).trpc.agents.get.query({ name })
      }, testAgentName)

      expect(agent).toBeDefined()
      expect(agent).not.toBeNull()
      expect(agent.name).toBe(testAgentName)
    })

    test('不存在的 agent 应该返回 null', async () => {
      const agent = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.agents.get.query({ name: 'non-existent-agent' })
      })

      expect(agent).toBeNull()
    })
  })

  describe('agents.update', () => {
    test('应该更新 agent', async () => {
      // 先创建 agent
      await ctx.page.evaluate(async (name: string) => {
        await (window as any).trpc.agents.create.mutate({
          name,
          description: 'Original description',
          prompt: 'Original prompt',
          source: 'user',
        })
      }, testAgentName)

      // 更新 agent
      const result = await ctx.page.evaluate(async (name: string) => {
        return await (window as any).trpc.agents.update.mutate({
          originalName: name,
          name,
          description: 'Updated description',
          prompt: 'Updated prompt',
          source: 'user',
        })
      }, testAgentName)

      expect(result).toBeDefined()
      expect(result.name).toBe(testAgentName)

      // 验证文件内容已更新
      const agentPath = path.join(os.homedir(), '.claude', 'agents', `${testAgentName}.md`)
      const content = await fs.readFile(agentPath, 'utf-8')
      expect(content).toContain('Updated description')
    })
  })

  describe('agents.delete', () => {
    test('应该删除 agent', async () => {
      // 先创建 agent
      await ctx.page.evaluate(async (name: string) => {
        await (window as any).trpc.agents.create.mutate({
          name,
          description: 'Test',
          prompt: 'Test',
          source: 'user',
        })
      }, testAgentName)

      // 删除 agent
      const result = await ctx.page.evaluate(async (name: string) => {
        return await (window as any).trpc.agents.delete.mutate({ name, source: 'user' })
      }, testAgentName)

      expect(result).toBeDefined()
      expect(result.deleted).toBe(true)

      // 验证文件已删除
      const agentPath = path.join(os.homedir(), '.claude', 'agents', `${testAgentName}.md`)
      const exists = await fs.access(agentPath).then(() => true).catch(() => false)
      expect(exists).toBe(false)
    })
  })
})
