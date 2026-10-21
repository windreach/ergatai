/**
 * IPC 单元测试 - Group Chat Router
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'

describe('IPC: Group Chat Router', () => {
  const ctx = createTestContext()

  describe('groupChat.listMembers', () => {
    test('应该返回数组', async () => {
      const members = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.groupChat.listMembers.query({ chatId: 'test-chat' })
      })

      expect(Array.isArray(members)).toBe(true)
    })
  })

  describe('groupChat.addMember', () => {
    test('应该抛出错误（已禁用）', async () => {
      await expect(
        ctx.page.evaluate(async () => {
          return await (window as any).trpc.groupChat.addMember.mutate({
            chatId: 'test',
            agentCommand: 'test',
            agentName: 'test',
          })
        })
      ).rejects.toThrow('no longer supported')
    })
  })

  describe('groupChat.removeMember', () => {
    test('应该抛出错误（已禁用）', async () => {
      await expect(
        ctx.page.evaluate(async () => {
          return await (window as any).trpc.groupChat.removeMember.mutate({
            chatId: 'test',
            agentId: 'test-agent',
          })
        })
      ).rejects.toThrow('no longer supported')
    })
  })

  describe('groupChat.sendToAgent', () => {
    test('应该成功或因为后端问题而失败', async () => {
      try {
        const result = await ctx.page.evaluate(async () => {
          return await (window as any).trpc.groupChat.sendToAgent.mutate({
            chatId: 'test-chat',
            agentCommand: 'test-agent',
            message: 'test message',
          })
        })

        // 如果成功，验证返回结构
        expect(result).toBeDefined()
        expect(typeof result.success).toBe('boolean')
        expect(typeof result.conversationId).toBe('string')
      } catch (error) {
        // 预期会失败（没有真实的 agent 会话）
        expect(error).toBeDefined()
        const errorMessage = error instanceof Error ? error.message : String(error)
        expect(errorMessage).toContain('no active session')
      }
    })
  })
})
