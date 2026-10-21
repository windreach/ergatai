/**
 * E2E UI 测试 - 文件访问控制（零信任锁）
 * 验证 CLAUDE.md 描述的 ergatai-lock 系统：token 获取/释放/过期/审计
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration } from '../../fixtures/integration-launcher'

describe('E2E: 文件访问控制', () => {
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

  describe('锁获取', () => {
    test('应该能够获取文件锁', async () => {
      const lock = await page.evaluate(async () => {
        return await (window as any).trpc.test.locks.acquireLock.mutate({
          agentId: 'agent-1',
          path: 'src/main.rs',
        })
      })

      expect(lock).toBeDefined()
      expect(lock.token).toBeDefined()
      expect(lock.path).toBe('src/main.rs')
      expect(lock.agentId).toBe('agent-1')
      expect(lock.expiresAt).toBeDefined()
    })

    test('获取的锁应该有合理的 TTL', async () => {
      const lock = await page.evaluate(async () => {
        return await (window as any).trpc.test.locks.acquireLock.mutate({
          agentId: 'agent-ttl',
          path: 'src/lib.rs',
        })
      })

      const expiresAt = new Date(lock.expiresAt)
      const now = new Date()
      const ttlMinutes = (expiresAt.getTime() - now.getTime()) / 60000

      expect(ttlMinutes).toBeGreaterThan(10)
      expect(ttlMinutes).toBeLessThanOrEqual(60)
    })

    test('同一 agent 可以获取多个文件的锁', async () => {
      const lock1 = await page.evaluate(async () => {
        return await (window as any).trpc.test.locks.acquireLock.mutate({
          agentId: 'multi-lock-agent', path: 'src/a.rs',
        })
      })

      const lock2 = await page.evaluate(async () => {
        return await (window as any).trpc.test.locks.acquireLock.mutate({
          agentId: 'multi-lock-agent', path: 'src/b.rs',
        })
      })

      expect(lock1.token).not.toBe(lock2.token)
      expect(lock1.path).toBe('src/a.rs')
      expect(lock2.path).toBe('src/b.rs')
    })
  })

  describe('锁释放', () => {
    test('应该能够通过 token 释放锁', async () => {
      const lock = await page.evaluate(async () => {
        return await (window as any).trpc.test.locks.acquireLock.mutate({
          agentId: 'release-agent', path: 'src/release.rs',
        })
      })

      const result = await page.evaluate(async (token: string) => {
        return await (window as any).trpc.test.locks.releaseLock.mutate({ token })
      }, lock.token)

      expect(result.success).toBe(true)

      const locks = await page.evaluate(async () => {
        return await (window as any).trpc.test.locks.list.query()
      })
      const found = locks.find((l: any) => l.token === lock.token)
      expect(found).toBeUndefined()
    })
  })

  describe('锁列表', () => {
    test('应该能够列出所有活跃锁', async () => {
      await page.evaluate(async () => {
        await (window as any).trpc.test.locks.acquireLock.mutate({
          agentId: 'agent-a', path: 'file1.rs',
        })
        await (window as any).trpc.test.locks.acquireLock.mutate({
          agentId: 'agent-b', path: 'file2.rs',
        })
      })

      const locks = await page.evaluate(async () => {
        return await (window as any).trpc.test.locks.list.query()
      })

      expect(Array.isArray(locks)).toBe(true)
      expect(locks.length).toBeGreaterThanOrEqual(2)

      const paths = locks.map((l: any) => l.path)
      expect(paths).toContain('file1.rs')
      expect(paths).toContain('file2.rs')
    })
  })

  describe('审计日志', () => {
    test('锁操作应该记录到审计日志', async () => {
      await page.evaluate(async () => {
        await (window as any).trpc.test.locks.acquireLock.mutate({
          agentId: 'audit-agent', path: 'audit-file.rs',
        })
      })

      const log = await page.evaluate(async () => {
        return await (window as any).trpc.test.locks.getAuditLog.query()
      })

      expect(Array.isArray(log)).toBe(true)
      expect(log.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('锁竞争检测', () => {
    test('应该能够检测锁竞争', async () => {
      const contention = await page.evaluate(async () => {
        return await (window as any).trpc.test.locks.getContention.query()
      })

      expect(contention).toBeDefined()
      expect(Array.isArray(contention.contendedLocks)).toBe(true)
      expect(typeof contention.totalActive).toBe('number')
    })
  })
})
