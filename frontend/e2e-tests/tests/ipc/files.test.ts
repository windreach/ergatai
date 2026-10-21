/**
 * IPC 单元测试 - 文件操作
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'
import * as fs from 'fs/promises'
import * as path from 'path'

describe('IPC: 文件操作', () => {
  const ctx = createTestContext()
  const testDir = '/tmp/ergatai-file-test'

  ctx.beforeAll(async () => {
    await fs.mkdir(testDir, { recursive: true })
  })

  ctx.afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  describe('test.files', () => {
    test('创建文件', async () => {
      const filePath = path.join(testDir, 'test-create.txt')
      const content = 'Hello, World!'

      const result = await ctx.page.evaluate(async (args: { path: string; content: string }) => {
        return await (window as any).trpc.test.files.create.mutate(args)
      }, { path: filePath, content })

      expect(result.success).toBe(true)
      expect(result.path).toBe(filePath)

      const actual = await fs.readFile(filePath, 'utf-8')
      expect(actual).toBe(content)
    })

    test('读取文件', async () => {
      const filePath = path.join(testDir, 'test-read.txt')
      const content = 'Test content'
      await fs.writeFile(filePath, content, 'utf-8')

      const result = await ctx.page.evaluate(async (p: string) => {
        return await (window as any).trpc.test.files.read.query({ path: p })
      }, filePath)

      expect(result.success).toBe(true)
      expect(result.content).toBe(content)
      expect(result.path).toBe(filePath)
    })

    test('读取不存在的文件应报错', async () => {
      const filePath = path.join(testDir, 'does-not-exist.txt')

      await expect(
        ctx.page.evaluate(async (p: string) => {
          return await (window as any).trpc.test.files.read.query({ path: p })
        }, filePath)
      ).rejects.toThrow()
    })

    test('删除文件', async () => {
      const filePath = path.join(testDir, 'test-delete.txt')
      await fs.writeFile(filePath, 'delete me', 'utf-8')

      const result = await ctx.page.evaluate(async (p: string) => {
        return await (window as any).trpc.test.files.delete.mutate({ path: p })
      }, filePath)

      expect(result.success).toBe(true)

      const exists = await fs.access(filePath).then(() => true).catch(() => false)
      expect(exists).toBe(false)
    })

    test('创建文件会自动创建父目录', async () => {
      const filePath = path.join(testDir, 'nested', 'dir', 'file.txt')

      const result = await ctx.page.evaluate(async (args: { path: string; content: string }) => {
        return await (window as any).trpc.test.files.create.mutate(args)
      }, { path: filePath, content: 'nested' })

      expect(result.success).toBe(true)

      const actual = await fs.readFile(filePath, 'utf-8')
      expect(actual).toBe('nested')
    })

    test('操作日志记录', async () => {
      const file1 = path.join(testDir, 'log-1.txt')
      const file2 = path.join(testDir, 'log-2.txt')

      await ctx.page.evaluate(async (args: { path: string; content: string }) => {
        await (window as any).trpc.test.files.create.mutate(args)
      }, { path: file1, content: 'a' })

      await ctx.page.evaluate(async (args: { path: string; content: string }) => {
        await (window as any).trpc.test.files.create.mutate(args)
      }, { path: file2, content: 'b' })

      await ctx.page.evaluate(async (p: string) => {
        await (window as any).trpc.test.files.delete.mutate({ path: p })
      }, file1)

      const log = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.test.files.getOperationLog.query()
      })

      expect(log.length).toBeGreaterThanOrEqual(3)

      const createOps = log.filter((op: any) => op.type === 'create')
      expect(createOps.length).toBeGreaterThanOrEqual(2)

      const deleteOps = log.filter((op: any) => op.type === 'delete')
      expect(deleteOps.length).toBeGreaterThanOrEqual(1)
      expect(deleteOps[0].path).toBe(file1)
    })

    test('路径为空应报错', async () => {
      await expect(
        ctx.page.evaluate(async () => {
          return await (window as any).trpc.test.files.create.mutate({ path: '', content: 'x' })
        })
      ).rejects.toThrow()

      await expect(
        ctx.page.evaluate(async () => {
          return await (window as any).trpc.test.files.read.query({ path: '' })
        })
      ).rejects.toThrow()
    })
  })
})
