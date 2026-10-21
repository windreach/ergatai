/**
 * E2E UI 测试 - Agent Profile 注册表
 * 验证 CLAUDE.md 描述的 AgentProfile 模板注册与管理
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration } from '../../fixtures/integration-launcher'

describe('E2E: Agent Profile 注册表', () => {
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

  describe('Profile 注册', () => {
    test('应该能够注册新的 agent profile', async () => {
      const profile = await page.evaluate(async () => {
        return await (window as any).trpc.test.agentProfiles.register.mutate({
          name: 'test-claude',
          command: 'claude',
          agent_type: 'acp',
        })
      })

      expect(profile).toBeDefined()
      expect(profile.name).toBe('test-claude')
      expect(profile.command).toBe('claude')
      expect(profile.agent_type).toBe('acp')
    })

    test('注册时可以包含 instruction', async () => {
      const profile = await page.evaluate(async () => {
        return await (window as any).trpc.test.agentProfiles.register.mutate({
          name: 'instructed-agent',
          command: 'claude',
          agent_type: 'acp',
          instruction: 'You are a helpful coding assistant',
        })
      })

      expect(profile).toBeDefined()
      expect(profile.instruction).toBe('You are a helpful coding assistant')
    })

    test('注册时可以包含 env_overrides', async () => {
      const profile = await page.evaluate(async () => {
        return await (window as any).trpc.test.agentProfiles.register.mutate({
          name: 'env-agent',
          command: 'claude',
          agent_type: 'acp',
          env_overrides: { ANTHROPIC_MODEL: 'claude-sonnet-4-20250514' },
        })
      })

      expect(profile).toBeDefined()
      expect(profile.env_overrides).toBeDefined()
      expect(profile.env_overrides.ANTHROPIC_MODEL).toBe('claude-sonnet-4-20250514')
    })

    test('重复注册同名 profile 应该被拒绝', async () => {
      await page.evaluate(async () => {
        await (window as any).trpc.test.agentProfiles.register.mutate({
          name: 'duplicate-agent',
          command: 'claude',
          agent_type: 'acp',
        })
      })

      await expect(page.evaluate(async () => {
        await (window as any).trpc.test.agentProfiles.register.mutate({
          name: 'duplicate-agent',
          command: 'cursor',
          agent_type: 'acp',
        })
      })).rejects.toThrow()
    })
  })

  describe('Profile 查询', () => {
    test('应该能够列出所有注册的 profiles', async () => {
      await page.evaluate(async () => {
        await (window as any).trpc.test.agentProfiles.register.mutate({
          name: 'list-agent-1',
          command: 'claude',
          agent_type: 'acp',
        })
        await (window as any).trpc.test.agentProfiles.register.mutate({
          name: 'list-agent-2',
          command: 'cursor',
          agent_type: 'acp',
        })
      })

      const profiles = await page.evaluate(async () => {
        return await (window as any).trpc.test.agentProfiles.list.query()
      })

      expect(Array.isArray(profiles)).toBe(true)
      expect(profiles.length).toBeGreaterThanOrEqual(2)

      const names = profiles.map((p: any) => p.name)
      expect(names).toContain('list-agent-1')
      expect(names).toContain('list-agent-2')
    })

    test('应该能够通过 name 获取特定 profile', async () => {
      await page.evaluate(async () => {
        await (window as any).trpc.test.agentProfiles.register.mutate({
          name: 'get-test-agent',
          command: 'claude',
          agent_type: 'acp',
          instruction: 'Test instruction',
        })
      })

      const profile = await page.evaluate(async () => {
        return await (window as any).trpc.test.agentProfiles.get.query({
          name: 'get-test-agent',
        })
      })

      expect(profile).toBeDefined()
      expect(profile.name).toBe('get-test-agent')
      expect(profile.command).toBe('claude')
      expect(profile.instruction).toBe('Test instruction')
    })

    test('查询不存在的 profile 应该抛出错误', async () => {
      await expect(page.evaluate(async () => {
        return await (window as any).trpc.test.agentProfiles.get.query({
          name: 'nonexistent-profile',
        })
      })).rejects.toThrow()
    })
  })

  describe('Profile 删除', () => {
    test('应该能够删除已注册的 profile', async () => {
      await page.evaluate(async () => {
        await (window as any).trpc.test.agentProfiles.register.mutate({
          name: 'delete-me-agent',
          command: 'claude',
          agent_type: 'acp',
        })
      })

      const before = await page.evaluate(async () => {
        return await (window as any).trpc.test.agentProfiles.list.query()
      })
      expect(before.find((p: any) => p.name === 'delete-me-agent')).toBeDefined()

      await page.evaluate(async () => {
        await (window as any).trpc.test.agentProfiles.delete.mutate({ name: 'delete-me-agent' })
      })

      const after = await page.evaluate(async () => {
        return await (window as any).trpc.test.agentProfiles.list.query()
      })
      expect(after.find((p: any) => p.name === 'delete-me-agent')).toBeUndefined()
    })

    test('删除不存在的 profile 应该幂等', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.agentProfiles.delete.mutate({ name: 'ghost-agent' })
      })

      expect(result.success).toBe(true)
    })
  })

  describe('多 Profile 管理', () => {
    test('应该支持多种 agent 类型', async () => {
      await page.evaluate(async () => {
        await (window as any).trpc.test.agentProfiles.register.mutate({
          name: 'claude-profile', command: 'claude', agent_type: 'acp',
        })
        await (window as any).trpc.test.agentProfiles.register.mutate({
          name: 'cursor-profile', command: 'cursor-agent', agent_type: 'acp',
        })
        await (window as any).trpc.test.agentProfiles.register.mutate({
          name: 'codex-profile', command: 'codex', agent_type: 'acp',
        })
      })

      const profiles = await page.evaluate(async () => {
        return await (window as any).trpc.test.agentProfiles.list.query()
      })

      expect(profiles.length).toBeGreaterThanOrEqual(3)
      const commands = profiles.map((p: any) => p.command)
      expect(commands).toContain('claude')
      expect(commands).toContain('cursor-agent')
      expect(commands).toContain('codex')
    })
  })
})
