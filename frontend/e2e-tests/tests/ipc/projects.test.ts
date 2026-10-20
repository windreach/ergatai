/**
 * IPC 单元测试 - 项目/Workspace 管理
 * 通过 test router 直接测试业务逻辑（不依赖 UI）
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'

describe('IPC: 项目/Workspace 管理', () => {
  let electron: any
  let page: any

  beforeAll(async () => {
    // 启动 Electron（测试模式）
    electron = await launchElectron({
      extraEnv: {
        NODE_ENV: 'test',
        ELECTRON_TEST_MODE: 'true',
      },
    })
    page = electron.page

    // 添加进程退出保护，确保清理
    process.on('exit', async () => {
      if (electron) {
        try {
          await electron.close()
        } catch (e) {
          // 忽略
        }
      }
    })

    process.on('SIGINT', async () => {
      if (electron) {
        await electron.close()
      }
      process.exit(130)
    })
  })

  afterAll(async () => {
    // 清理测试数据
    await page.evaluate(async () => {
      await (window as any).trpc.test.helpers.cleanup.mutate()
    })

    // 关闭 Electron
    await electron.close()
  })

  beforeEach(async () => {
    // 每个测试前清理
    await page.evaluate(async () => {
      await (window as any).trpc.test.helpers.cleanup.mutate()
    })
  })

  describe('test.isTestMode', () => {
    test('应该返回 true（测试模式已启用）', async () => {
      const isTestMode = await page.evaluate(async () => {
        return await (window as any).trpc.test.isTestMode.query()
      })

      expect(isTestMode).toBe(true)
    })
  })

  describe('test.projects', () => {
    test('创建项目', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.test.projects.create.mutate({
          name: 'test-project-1',
          path: '/tmp/test-project-1',
          description: 'Test project description'
        })
      })

      expect(result).toBeDefined()
      expect(result.name).toBe('test-project-1')
      expect(result.path).toBe('/tmp/test-project-1')
    })

    test('列出项目', async () => {
      // 创建两个测试项目
      await page.evaluate(async () => {
        await (window as any).trpc.test.projects.create.mutate({
          name: 'test-project-1',
          path: '/tmp/test-project-1'
        })
        await (window as any).trpc.test.projects.create.mutate({
          name: 'test-project-2',
          path: '/tmp/test-project-2'
        })
      })

      // 列出所有项目
      const projects = await page.evaluate(async () => {
        return await (window as any).trpc.test.projects.list.query()
      })

      expect(projects).toBeDefined()
      expect(Array.isArray(projects)).toBe(true)
      expect(projects.length).toBeGreaterThanOrEqual(2)

      const projectNames = projects.map((p: any) => p.name)
      expect(projectNames).toContain('test-project-1')
      expect(projectNames).toContain('test-project-2')
    })

    test('获取单个项目', async () => {
      // 创建项目
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.test.projects.create.mutate({
          name: 'test-project-get',
          path: '/tmp/test-project-get'
        })
      })

      // TODO: 实现 get 方法后，取消注释
      // const project = await page.evaluate(async (id: string) => {
      //   return await (window as any).trpc.test.projects.get.query({ id })
      // }, created.id)
      // expect(project).toBeDefined()
      // expect(project.name).toBe('test-project-get')

      expect(created).toBeDefined()
      expect(created.name).toBe('test-project-get')
    })

    test('删除项目', async () => {
      // 创建项目
      const created = await page.evaluate(async () => {
        return await (window as any).trpc.test.projects.create.mutate({
          name: 'test-project-delete',
          path: '/tmp/test-project-delete'
        })
      })

      // 删除项目
      const result = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.test.projects.delete.mutate({ id })
      }, created.id)

      expect(result).toBeDefined()

      // TODO: 实现数据库操作后，取消注释
      // const projects = await page.evaluate(async () => {
      //   return await (window as any).trpc.test.projects.list.query()
      // })
      // const projectNames = projects.map((p: any) => p.name)
      // expect(projectNames).not.toContain('test-project-delete')
    })

    test('创建项目 - 缺少必填字段应报错', async () => {
      await expect(
        page.evaluate(async () => {
          return await (window as any).trpc.test.projects.create.mutate({
            name: '',  // 空名称
            path: '/tmp/test'
          })
        })
      ).rejects.toThrow()
    })
  })
})
