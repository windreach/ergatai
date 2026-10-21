/**
 * E2E UI 测试 - Workspace 管理（简化版）
 * 测试核心 Workspace 交互：创建、删除
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'
import * as fs from 'fs/promises'

describe('E2E: Workspace 管理', () => {
  let electron: any
  let page: any
  const testWorkspacePath1 = '/tmp/ergatai-workspace-test-1'
  const testWorkspacePath2 = '/tmp/ergatai-workspace-test-2'

  beforeAll(async () => {
    electron = await launchElectron({
      extraEnv: { NODE_ENV: 'test', ELECTRON_TEST_MODE: 'true' },
    })
    page = electron.page

    await fs.mkdir(testWorkspacePath1, { recursive: true })
    await fs.mkdir(testWorkspacePath2, { recursive: true })

    process.on('exit', async () => {
      if (electron) { try { await electron.close() } catch (e) { /* ignore */ } }
    })
  })

  afterAll(async () => {
    await page.evaluate(async () => {
      await (window as any).trpc.test.helpers.cleanup.mutate()
    })
    await fs.rm(testWorkspacePath1, { recursive: true, force: true }).catch(() => {})
    await fs.rm(testWorkspacePath2, { recursive: true, force: true }).catch(() => {})
    await electron.close()
  })

  beforeEach(async () => {
    await page.evaluate(async () => {
      await (window as any).trpc.test.helpers.cleanup.mutate()
    })
  })

  describe('Workspace 创建', () => {
    test('应该能够通过 IPC 创建新 workspace', async () => {
      const workspace = await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.projects.create.mutate({
          name: 'test-workspace',
          path: params.workspacePath,
        })
      }, { workspacePath: testWorkspacePath1 })

      expect(workspace).toBeDefined()
      expect(workspace.id).toBeDefined()
      expect(workspace.name).toBe('test-workspace')
      expect(workspace.path).toBe(testWorkspacePath1)
    })

    test('创建的 workspace 应该可以通过 get 获取', async () => {
      const workspace = await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.projects.create.mutate({
          name: 'get-test-workspace',
          path: params.workspacePath,
        })
      }, { workspacePath: testWorkspacePath1 })

      const fetched = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.projects.get.query({ id })
      }, workspace.id)

      expect(fetched).toBeDefined()
      expect(fetched.id).toBe(workspace.id)
      expect(fetched.name).toBe('get-test-workspace')
    })
  })

  describe('Workspace 删除', () => {
    test('应该能够删除 workspace', async () => {
      const workspace = await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.projects.create.mutate({
          name: 'delete-test',
          path: params.workspacePath,
        })
      }, { workspacePath: testWorkspacePath1 })

      await page.evaluate(async (id: string) => {
        await (window as any).trpc.test.projects.delete.mutate({ id })
      }, workspace.id)

      const workspaces = await page.evaluate(async () => {
        return await (window as any).trpc.test.projects.list.query()
      })

      const ids = workspaces.map((w: any) => w.id)
      expect(ids).not.toContain(workspace.id)
    })
  })

  describe('多 Workspace 管理', () => {
    test('应该能够创建多个 workspace', async () => {
      await page.evaluate(async (params: any) => {
        await (window as any).trpc.test.projects.create.mutate({
          name: 'workspace-1',
          path: params.workspacePath1,
        })
        await (window as any).trpc.test.projects.create.mutate({
          name: 'workspace-2',
          path: params.workspacePath2,
        })
      }, { workspacePath1: testWorkspacePath1, workspacePath2: testWorkspacePath2 })

      const workspaces = await page.evaluate(async () => {
        return await (window as any).trpc.test.projects.list.query()
      })

      const names = workspaces.map((w: any) => w.name)
      expect(names).toContain('workspace-1')
      expect(names).toContain('workspace-2')
      expect(workspaces.length).toBeGreaterThanOrEqual(2)
    })

    test('不同 workspace 应该有独立的数据', async () => {
      const ws1 = await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.projects.create.mutate({
          name: 'independent-1',
          path: params.workspacePath1,
        })
      }, { workspacePath1: testWorkspacePath1 })

      const ws2 = await page.evaluate(async (params: any) => {
        return await (window as any).trpc.test.projects.create.mutate({
          name: 'independent-2',
          path: params.workspacePath2,
        })
      }, { workspacePath2: testWorkspacePath2 })

      expect(ws1.id).not.toBe(ws2.id)
      expect(ws1.name).toBe('independent-1')
      expect(ws2.name).toBe('independent-2')
      expect(ws1.path).toBe(testWorkspacePath1)
      expect(ws2.path).toBe(testWorkspacePath2)
    })
  })
})
