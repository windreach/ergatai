/**
 * Integration Test - 后端健康检查
 * 直接测试真实 ergatai-server 的 REST API 端点
 */

import { test, expect, describe, beforeAll, afterAll } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration, api } from '../../fixtures/integration-launcher'

describe('Integration: 后端健康检查', () => {
  let electron: any
  let page: any

  beforeAll(async () => {
    const env = await launchIntegrationElectron()
    electron = env.electron
    page = env.page
  })

  afterAll(async () => {
    await cleanupIntegration(electron)
  })

  describe('REST API 直连', () => {
    test('GET /health 应该返回 200', async () => {
      const health = await api.health()
      expect(health).toBeDefined()
    })

    test('GET /ready 应该返回就绪状态', async () => {
      const ready = await api.ready()
      expect(ready).toBeDefined()
    })

    test('GET /api/v1/status 应该返回系统状态', async () => {
      const status = await api.getStatus()
      expect(status).toBeDefined()
    })
  })

  describe('tRPC 通过 Electron', () => {
    test('ergatai.healthCheck 应该返回正常', async () => {
      const health = await page.evaluate(async () => {
        return await (window as any).trpc.ergatai.healthCheck.query()
      })
      expect(health).toBeDefined()
    })

    test('ergatai.getStatus 应该返回系统状态', async () => {
      const status = await page.evaluate(async () => {
        return await (window as any).trpc.ergatai.getStatus.query()
      })
      expect(status).toBeDefined()
    })

    test('ergatai.listAgents 应该返回数组', async () => {
      const agents = await page.evaluate(async () => {
        return await (window as any).trpc.ergatai.listAgents.query()
      })
      expect(Array.isArray(agents)).toBe(true)
    })

    test('ergatai.listManagedWorkspaces 应该返回数组', async () => {
      const workspaces = await page.evaluate(async () => {
        return await (window as any).trpc.ergatai.listManagedWorkspaces.query()
      })
      expect(Array.isArray(workspaces)).toBe(true)
    })
  })
})
