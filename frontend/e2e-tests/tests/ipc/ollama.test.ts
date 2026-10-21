/**
 * IPC 单元测试 - Ollama Router
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'

describe('IPC: Ollama Router', () => {
  const ctx = createTestContext()

  describe('ollama.getConfig', () => {
    test('应该返回配置对象', async () => {
      const config = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.ollama.getConfig.query()
      })

      expect(config).toBeDefined()
      expect(typeof config).toBe('object')
      expect(typeof config.baseUrl).toBe('string')
      expect(config.baseUrl.length).toBeGreaterThan(0)
    })
  })

  describe('ollama.getStatus', () => {
    test('应该返回状态', async () => {
      const status = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.ollama.getStatus.query()
      })

      expect(status).toBeDefined()
      expect(typeof status).toBe('object')
      expect(status.ollama).toBeDefined()
      expect(typeof status.ollama.available).toBe('boolean')
      expect(Array.isArray(status.ollama.models)).toBe(true)
      expect(status.internet).toBeDefined()
      expect(typeof status.internet.online).toBe('boolean')
      expect(typeof status.internet.checked).toBe('number')
    })
  })

  describe('ollama.isOfflineModeAvailable', () => {
    test('应该返回可用性对象', async () => {
      const availability = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.ollama.isOfflineModeAvailable.query()
      })

      expect(availability).toBeDefined()
      expect(typeof availability).toBe('object')
      expect(typeof availability.available).toBe('boolean')
      // model 可以是 string, null, 或 undefined
      expect(availability.model === null || availability.model === undefined || typeof availability.model === 'string').toBe(true)
    })
  })

  describe('ollama.getModels', () => {
    test('应该返回模型列表', async () => {
      const models = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.ollama.getModels.query()
      })

      expect(models).toBeDefined()
      expect(typeof models).toBe('object')
      expect(typeof models.available).toBe('boolean')
      expect(Array.isArray(models.models)).toBe(true)
      // recommendedModel 可以是 string, null, 或 undefined
      expect(models.recommendedModel === null || models.recommendedModel === undefined || typeof models.recommendedModel === 'string').toBe(true)
    })
  })

  describe('ollama.generateCommitMessage', () => {
    test('应该报错或返回 null（需要 Ollama 服务）', async () => {
      try {
        const result = await ctx.page.evaluate(async () => {
          return await (window as any).trpc.ollama.generateCommitMessage.mutate({
            diff: 'test diff content',
            fileCount: 1,
            additions: 10,
            deletions: 5,
          })
        })

        // 如果成功但没有 Ollama 服务，应该返回 null message
        expect(result).toBeDefined()
        expect(typeof result).toBe('object')
        expect(result.message === null || typeof result.message === 'string').toBe(true)
      } catch (error) {
        // 预期会失败（没有 Ollama 服务）
        expect(error).toBeDefined()
      }
    })
  })
})
