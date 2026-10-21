/**
 * IPC 单元测试 - Skills Router
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'

describe('IPC: Skills Router', () => {
  const ctx = createTestContext()

  describe('skills.list', () => {
    test('应该返回空数组', async () => {
      const skills = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.skills.list.query()
      })

      expect(Array.isArray(skills)).toBe(true)
      expect(skills.length).toBe(0)
    })

    test('接受可选的 cwd 参数', async () => {
      const skills = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.skills.list.query({ cwd: '/tmp' })
      })

      expect(Array.isArray(skills)).toBe(true)
      expect(skills.length).toBe(0)
    })
  })

  describe('skills.listEnabled', () => {
    test('应该返回空数组', async () => {
      const skills = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.skills.listEnabled.query()
      })

      expect(Array.isArray(skills)).toBe(true)
      expect(skills.length).toBe(0)
    })

    test('接受可选的 cwd 参数', async () => {
      const skills = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.skills.listEnabled.query({ cwd: '/tmp' })
      })

      expect(Array.isArray(skills)).toBe(true)
      expect(skills.length).toBe(0)
    })
  })
})
