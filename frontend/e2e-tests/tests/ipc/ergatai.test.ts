/**
 * IPC 单元测试 - Ergatai Router (Mock)
 *
 * 测试 ergatai router 的 mock 实现，通过 window.trpc.test.ergatai.* 调用。
 * 这个 mock 在内存中维护数据，不调用真实的 Ergatai 后端 API。
 *
 * 测试范围（约 27 个测试）：
 * - Agent 管理（6 个）：listAgents、spawnAgent、getAgent、killAgent、sendMessage、promptAgent
 * - Conversation 管理（4 个）：listConversations、createConversation、getConversation、deleteConversation
 * - Workspace 管理（4 个）：listManagedWorkspaces、getManagedWorkspace、createManagedWorkspace、deleteManagedWorkspaces
 * - DAG/编排（2 个）：validateDagYaml、getDagStatus
 * - System（2 个）：getSystemStatus、getStats
 * - 错误处理（3 个）
 * - 清理（1 个）
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'

describe('IPC: Ergatai Router (Mock)', () => {
  const ctx = createTestContext()

  describe('Agent 管理', () => {
    test('listAgents 应该返回数组', async () => {
      const agents = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })

      expect(Array.isArray(agents)).toBe(true)
    })

    test('listAgents 应该返回 agent 详细信息', async () => {
      // 先创建一个 agent
      const spawned = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'claude',
          workspaceId: 'test-workspace-details',
        })
      })

      const agents = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })

      expect(agents.length).toBeGreaterThan(0)
      const agent = agents.find((a: any) => a.agent_id === spawned.agent_id)
      expect(agent).toBeDefined()
      // Agent 应该包含基本字段
      expect(agent.agent_id).toBeDefined()
      expect(agent.command).toBeDefined()
    })

    test('spawnAgent 应该创建 agent', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'claude',
          workspaceId: 'test-workspace',
          instruction: 'You are a test agent',
        })
      })

      expect(result).toBeDefined()
      expect(result.agent_id).toBeDefined()
      expect(typeof result.agent_id).toBe('string')

      // 验证 agent 已被添加到列表
      const agents = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })

      const found = agents.find((a: any) => a.agent_id === result.agent_id)
      expect(found).toBeDefined()
    })

    test('getAgent 应该获取 agent', async () => {
      // 先创建一个 agent
      const spawned = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'claude',
          workspaceId: 'test-workspace',
        })
      })

      const agent = await ctx.page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.getAgent.query({ agentId })
      }, spawned.agent_id)

      expect(agent).toBeDefined()
      expect(agent.agent_id).toBe(spawned.agent_id)
    })

    test('killAgent 应该删除 agent', async () => {
      // 先创建一个 agent
      const spawned = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'claude',
          workspaceId: 'test-workspace',
        })
      })

      const killResult = await ctx.page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.killAgent.mutate({ agentId })
      }, spawned.agent_id)

      expect(killResult.success).toBe(true)

      // 验证 agent 已从列表移除
      const agents = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })

      const found = agents.find((a: any) => a.agent_id === spawned.agent_id)
      expect(found).toBeUndefined()
    })

    test('sendMessage 应该成功', async () => {
      // 先创建一个 agent
      const spawned = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'claude',
          workspaceId: 'test-workspace',
        })
      })

      const result = await ctx.page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.sendMessage.mutate({
          agentId,
          message: 'Hello from test',
          messageType: 'request',
        })
      }, spawned.agent_id)

      expect(result).toBeDefined()
      expect(result.status).toBe('queued')
    })

    test('promptAgent 应该成功', async () => {
      // 先创建一个 agent
      const spawned = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'claude',
          workspaceId: 'test-workspace',
        })
      })

      const result = await ctx.page.evaluate(async (agentId: string) => {
        return await (window as any).trpc.test.ergatai.promptAgent.mutate({
          agentId,
          prompt: 'Please complete this task',
        })
      }, spawned.agent_id)

      expect(result).toBeDefined()
      expect(result.status).toBe('queued')
    })

    test('spawnAgent 应该支持可选参数', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'claude',
          workspaceId: 'test-workspace-opts',
          conversationId: 'test-conv-opts',
          instruction: 'You are a specialized agent',
          workDir: '/tmp/test-agent-work',
          env: { CUSTOM_VAR: 'value' },
        })
      })

      expect(result).toBeDefined()
      expect(result.agent_id).toBeDefined()
    })
  })

  describe('Conversation 管理', () => {
    test('listConversations 应该返回数组', async () => {
      const conversations = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listConversations.query()
      })

      expect(Array.isArray(conversations)).toBe(true)
    })

    test('createConversation 应该创建对话', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'Test Conversation',
          chatId: 'test-chat-1',
        })
      })

      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      expect(typeof result.id).toBe('string')

      // 验证对话已添加到列表
      const conversations = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listConversations.query()
      })

      const found = conversations.find((c: any) => c.id === result.id)
      expect(found).toBeDefined()
    })

    test('createConversation 应该支持可选字段', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'Test with Options',
          chatId: 'test-chat-opts',
        })
      })

      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
    })

    test('getConversation 应该获取对话', async () => {
      // 先创建对话
      const created = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'Get Test',
          chatId: 'test-chat-get',
        })
      })

      const conversation = await ctx.page.evaluate(async (conversationId: string) => {
        return await (window as any).trpc.test.ergatai.getConversation.query({ id: conversationId })
      }, created.id)

      expect(conversation).toBeDefined()
      expect(conversation.id).toBe(created.id)
    })

    test('deleteConversation 应该删除对话', async () => {
      // 先创建对话
      const created = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'Delete Test',
          chatId: 'test-chat-delete',
        })
      })

      const deleteResult = await ctx.page.evaluate(async (conversationId: string) => {
        return await (window as any).trpc.test.ergatai.deleteConversation.mutate({ id: conversationId })
      }, created.id)

      expect(deleteResult.success).toBe(true)

      // 验证对话已从列表移除
      const conversations = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listConversations.query()
      })

      const found = conversations.find((c: any) => c.id === created.id)
      expect(found).toBeUndefined()
    })
  })

  describe('Workspace 管理', () => {
    test('listManagedWorkspaces 应该返回数组', async () => {
      const workspaces = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listManagedWorkspaces.query()
      })

      expect(Array.isArray(workspaces)).toBe(true)
    })

    test('getManagedWorkspace 应该获取 workspace', async () => {
      // 先创建 workspace
      const created = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createManagedWorkspace.mutate({
          name: 'test-workspace-get',
          workDir: '/tmp/test-ws-get',
        })
      })

      const workspace = await ctx.page.evaluate(async (workspaceId: string) => {
        return await (window as any).trpc.test.ergatai.getManagedWorkspace.query({ id: workspaceId })
      }, created.id)

      expect(workspace).toBeDefined()
      expect(workspace.id).toBe(created.id)
      expect(workspace.name).toBe('test-workspace-get')
    })

    test('createManagedWorkspace 应该创建 workspace', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createManagedWorkspace.mutate({
          name: 'test-workspace-1',
          workDir: '/tmp/test-workspace-1',
        })
      })

      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      expect(typeof result.id).toBe('string')
      expect(result.name).toBe('test-workspace-1')

      // 验证 workspace 已添加到列表
      const workspaces = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listManagedWorkspaces.query()
      })

      const found = workspaces.find((w: any) => w.id === result.id)
      expect(found).toBeDefined()
    })

    test('createManagedWorkspace 应该支持可选参数', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createManagedWorkspace.mutate({
          name: 'test-workspace-opts',
          workDir: '/tmp/test-ws-opts',
          env: { NODE_ENV: 'test' },
          resources: { cpu: '2', memory: '4G' },
        })
      })

      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      expect(result.name).toBe('test-workspace-opts')
    })

    test('deleteManagedWorkspaces 应该删除 workspace', async () => {
      // 先创建 workspace
      const created = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.createManagedWorkspace.mutate({
          name: 'test-workspace-delete',
          workDir: '/tmp/test-ws-delete',
        })
      })

      const deleteResult = await ctx.page.evaluate(async (workspaceId: string) => {
        return await (window as any).trpc.test.ergatai.deleteManagedWorkspaces.mutate({ workspaceId })
      }, created.id)

      expect(deleteResult.success).toBe(true)

      // 验证 workspace 已从列表移除
      const workspaces = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listManagedWorkspaces.query()
      })

      const found = workspaces.find((w: any) => w.id === created.id)
      expect(found).toBeUndefined()
    })
  })

  describe('DAG/编排', () => {
    test('validateDagYaml 应该验证 YAML', async () => {
      const validYaml = `
name: Test DAG
tasks:
  - name: task1
    agent: claude
    instruction: Do something
  - name: task2
    agent: claude
    instruction: Do something else
    depends_on:
      - task1
`
      const result = await ctx.page.evaluate(async (yaml: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml })
      }, validYaml)

      expect(result).toBeDefined()
      expect(result.valid).toBe(true)
    })

    test('validateDagYaml 应该拒绝无效 YAML', async () => {
      const invalidYaml = `
name: Invalid DAG
tasks:
  - name: task1
    agent: claude
  - name: task1
    agent: claude
`
      const result = await ctx.page.evaluate(async (yaml: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml })
      }, invalidYaml)

      expect(result).toBeDefined()
      // 无效 YAML 应该返回 valid: false 或错误信息
      expect(result.valid === false || result.error).toBeTruthy()
    })

    test('getDagStatus 应该返回状态', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.getDagStatus.query({
          dagId: 'test-dag-1',
        })
      })

      // DAG 可能不存在，mock 应返回 null 或空对象
      if (result) {
        expect(typeof result).toBe('object')
      } else {
        expect(result).toBeNull()
      }
    })
  })

  describe('System', () => {
    test('getSystemStatus 应该返回系统状态', async () => {
      const status = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.getSystemStatus.query()
      })

      expect(status).toBeDefined()
      expect(typeof status).toBe('object')
    })

    test('getStats 应该返回统计信息', async () => {
      const stats = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.getStats.query()
      })

      expect(stats).toBeDefined()
      expect(typeof stats).toBe('object')
    })
  })

  describe('错误处理', () => {
    test('获取不存在的 agent 应该报错或返回 null', async () => {
      await expect(
        ctx.page.evaluate(async () => {
          return await (window as any).trpc.test.ergatai.getAgent.query({
            agentId: 'non-existent-agent-id',
          })
        })
      ).rejects.toThrow('Agent not found')
    })

    test('获取不存在的 conversation 应该报错或返回 null', async () => {
      await expect(
        ctx.page.evaluate(async () => {
          return await (window as any).trpc.test.ergatai.getConversation.query({
            id: 'non-existent-conversation-id',
          })
        })
      ).rejects.toThrow('Conversation not found')
    })

    test('获取不存在的 workspace 应该报错或返回 null', async () => {
      await expect(
        ctx.page.evaluate(async () => {
          return await (window as any).trpc.test.ergatai.getManagedWorkspace.query({
            id: 'non-existent-workspace-id',
          })
        })
      ).rejects.toThrow('Workspace not found')
    })
  })

  describe('清理', () => {
    test('cleanup 应该清除所有测试数据', async () => {
      // 先创建一些数据
      await ctx.page.evaluate(async () => {
        await (window as any).trpc.test.ergatai.spawnAgent.mutate({
          command: 'claude',
          workspaceId: 'test-workspace',
        })
        await (window as any).trpc.test.ergatai.createConversation.mutate({
          name: 'Test',
          chatId: 'test-chat',
        })
        await (window as any).trpc.test.ergatai.createManagedWorkspace.mutate({
          name: 'test-workspace',
          workDir: '/tmp/test-ws',
        })
      })

      // 执行清理
      const cleanupResult = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.helpers.cleanup.mutate()
      })

      expect(cleanupResult).toBeDefined()

      // 验证所有数据已被清除
      const agents = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listAgents.query()
      })
      const conversations = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listConversations.query()
      })
      const workspaces = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.ergatai.listManagedWorkspaces.query()
      })

      expect(agents.length).toBe(0)
      expect(conversations.length).toBe(0)
      expect(workspaces.length).toBe(0)
    })
  })
})
