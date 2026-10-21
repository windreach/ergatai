/**
 * Integration Test - Workspace 管理
 * 测试真实后端的 workspace CRUD 操作
 */

import { test, expect, describe, beforeAll, afterAll } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration, api } from '../../fixtures/integration-launcher'
import * as fs from 'fs/promises'

describe('Integration: Workspace 管理（真实后端）', () => {
  let electron: any
  let page: any
  const testWorkDir1 = '/tmp/ergatai-integration-ws-1'
  const testWorkDir2 = '/tmp/ergatai-integration-ws-2'
  const createdWorkspaceIds: string[] = []

  beforeAll(async () => {
    await fs.mkdir(testWorkDir1, { recursive: true })
    await fs.mkdir(testWorkDir2, { recursive: true })

    const env = await launchIntegrationElectron()
    electron = env.electron
    page = env.page
  })

  afterAll(async () => {
    for (const id of createdWorkspaceIds) {
      await api.deleteWorkspace(id).catch(() => {})
    }
    await fs.rm(testWorkDir1, { recursive: true, force: true }).catch(() => {})
    await fs.rm(testWorkDir2, { recursive: true, force: true }).catch(() => {})
    await cleanupIntegration(electron)
  })

  describe('通过 REST API 直连', () => {
    test('应该能够通过 REST API 创建 workspace', async () => {
      const workspace = await api.createWorkspace({
        name: 'integration-test-ws-rest',
        work_dir: testWorkDir1,
      })

      expect(workspace).toBeDefined()
      // REST API 返回 workspace_id，不是 id
      expect(workspace.workspace_id || workspace.id).toBeDefined()
      createdWorkspaceIds.push(workspace.workspace_id || workspace.id)
    })

    test('创建的 workspace 应该出现在列表中', async () => {
      const workspaces = await api.listWorkspaces()
      expect(Array.isArray(workspaces)).toBe(true)
      const names = workspaces.map((w: any) => w.name)
      expect(names).toContain('integration-test-ws-rest')
    })

    test('应该能够通过 REST API 删除 workspace', async () => {
      const workspace = await api.createWorkspace({
        name: 'delete-test-rest',
        work_dir: testWorkDir2,
      })
      const wsId = workspace.workspace_id || workspace.id

      const status = await api.deleteWorkspace(wsId)
      // REST API 删除成功返回 204 (No Content) 或 200 (OK)
      expect(status).toBeLessThan(300)

      const workspaces = await api.listWorkspaces()
      const ids = workspaces.map((w: any) => w.workspace_id || w.id)
      expect(ids).not.toContain(wsId)
    })
  })

  describe('通过 tRPC (Electron → 后端)', () => {
    test('应该能够通过 tRPC 创建 workspace', async () => {
      const workspace = await page.evaluate(async (workDir: string) => {
        return await (window as any).trpc.ergatai.createManagedWorkspace.mutate({
          name: 'integration-test-ws-trpc',
          workDir,
        })
      }, testWorkDir1)

      expect(workspace).toBeDefined()
      expect(workspace.id).toBeDefined()
      createdWorkspaceIds.push(workspace.id)
    })

    test('tRPC 创建的 workspace 应该出现在 REST API 列表中', async () => {
      const workspaces = await api.listWorkspaces()
      const names = workspaces.map((w: any) => w.name)
      expect(names).toContain('integration-test-ws-trpc')
    })

    test('应该能够通过 tRPC 获取 workspace 详情', async () => {
      const workspace = await page.evaluate(async (workDir: string) => {
        return await (window as any).trpc.ergatai.createManagedWorkspace.mutate({
          name: 'get-detail-test',
          workDir,
        })
      }, testWorkDir1)
      createdWorkspaceIds.push(workspace.id)

      const detail = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.ergatai.getManagedWorkspace.query({ id })
      }, workspace.id)

      expect(detail).toBeDefined()
      expect(detail.id).toBe(workspace.id)
      expect(detail.name).toBe('get-detail-test')
    })

    test('应该能够通过 tRPC 删除 workspace', async () => {
      const workspace = await page.evaluate(async (workDir: string) => {
        return await (window as any).trpc.ergatai.createManagedWorkspace.mutate({
          name: 'delete-test-trpc',
          workDir,
        })
      }, testWorkDir1)

      await page.evaluate(async (id: string) => {
        await (window as any).trpc.ergatai.deleteManagedWorkspace.mutate({ id })
      }, workspace.id)

      const workspaces = await api.listWorkspaces()
      const ids = workspaces.map((w: any) => w.id)
      expect(ids).not.toContain(workspace.id)
    })
  })
})
