/**
 * E2E UI 测试 - tRPC IPC 集成（从渲染进程调用）
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

describe('E2E: tRPC IPC 集成', () => {
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
    await page.evaluate(async () => {
      await (window as any).trpc.test.helpers.cleanup.mutate()
    })
    await electron.close()
  })

  beforeEach(async () => {
    await page.evaluate(async () => {
      await (window as any).trpc.test.helpers.cleanup.mutate()
    })
  })

  test('从渲染进程调用 test.isTestMode 应该返回 true', async () => {
    const result = await page.evaluate(async () => {
      return await (window as any).trpc.test.isTestMode.query()
    })
    expect(result).toBe(true)
  })

  test('从渲染进程调用 test.helpers.getEnv 应该返回环境信息', async () => {
    const env = await page.evaluate(async () => {
      return await (window as any).trpc.test.helpers.getEnv.query()
    })

    expect(env).toBeDefined()
    expect(env.platform).toBeDefined()
    expect(env.arch).toBeDefined()
    expect(env.homeDir).toBeDefined()
  })

  test('从渲染进程创建 agent 应该写文件', async () => {
    const result = await page.evaluate(async () => {
      return await (window as any).trpc.test.agents.create.mutate({
        name: 'test-ui-agent',
        description: 'Created from UI test',
        prompt: 'You are a UI test agent',
        source: 'user',
      })
    })

    expect(result.name).toBe('test-ui-agent')
    expect(result.source).toBe('user')

    const agentPath = path.join(os.homedir(), '.claude', 'agents', 'test-ui-agent.md')
    const exists = await fs.access(agentPath).then(() => true).catch(() => false)
    expect(exists).toBe(true)

    const content = await fs.readFile(agentPath, 'utf-8')
    expect(content).toContain('test-ui-agent')
  })

  test('从渲染进程列出 agent 应该包含刚创建的', async () => {
    await page.evaluate(async () => {
      await (window as any).trpc.test.agents.create.mutate({
        name: 'test-ui-list-agent',
        description: 'List test',
        prompt: 'List test agent',
        source: 'user',
      })
    })

    const agents = await page.evaluate(async () => {
      return await (window as any).trpc.test.agents.list.query()
    })

    const names = agents.map((a: any) => a.name)
    expect(names).toContain('test-ui-list-agent')
  })

  test('渲染进程创建项目应该成功', async () => {
    const project = await page.evaluate(async () => {
      return await (window as any).trpc.test.projects.create.mutate({
        name: 'test-ui-project',
        path: '/tmp/ui-test-project',
        description: 'Created from UI',
      })
    })

    expect(project.name).toBe('test-ui-project')
    expect(project.id).toMatch(/^proj_/)
  })

  test('渲染进程创建对话应该成功', async () => {
    const chat = await page.evaluate(async () => {
      return await (window as any).trpc.test.chats.create.mutate({
        name: 'test-ui-chat',
        projectId: 'ui-test-project',
      })
    })

    expect(chat.name).toBe('test-ui-chat')
    expect(chat.id).toMatch(/^chat-/)
  })

  test('渲染进程创建 workspace 应该成功', async () => {
    const workspace = await page.evaluate(async () => {
      return await (window as any).trpc.test.workspaces.create.mutate({
        name: 'test-ui-workspace',
        workDir: '/tmp/ui-test-workspace',
      })
    })

    expect(workspace.name).toBe('test-ui-workspace')
    expect(workspace.id).toMatch(/^ws-/)
  })

  test('渲染进程文件操作应该实际写入磁盘', async () => {
    const testFile = '/tmp/ergatai-ui-file-test.txt'

    const createResult = await page.evaluate(async (p: string) => {
      return await (window as any).trpc.test.files.create.mutate({
        path: p,
        content: 'UI test content',
      })
    }, testFile)

    expect(createResult.success).toBe(true)

    const content = await fs.readFile(testFile, 'utf-8')
    expect(content).toBe('UI test content')

    const readResult = await page.evaluate(async (p: string) => {
      return await (window as any).trpc.test.files.read.query({ path: p })
    }, testFile)

    expect(readResult.content).toBe('UI test content')

    await fs.unlink(testFile).catch(() => {})
  })

  test('IPC 调用错误应该正确传播到渲染进程', async () => {
    await expect(
      page.evaluate(async () => {
        return await (window as any).trpc.test.projects.get.query({ id: 'non-existent' })
      })
    ).rejects.toThrow('Project not found')
  })

  test('zod 验证错误应该从渲染进程正确抛出', async () => {
    await expect(
      page.evaluate(async () => {
        return await (window as any).trpc.test.projects.create.mutate({
          name: '',
          path: '/tmp/test',
        })
      })
    ).rejects.toThrow()
  })

  test('清理应该清除所有测试数据', async () => {
    await page.evaluate(async () => {
      await (window as any).trpc.test.agents.create.mutate({
        name: 'test-cleanup-agent',
        description: 'To cleanup',
        prompt: 'test',
        source: 'user',
      })
      await (window as any).trpc.test.projects.create.mutate({
        name: 'test-cleanup-project',
        path: '/tmp/cleanup',
      })
      await (window as any).trpc.test.chats.create.mutate({
        name: 'test-cleanup-chat',
        projectId: 'cleanup',
      })
      await (window as any).trpc.test.workspaces.create.mutate({
        name: 'test-cleanup-ws',
        workDir: '/tmp/cleanup-ws',
      })
    })

    const result = await page.evaluate(async () => {
      return await (window as any).trpc.test.helpers.cleanup.mutate()
    })

    expect(result.deletedAgents).toBeGreaterThanOrEqual(1)
    expect(result.deletedProjects).toBeGreaterThanOrEqual(1)
    expect(result.deletedChats).toBeGreaterThanOrEqual(1)
    expect(result.deletedWorkspaces).toBeGreaterThanOrEqual(1)

    const agents = await page.evaluate(async () => {
      return await (window as any).trpc.test.agents.list.query()
    })
    expect(agents.filter((a: any) => a.name.startsWith('test-')).length).toBe(0)

    const projects = await page.evaluate(async () => {
      return await (window as any).trpc.test.projects.list.query()
    })
    expect(projects.length).toBe(0)
  })
})
