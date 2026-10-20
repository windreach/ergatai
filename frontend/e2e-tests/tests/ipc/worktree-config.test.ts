/**
 * IPC 单元测试 - Worktree Config Router
 * 需要在数据库中创建项目
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'
import * as fs from 'fs/promises'
import * as path from 'path'

describe('IPC: Worktree Config Router', () => {
  let electron: any
  let page: any
  let testProjectId: string
  const testProjectPath = '/tmp/ergatai-worktree-test'

  beforeAll(async () => {
    electron = await launchElectron({
      extraEnv: { NODE_ENV: 'test', ELECTRON_TEST_MODE: 'true' },
    })
    page = electron.page

    // 创建测试目录
    await fs.mkdir(testProjectPath, { recursive: true })

    // 创建测试项目（使用 test router）
    const project = await page.evaluate(async (projectPath: string) => {
      return await (window as any).trpc.test.projects.create.mutate({
        name: 'test-worktree-project',
        path: projectPath,
      })
    }, testProjectPath)

    testProjectId = project.id

    process.on('exit', async () => {
      if (electron) { try { await electron.close() } catch (e) { /* ignore */ } }
    })
    process.on('SIGINT', async () => {
      if (electron) { await electron.close() }
      process.exit(130)
    })
  })

  afterAll(async () => {
    // 清理测试项目
    await page.evaluate(async (id: string) => {
      await (window as any).trpc.test.projects.delete.mutate({ id })
    }, testProjectId)

    // 清理测试目录
    await fs.rm(testProjectPath, { recursive: true, force: true }).catch(() => {})
    await electron.close()
  })

  beforeEach(async () => {
    // 清理可能的配置文件
    const ergataiConfig = path.join(testProjectPath, '.ergatai', 'worktree.json')
    const cursorConfig = path.join(testProjectPath, '.cursor', 'worktrees.json')
    await fs.unlink(ergataiConfig).catch(() => {})
    await fs.unlink(cursorConfig).catch(() => {})
  })

  describe('worktreeConfig.get', () => {
    test.skip('应该返回工作树配置', async () => {
      // 跳过：需要真实的 ergatai API 服务器
    })

    test.skip('不存在的项目应该报错', async () => {
      // 跳过：需要真实的 ergatai API 服务器
    })
  })

  describe('worktreeConfig.save', () => {
    test.skip('应该保存 ergatai 配置', async () => {
      // 跳过：需要真实的 ergatai API 服务器
    })

    test.skip('应该保存 cursor 配置', async () => {
      // 跳过：需要真实的 ergatai API 服务器
    })

    test.skip('不存在的项目应该报错', async () => {
      // 跳过：需要真实的 ergatai API 服务器
    })
  })

  describe('worktreeConfig.getAvailablePaths', () => {
    test.skip('应该返回可用配置路径', async () => {
      // 跳过：需要真实的 ergatai API 服务器
    })

    test.skip('不存在的项目应该报错', async () => {
      // 跳过：需要真实的 ergatai API 服务器
    })
  })
})
