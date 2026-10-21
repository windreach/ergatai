/**
 * Integration Test - Agent 对话交互
 * 测试与真实 agent 的消息发送和响应
 *
 * 使用 Python mock ACP agent 测试完整的对话流程
 */

import { test, expect, describe, beforeAll, afterAll } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration, api, waitFor } from '../../fixtures/integration-launcher'
import * as fs from 'fs/promises'
import * as path from 'path'

describe('Integration: Agent 对话交互（真实后端）', () => {
  let electron: any
  let page: any
  const testWorkDir = '/tmp/ergatai-integration-conversation-test'
  const spawnedAgentIds: string[] = []
  let testWorkspaceId: string | null = null
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
      console.log('Mock agent profile already exists or registration failed')
    }

    // 创建一个 workspace
    const workspace = await api.createWorkspace({
      name: 'conversation-test-workspace',
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

  describe('Agent 消息发送', () => {
    test('应该能够向 agent 发送消息', async () => {
      // 先 spawn 一个 agent
      const spawnResult = await api.spawnAgent({
        command: 'mock-agent',
        workspace_id: testWorkspaceId!,
        work_dir: testWorkDir,
      })
      console.log('Spawn result:', spawnResult)
      const agentId = spawnResult.agent_id
      expect(agentId).toBeDefined()
      spawnedAgentIds.push(agentId)

      // 等待一小段时间让 agent 初始化
      await new Promise(resolve => setTimeout(resolve, 2000))

      // 发送消息
      const sendResult = await api.sendMessage(agentId, '你好，请介绍一下自己')
      expect(sendResult).toBeDefined()
      expect(sendResult.status).toBe('queued')
    })

    test('应该能够通过 tRPC 向 agent 发送消息', async () => {
      // Spawn agent
      const spawnResult = await page.evaluate(async (args: { workDir: string; workspaceId: string }) => {
        return await (window as any).trpc.ergatai.spawnAgent.mutate({
          command: 'mock-agent',
          workDir: args.workDir,
          workspaceId: args.workspaceId,
        })
      }, { workDir: testWorkDir, workspaceId: testWorkspaceId! })
      spawnedAgentIds.push(spawnResult.agent_id)

      // 等待 agent 初始化
      await new Promise(resolve => setTimeout(resolve, 2000))

      // 发送消息
      const sendResult = await page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.ergatai.sendMessage.mutate({
          agentId,
          message: '帮助我完成一个任务',
        })
      }, spawnResult.agent_id)

      console.log('tRPC send result:', sendResult)
      expect(sendResult).toBeDefined()
      expect(sendResult.success || sendResult.status === 'queued').toBeTruthy()
    })
  })

  describe('多轮对话', () => {
    test('应该能够与 agent 进行多轮对话', async () => {
      // Spawn agent
      const spawnResult = await api.spawnAgent({
        command: 'mock-agent',
        workspace_id: testWorkspaceId!,
        work_dir: testWorkDir,
      })
      const agentId = spawnResult.agent_id
      spawnedAgentIds.push(agentId)

      // 等待 agent 初始化
      await new Promise(resolve => setTimeout(resolve, 2000))

      // 第一轮对话
      const msg1 = await api.sendMessage(agentId, '你好')
      expect(msg1.status).toBe('queued')

      // 等待 agent 响应
      await new Promise(resolve => setTimeout(resolve, 1000))

      // 第二轮对话
      const msg2 = await api.sendMessage(agentId, '你能做什么？')
      expect(msg2.status).toBe('queued')
    })
  })

  describe('Agent 间通信', () => {
    test('应该能够 spawn 多个 agent 并进行通信', async () => {
      // Spawn 两个 agent
      const [agent1, agent2] = await Promise.all([
        api.spawnAgent({ command: 'mock-agent', workspace_id: testWorkspaceId!, work_dir: testWorkDir }),
        api.spawnAgent({ command: 'mock-agent', workspace_id: testWorkspaceId!, work_dir: testWorkDir }),
      ])

      spawnedAgentIds.push(agent1.agent_id, agent2.agent_id)

      // 等待 agent 初始化
      await new Promise(resolve => setTimeout(resolve, 2000))

      // 向两个 agent 发送消息
      const msg1 = await api.sendMessage(agent1.agent_id, '你是 agent 1')
      const msg2 = await api.sendMessage(agent2.agent_id, '你是 agent 2')

      expect(msg1.status).toBe('queued')
      expect(msg2.status).toBe('queued')
    })
  })
})
