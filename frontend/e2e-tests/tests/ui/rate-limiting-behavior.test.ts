/**
 * E2E UI 测试 - Agent 速率限制行为
 * 验证 CLAUDE.md 描述的 60 msg/min/agent 滑动窗口速率限制
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration } from '../../fixtures/integration-launcher'

describe('E2E: Agent 速率限制行为', () => {
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

  describe('基础速率检查', () => {
    test('首次请求应该被允许', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.rateLimiter.checkRate.query({
          agentId: 'test-agent-1',
        })
      })

      expect(result.allowed).toBe(true)
      expect(result.remaining).toBeGreaterThan(0)
      expect(result.remaining).toBeLessThanOrEqual(60)
      expect(result.resetAt).toBeDefined()
    })

    test('不同 agent 应该有独立的速率窗口', async () => {
      for (let i = 0; i < 10; i++) {
        await page.evaluate(async () => {
          await (window as any).trpc.test.rateLimiter.checkRate.query({
            agentId: 'test-agent-1',
          })
        })
      }

      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.rateLimiter.checkRate.query({
          agentId: 'test-agent-2',
        })
      })

      expect(result.allowed).toBe(true)
      expect(result.remaining).toBeGreaterThanOrEqual(59)
    })
  })

  describe('配额递减', () => {
    test('每次请求 remaining 应该递减', async () => {
      const agentId = 'decrement-test-agent'
      const results = []

      for (let i = 0; i < 5; i++) {
        const result = await page.evaluate(async (id: string) => {
          return await (window as any).trpc.test.rateLimiter.checkRate.query({ agentId: id })
        }, agentId)
        results.push(result)
      }

      for (let i = 1; i < results.length; i++) {
        expect(results[i].remaining).toBeLessThan(results[i - 1].remaining)
      }
      results.forEach(r => expect(r.allowed).toBe(true))
    })

    test('remaining 初始值应为 59（首次请求后）', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.rateLimiter.checkRate.query({
          agentId: 'fresh-agent',
        })
      })

      expect(result.remaining).toBe(59)
    })
  })

  describe('速率限制触发', () => {
    test('超过 60 次请求应该被拒绝', async () => {
      const agentId = 'rate-limit-test-agent'

      for (let i = 0; i < 60; i++) {
        await page.evaluate(async (id: string) => {
          await (window as any).trpc.test.rateLimiter.checkRate.query({ agentId: id })
        }, agentId)
      }

      const result = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.rateLimiter.checkRate.query({ agentId: id })
      }, agentId)

      expect(result.allowed).toBe(false)
      expect(result.remaining).toBe(0)
    })

    test('被拒绝的请求不应使 remaining 变为负数', async () => {
      const agentId = 'no-negative-agent'

      for (let i = 0; i < 65; i++) {
        await page.evaluate(async (id: string) => {
          await (window as any).trpc.test.rateLimiter.checkRate.query({ agentId: id })
        }, agentId)
      }

      const result = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.rateLimiter.checkRate.query({ agentId: id })
      }, agentId)

      expect(result.remaining).toBeGreaterThanOrEqual(0)
      expect(result.allowed).toBe(false)
    })
  })

  describe('resetAt 时间戳', () => {
    test('resetAt 应该是合法时间字符串', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.rateLimiter.checkRate.query({
          agentId: 'timestamp-agent',
        })
      })

      const resetAt = new Date(result.resetAt)
      expect(resetAt.getTime()).not.toBeNaN()
    })

    test('同一窗口内 resetAt 应该一致', async () => {
      const agentId = 'consistent-reset-agent'

      const r1 = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.rateLimiter.checkRate.query({ agentId: id })
      }, agentId)

      const r2 = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.rateLimiter.checkRate.query({ agentId: id })
      }, agentId)

      expect(r1.resetAt).toBe(r2.resetAt)
    })
  })
})
