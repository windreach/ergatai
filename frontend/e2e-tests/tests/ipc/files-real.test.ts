/**
 * IPC 单元测试 - Files Router（真实 router，非 test.files）
 *
 * 测试真实的 files router，注意该 router 的大部分 procedure 都有
 * `assertRegisteredWorktree()` 安全验证，会检查路径是否在注册的 worktree 范围内。
 *
 * 测试范围：
 * - 不需要 worktree 验证的 procedure：search、clearCache、writePastedText
 * - 需要 worktree 验证的 procedure：readFile、readTextFile、renameFile、deleteFile（应报错）
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

describe('IPC: Files Router (Real)', () => {
  let electron: any
  let page: any
  let testProjectDir: string

  beforeAll(async () => {
    electron = await launchElectron({
      extraEnv: { NODE_ENV: 'test', ELECTRON_TEST_MODE: 'true' },
    })
    page = electron.page

    // 创建测试项目目录
    testProjectDir = path.join(os.tmpdir(), `ergatai-files-real-test-${Date.now()}`)
    await fs.mkdir(testProjectDir, { recursive: true })

    process.on('exit', async () => {
      if (electron) { try { await electron.close() } catch (e) { /* ignore */ } }
    })
    process.on('SIGINT', async () => {
      if (electron) { await electron.close() }
      process.exit(130)
    })
  })

  afterAll(async () => {
    await fs.rm(testProjectDir, { recursive: true, force: true }).catch(() => {})
    await electron.close()
  })

  beforeEach(async () => {
    await page.evaluate(async () => { await (window as any).trpc.test.helpers.cleanup.mutate() })
    // 清除文件搜索缓存，避免测试间干扰
    await page.evaluate(async (projectPath: string) => {
      await (window as any).trpc.files.clearCache.mutate({ projectPath }).catch(() => {})
    }, testProjectDir)
  })

  describe('files.search', () => {
    test('应该返回文件列表', async () => {
      // 在测试目录中创建一些文件
      await fs.writeFile(path.join(testProjectDir, 'file1.txt'), 'content 1')
      await fs.writeFile(path.join(testProjectDir, 'file2.js'), 'content 2')
      await fs.mkdir(path.join(testProjectDir, 'subdir'), { recursive: true })
      await fs.writeFile(path.join(testProjectDir, 'subdir', 'nested.ts'), 'content 3')

      const results = await page.evaluate(async (projectPath: string) => {
        return await (window as any).trpc.files.search.query({ projectPath })
      }, testProjectDir)

      expect(Array.isArray(results)).toBe(true)
      // 应该至少包含我们创建的文件和子目录
      expect(results.length).toBeGreaterThanOrEqual(3)

      // 每个条目应该有基本字段
      for (const entry of results) {
        expect(typeof entry.label).toBe('string')
        expect(entry.label.length).toBeGreaterThan(0)
        expect(typeof entry.path).toBe('string')
        expect(entry.path.length).toBeGreaterThan(0)
      }
    })

    test('接受 limit 参数', async () => {
      // 创建多个文件
      for (let i = 0; i < 10; i++) {
        await fs.writeFile(path.join(testProjectDir, `limit-test-${i}.txt`), `content ${i}`)
      }

      const results = await page.evaluate(async (projectPath: string) => {
        return await (window as any).trpc.files.search.query({
          projectPath,
          limit: 5,
        })
      }, testProjectDir)

      expect(Array.isArray(results)).toBe(true)
      // 结果应该被限制在 5 个以内
      expect(results.length).toBeLessThanOrEqual(5)
    })

    test('接受 typeFilter 参数', async () => {
      await fs.writeFile(path.join(testProjectDir, 'type-filter-file.txt'), 'content')
      await fs.mkdir(path.join(testProjectDir, 'type-filter-dir'), { recursive: true })

      const fileResults = await page.evaluate(async (projectPath: string) => {
        return await (window as any).trpc.files.search.query({
          projectPath,
          typeFilter: 'file',
        })
      }, testProjectDir)

      for (const entry of fileResults) {
        expect(entry.type).toBe('file')
      }

      const folderResults = await page.evaluate(async (projectPath: string) => {
        return await (window as any).trpc.files.search.query({
          projectPath,
          typeFilter: 'folder',
        })
      }, testProjectDir)

      for (const entry of folderResults) {
        expect(entry.type).toBe('folder')
      }
    })

    test('不存在的目录应该返回空数组', async () => {
      const results = await page.evaluate(async () => {
        return await (window as any).trpc.files.search.query({
          projectPath: '/non/existent/path',
        })
      })

      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBe(0)
    })

    test('query 参数应该过滤结果', async () => {
      await fs.writeFile(path.join(testProjectDir, 'query-test-foo.txt'), 'content')
      await fs.writeFile(path.join(testProjectDir, 'query-test-bar.js'), 'content')

      const results = await page.evaluate(async (projectPath: string) => {
        return await (window as any).trpc.files.search.query({
          projectPath,
          query: 'foo',
        })
      }, testProjectDir)

      expect(Array.isArray(results)).toBe(true)
      // 结果应该只包含包含 'foo' 的文件
      const matchingFiles = results.filter((e: any) => e.label.includes('foo') || e.path.includes('foo'))
      expect(matchingFiles.length).toBeGreaterThan(0)
    })
  })

  describe('files.clearCache', () => {
    test('应该成功清除缓存', async () => {
      const result = await page.evaluate(async (projectPath: string) => {
        return await (window as any).trpc.files.clearCache.mutate({ projectPath })
      }, testProjectDir)

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })
  })

  describe('files.writePastedText', () => {
    test('应该创建粘贴文本文件', async () => {
      const conversationId = `test-conv-${Date.now()}`
      const text = 'This is a pasted text content for testing'

      const result = await page.evaluate(async (args: { conversationId: string; text: string }) => {
        return await (window as any).trpc.files.writePastedText.mutate(args)
      }, { conversationId, text })

      expect(result).toBeDefined()
      expect(typeof result.filePath).toBe('string')
      expect(typeof result.filename).toBe('string')
      expect(result.size).toBe(text.length)

      // 验证文件确实被创建
      const exists = await fs.access(result.filePath).then(() => true).catch(() => false)
      expect(exists).toBe(true)

      const content = await fs.readFile(result.filePath, 'utf-8')
      expect(content).toBe(text)
    })

    test('返回文件路径和大小', async () => {
      const conversationId = `test-conv-size-${Date.now()}`
      const text = 'A'.repeat(1000) // 1000 字节

      const result = await page.evaluate(async (args: { conversationId: string; text: string }) => {
        return await (window as any).trpc.files.writePastedText.mutate(args)
      }, { conversationId, text })

      expect(result.size).toBe(1000)
      expect(result.filePath).toContain(conversationId)
    })

    test('支持自定义 filename', async () => {
      const conversationId = `test-conv-custom-${Date.now()}`
      const customFilename = 'custom-name.txt'
      const text = 'Custom named paste'

      const result = await page.evaluate(async (args: { conversationId: string; text: string; filename: string }) => {
        return await (window as any).trpc.files.writePastedText.mutate(args)
      }, { conversationId, text, filename: customFilename })

      expect(result.filename).toBe(customFilename)
      expect(result.filePath).toContain(customFilename)
    })
  })

  describe('files.readFile (requires registered worktree)', () => {
    test('应该报错（未注册 worktree）', async () => {
      // 先创建一个测试文件
      const testFile = path.join(testProjectDir, 'read-test.txt')
      await fs.writeFile(testFile, 'read content')

      await expect(
        page.evaluate(async (filePath: string) => {
          return await (window as any).trpc.files.readFile.query({ filePath })
        }, testFile)
      ).rejects.toThrow()
    })
  })

  describe('files.readTextFile (requires registered worktree)', () => {
    test('应该报错（未注册 worktree）', async () => {
      const testFile = path.join(testProjectDir, 'read-text-test.txt')
      await fs.writeFile(testFile, 'text content')

      await expect(
        page.evaluate(async (filePath: string) => {
          return await (window as any).trpc.files.readTextFile.query({ filePath })
        }, testFile)
      ).rejects.toThrow()
    })
  })

  describe('files.renameFile (requires registered worktree)', () => {
    test('应该报错（未注册 worktree）', async () => {
      const testFile = path.join(testProjectDir, 'rename-test.txt')
      await fs.writeFile(testFile, 'rename content')

      await expect(
        page.evaluate(async (absolutePath: string) => {
          return await (window as any).trpc.files.renameFile.mutate({
            absolutePath,
            newName: 'renamed.txt',
          })
        }, testFile)
      ).rejects.toThrow()
    })
  })

  describe('files.deleteFile (requires registered worktree)', () => {
    test('应该报错（未注册 worktree）', async () => {
      const testFile = path.join(testProjectDir, 'delete-test.txt')
      await fs.writeFile(testFile, 'delete content')

      await expect(
        page.evaluate(async (absolutePath: string) => {
          return await (window as any).trpc.files.deleteFile.mutate({ absolutePath })
        }, testFile)
      ).rejects.toThrow()
    })
  })
})
