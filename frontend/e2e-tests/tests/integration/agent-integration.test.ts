/**
 * Integration Test - Agent 生命周期
 * 测试真实后端的 agent spawn/kill 操作
 *
 * 使用 Python mock ACP agent (scripts/mock-acp-agent.py) 进行测试
 */

import { test, expect, describe, beforeAll, afterAll } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration, api, waitFor } from '../../fixtures/integration-launcher'
import * as fs from 'fs/promises'
import * as path from 'path'

describe('Integration: Agent 生命周期（真实后端）', () => {
  let electron: any
  let page: any
  const testWorkDir = '/tmp/ergatai-integration-agent-test'
  const spawnedAgentIds: string[] = []
  let testWorkspaceId: string | null = null

  // Mock agent 命令（使用 Python 脚本）
  const MOCK_AGENT_COMMAND = 'python3'
  const MOCK_AGENT_SCRIPT = path.resolve(__dirname, '../../../../scripts/mock-acp-agent.py')

  beforeAll(async () => {
    await fs.mkdir(testWorkDir, { recursive: true })

    const env = await launchIntegrationElectron()
    electron = env.electron
    page = env.page

    // 注册 mock agent profile
    try {
      await api.registerAgentProfile({
        name: 'mock-agent',
        command: MOCK_AGENT_SCRIPT,
        agent_type: 'acp',
      })
      console.log('✅ Mock agent profile registered')
    } catch (e) {
      // Profile might already exist, that's OK
      console.log('Mock agent profile already exists or registration failed:', e)
    }

    // 创建一个 workspace 用于 agent 测试
    const workspace = await api.createWorkspace({
      name: 'agent-test-workspace',
      work_dir: testWorkDir,
    })
    testWorkspaceId = workspace.workspace_id || workspace.id
  })

  afterAll(async () => {
    for (const id of spawnedAgentIds) {
      await api.killAgent(id).catch(() => {})
    }
    if (testWorkspaceId) {
      await api.deleteWorkspace(testWorkspaceId).catch(() => {})
    }
    await fs.rm(testWorkDir, { recursive: true, force: true }).catch(() => {})
    await cleanupIntegration(electron)
  })

  describe('Agent Spawn (REST API)', () => {
    test('应该能够通过 REST API spawn agent', async () => {
      const result = await api.spawnAgent({
        command: 'mock-agent',
        workspace_id: testWorkspaceId!,
        work_dir: testWorkDir,
      })

      console.log('Spawn result:', JSON.stringify(result, null, 2))
      expect(result).toBeDefined()
      const agentId = result.agent_id || result.agentId
      expect(agentId).toBeDefined()
      if (agentId) spawnedAgentIds.push(agentId)
    })

    test('spawn 的 agent 应该出现在 agent 列表中', async () => {
      const result = await api.spawnAgent({
        command: 'mock-agent',
        workspace_id: testWorkspaceId!,
        work_dir: testWorkDir,
      })
      const agentId = result.agent_id || result.agentId
      if (agentId) spawnedAgentIds.push(agentId)

      // 等待 agent 注册
      await waitFor(async () => {
        const agents = await api.listAgents()
        const ids = agents.map((a: any) => a.agent_id || a.id)
        return ids.includes(agentId) ? true : null
      }, { timeout: 10000, message: 'Agent not found in list' })

      const agents = await api.listAgents()
      expect(Array.isArray(agents)).toBe(true)
      const ids = agents.map((a: any) => a.agent_id || a.id)
      expect(ids).toContain(agentId)
    })

    test('应该能够通过 REST API kill agent', async () => {
      const result = await api.spawnAgent({
        command: 'mock-agent',
        workspace_id: testWorkspaceId!,
        work_dir: testWorkDir,
      })
      const agentId = result.agent_id || result.agentId
      expect(agentId).toBeDefined()

      const status = await api.killAgent(agentId)
      expect(status).toBe(204)
    })
  })

  describe('Agent Spawn (tRPC via Electron)', () => {
    test('应该能够通过 tRPC spawn agent', async () => {
      const result = await page.evaluate(async (args: { workDir: string; workspaceId: string }) => {
        return await (window as any).trpc.ergatai.spawnAgent.mutate({
          command: 'mock-agent',
          workDir: args.workDir,
          workspaceId: args.workspaceId,
        })
      }, { workDir: testWorkDir, workspaceId: testWorkspaceId! })

      expect(result).toBeDefined()
      expect(result.agent_id).toBeDefined()
      spawnedAgentIds.push(result.agent_id)
    })

    test('tRPC spawn 的 agent 应该出现在 REST API 列表中', async () => {
      const result = await page.evaluate(async (args: { workDir: string; workspaceId: string }) => {
        return await (window as any).trpc.ergatai.spawnAgent.mutate({
          command: 'mock-agent',
          workDir: args.workDir,
          workspaceId: args.workspaceId,
        })
      }, { workDir: testWorkDir, workspaceId: testWorkspaceId! })
      spawnedAgentIds.push(result.agent_id)

      await waitFor(async () => {
        const agents = await api.listAgents()
        const ids = agents.map((a: any) => a.agent_id || a.id)
        return ids.includes(result.agent_id) ? true : null
      }, { timeout: 10000, message: 'Agent not found in list' })
    })

    test('应该能够通过 tRPC kill agent', async () => {
      const result = await page.evaluate(async (args: { workDir: string; workspaceId: string }) => {
        return await (window as any).trpc.ergatai.spawnAgent.mutate({
          command: 'mock-agent',
          workDir: args.workDir,
          workspaceId: args.workspaceId,
        })
      }, { workDir: testWorkDir, workspaceId: testWorkspaceId! })

      const killResult = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.ergatai.killAgent.mutate({ agentId })
      }, result.agent_id)

      expect(killResult.success).toBe(true)
    })
  })

  describe('多 Agent 管理', () => {
    test('应该能够同时 spawn 多个 agent', async () => {
      const results = await Promise.all([
        api.spawnAgent({ command: 'mock-agent', workspace_id: testWorkspaceId!, work_dir: testWorkDir }),
        api.spawnAgent({ command: 'mock-agent', workspace_id: testWorkspaceId!, work_dir: testWorkDir }),
        api.spawnAgent({ command: 'mock-agent', workspace_id: testWorkspaceId!, work_dir: testWorkDir }),
      ])

      for (const result of results) {
        const agentId = result.agent_id || result.agentId
        if (agentId) spawnedAgentIds.push(agentId)
      }

      // 等待所有 agent 注册
      await waitFor(async () => {
        const agents = await api.listAgents()
        return agents.length >= 3 ? true : null
      }, { timeout: 10000, message: 'Not all agents registered' })

      const agents = await api.listAgents()
      expect(agents.length).toBeGreaterThanOrEqual(3)
    })
  })
})
