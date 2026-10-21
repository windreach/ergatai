/**
 * E2E UI 测试 - Agent 生命周期（简化版）
 * 测试核心 Agent 交互：创建、删除、列表
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

describe('E2E: Agent 生命周期', () => {
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
    // 清理测试创建的 agent 文件
    const userAgentsDir = path.join(os.homedir(), '.claude', 'agents')
    for (const name of ['test-agent', 'list-test-agent', 'delete-test-agent', 'agent-1', 'agent-2', 'agent-3']) {
      await fs.unlink(path.join(userAgentsDir, `${name}.md`)).catch(() => {})
    }
    await electron.close()
  })

  beforeEach(async () => {
    // 清理测试创建的 agent 文件
    const userAgentsDir = path.join(os.homedir(), '.claude', 'agents')
    for (const name of ['test-agent', 'list-test-agent', 'delete-test-agent', 'agent-1', 'agent-2', 'agent-3']) {
      await fs.unlink(path.join(userAgentsDir, `${name}.md`)).catch(() => {})
    }
  })

  describe('Agent 创建', () => {
    test('应该能够通过 IPC 创建新 agent', async () => {
      const agent = await page.evaluate(async () => {
        return await (window as any).trpc.test.agents.create.mutate({
          name: 'test-agent',
          description: 'Test agent for lifecycle',
          prompt: 'You are a test agent',
          source: 'user',
        })
      })

      expect(agent).toBeDefined()
      expect(agent.name).toBe('test-agent')
      expect(agent.source).toBe('user')
    })

    test('创建的 agent 应该出现在 agent 列表中', async () => {
      await page.evaluate(async () => {
        await (window as any).trpc.test.agents.create.mutate({
          name: 'list-test-agent',
          description: 'List test',
          prompt: 'Test prompt',
          source: 'user',
        })
      })

      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.agents.list.query()
      })

      const names = agents.map((a: any) => a.name)
      expect(names).toContain('list-test-agent')
    })
  })

  describe('Agent 删除', () => {
    test('应该能够删除 agent', async () => {
      await page.evaluate(async () => {
        await (window as any).trpc.test.agents.create.mutate({
          name: 'delete-test-agent',
          description: 'Delete test',
          prompt: 'Test prompt',
          source: 'user',
        })
      })

      // 验证文件存在
      const agentPath = path.join(os.homedir(), '.claude', 'agents', 'delete-test-agent.md')
      let exists = await fs.access(agentPath).then(() => true).catch(() => false)
      expect(exists).toBe(true)

      // 删除 agent (需要 source 字段)
      await page.evaluate(async () => {
        await (window as any).trpc.test.agents.delete.mutate({
          name: 'delete-test-agent',
          source: 'user',
        })
      })

      // 验证文件已删除
      exists = await fs.access(agentPath).then(() => true).catch(() => false)
      expect(exists).toBe(false)

      // 验证列表不包含该 agent
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.agents.list.query()
      })
      const names = agents.map((a: any) => a.name)
      expect(names).not.toContain('delete-test-agent')
    })
  })

  describe('多 Agent 管理', () => {
    test('应该能够创建多个 agent', async () => {
      await page.evaluate(async () => {
        await (window as any).trpc.test.agents.create.mutate({
          name: 'agent-1',
          description: 'Agent 1',
          prompt: 'Prompt 1',
          source: 'user',
        })
        await (window as any).trpc.test.agents.create.mutate({
          name: 'agent-2',
          description: 'Agent 2',
          prompt: 'Prompt 2',
          source: 'user',
        })
        await (window as any).trpc.test.agents.create.mutate({
          name: 'agent-3',
          description: 'Agent 3',
          prompt: 'Prompt 3',
          source: 'user',
        })
      })

      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.test.agents.list.query()
      })

      const names = agents.map((a: any) => a.name)
      expect(names).toContain('agent-1')
      expect(names).toContain('agent-2')
      expect(names).toContain('agent-3')
    })
  })
})
