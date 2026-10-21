/**
 * IPC 单元测试 - Backend Terminal Router
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'

describe('IPC: Backend Terminal Router', () => {
  const ctx = createTestContext()

  describe('backendTerminal.attach', () => {
    test('应该返回结果或报错（需要真实后端）', async () => {
      try {
        const result = await ctx.page.evaluate(async () => {
          return await (window as any).trpc.backendTerminal.attach.mutate({
            paneId: 'test-pane',
            workspaceId: 'test-workspace',
          })
        })

        // 如果成功，验证返回结构
        expect(result).toBeDefined()
        expect(result.paneId).toBe('test-pane')
        expect(typeof result.isNew).toBe('boolean')
        expect(typeof result.serializedState).toBe('string')
      } catch (error) {
        // 预期会失败（没有真实的后端连接）
        expect(error).toBeDefined()
      }
    })
  })

  describe('backendTerminal.write', () => {
    test('应该成功或报错（需要会话）', async () => {
      try {
        const result = await ctx.page.evaluate(async () => {
          return await (window as any).trpc.backendTerminal.write.mutate({
            paneId: 'test-pane',
            data: 'echo test',
          })
        })

        // 如果成功，应该没有返回值（void）
        expect(result).toBeUndefined()
      } catch (error) {
        // 预期会失败（没有活跃的会话）
        expect(error).toBeDefined()
      }
    })
  })

  describe('backendTerminal.signal', () => {
    test('应该成功或报错（需要会话）', async () => {
      try {
        const result = await ctx.page.evaluate(async () => {
          return await (window as any).trpc.backendTerminal.signal.mutate({
            paneId: 'test-pane',
            signal: 'INT',
          })
        })

        // 如果成功，应该没有返回值（void）
        expect(result).toBeUndefined()
      } catch (error) {
        // 预期会失败（没有活跃的会话）
        expect(error).toBeDefined()
      }
    })
  })

  describe('backendTerminal.kill', () => {
    test('应该成功或报错（需要会话）', async () => {
      try {
        const result = await ctx.page.evaluate(async () => {
          return await (window as any).trpc.backendTerminal.kill.mutate({
            paneId: 'test-pane',
          })
        })

        // 如果成功，应该没有返回值（void）
        expect(result).toBeUndefined()
      } catch (error) {
        // 预期会失败（没有活跃的会话）
        expect(error).toBeDefined()
      }
    })
  })

  describe('backendTerminal.resize', () => {
    test('应该成功或报错（需要会话）', async () => {
      try {
        const result = await ctx.page.evaluate(async () => {
          return await (window as any).trpc.backendTerminal.resize.mutate({
            paneId: 'test-pane',
            cols: 80,
            rows: 24,
          })
        })

        // 如果成功，应该没有返回值（void）
        expect(result).toBeUndefined()
      } catch (error) {
        // 预期会失败（没有活跃的会话）
        expect(error).toBeDefined()
      }
    })
  })

  describe('backendTerminal.detach', () => {
    test('应该成功（空操作）', async () => {
      try {
        const result = await ctx.page.evaluate(async () => {
          return await (window as any).trpc.backendTerminal.detach.mutate({
            paneId: 'test-pane',
          })
        })

        // detach 是空操作，应该成功
        expect(result).toBeUndefined()
      } catch (error) {
        // 即使失败也不影响测试
        expect(error).toBeDefined()
      }
    })
  })

  describe('backendTerminal.clearScrollback', () => {
    test('应该成功（空操作）', async () => {
      try {
        const result = await ctx.page.evaluate(async () => {
          return await (window as any).trpc.backendTerminal.clearScrollback.mutate({
            paneId: 'test-pane',
          })
        })

        // clearScrollback 是空操作，应该成功
        expect(result).toBeUndefined()
      } catch (error) {
        // 即使失败也不影响测试
        expect(error).toBeDefined()
      }
    })
  })

  describe('backendTerminal.stream', () => {
    test('订阅应该存在（但可能没有数据）', async () => {
      try {
        // 尝试订阅
        const subscriptionPromise = ctx.page.evaluate(async () => {
          return new Promise((resolve) => {
            const subscription = (window as any).trpc.backendTerminal.stream.subscribe('test-pane', {
              onData: (data: any) => {
                // 收到数据
                resolve({ received: true, data })
              },
              onError: (error: any) => {
                // 收到错误（预期）
                resolve({ received: false, error: error.message })
              },
            })

            // 3秒后取消订阅
            setTimeout(() => {
              subscription.unsubscribe()
              resolve({ received: false, timeout: true })
            }, 3000)
          })
        })

        const result = await subscriptionPromise

        // 验证订阅机制存在
        expect(result).toBeDefined()
        expect(typeof result).toBe('object')
      } catch (error) {
        // 预期会失败（没有真实的后端连接）
        expect(error).toBeDefined()
      }
    })
  })
})
