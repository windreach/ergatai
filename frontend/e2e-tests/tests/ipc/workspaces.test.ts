/**
 * IPC 单元测试 - Workspace 管理
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'

describe('IPC: Workspace 管理', () => {
  let electron: any
  let page: any

  beforeAll(async () => {
    electron = await launchElectron({
      extraEnv: { NODE_ENV: 'test', ELECTRON_TEST_MODE: 'true' },
    })
    page = electron.page

    process.on('exit', async () => {
      if (electron) { try { await electron.close() } catch (e) { /* ignore */ } }
    })
    process.on('SIGINT', async () => {
      if (electron) { await electron.close() }
      process.exit(130)
    })
  })

  afterAll(async () => {
    await page.evaluate(async () => { await (window as any).trpc.test.helpers.cleanup.mutate() })
    await electron.close()
  })

  beforeEach(async () => {
    await page.evaluate(async () => { await (window as any).trpc.test.helpers.cleanup.mutate() })
  })

  describe('test.workspaces', () => {
    test('创建 workspace', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.workspaces.create.mutate({
          name: 'test-ws-1',
          workDir: '/tmp/test-ws-1',
        })
      })

      expect(result).toBeDefined()
      expect(result.name).toBe('test-ws-1')
      expect(result.workDir).toBe('/tmp/test-ws-1')
      expect(result.id).toMatch(/^ws-/)
    })

    test('列出 workspace', async () => {
      await page.evaluate(async () => {
        await (window as any).trpc.test.workspaces.create.mutate({ name: 'test-ws-1', workDir: '/tmp/ws1' })
        await (window as any).trpc.test.workspaces.create.mutate({ name: 'test-ws-2', workDir: '/tmp/ws2' })
      })

      const workspaces = await page.evaluate(async () => {
        return await (window as any).trpc.test.workspaces.list.query()
      })

      expect(workspaces.length).toBeGreaterThanOrEqual(2)
    })

    test('获取单个 workspace', async () => {
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.test.workspaces.create.mutate({
          name: 'test-ws-get',
          workDir: '/tmp/ws-get',
        })
      })

      const workspace = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.workspaces.get.query({ id })
      }, created.id)

      expect(workspace.name).toBe('test-ws-get')
      expect(workspace.id).toBe(created.id)
    })

    test('删除 workspace', async () => {
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.test.workspaces.create.mutate({
          name: 'test-ws-del',
          workDir: '/tmp/ws-del',
        })
      })

      await page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.workspaces.delete.mutate({ id })
      }, created.id)

      const workspaces = await page.evaluate(async () => {
        return await (window as any).trpc.test.workspaces.list.query()
      })

      expect(workspaces.map((w: any) => w.id)).not.toContain(created.id)
    })

    test('获取不存在的 workspace 应报错', async () => {
      await expect(
        page.evaluate(async () => {
          return await (window as any).trpc.test.workspaces.get.query({ id: 'non-existent' })
        })
      ).rejects.toThrow('Workspace not found')
    })

    test('缺少必填字段应报错', async () => {
      await expect(
        page.evaluate(async () => {
          return await (window as any).trpc.test.workspaces.create.mutate({ name: '', workDir: '/tmp/x' })
        })
      ).rejects.toThrow()

      await expect(
        page.evaluate(async () => {
          return await (window as any).trpc.test.workspaces.create.mutate({ name: 'test-ws', workDir: '' })
        })
      ).rejects.toThrow()
    })
  })
})
