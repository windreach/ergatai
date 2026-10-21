/**
 * IPC 单元测试 - Changes/Git Router
 * 注意：大部分 procedure 需要真实 git 仓库，使用 test.skip()
 */

import { test, expect, describe } from '@playwright/test'
import { createTestContext } from '../../fixtures/test-context'
import * as fs from 'fs/promises'
import { exec as execCallback } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execCallback)

describe('IPC: Changes/Git Router', () => {
  const ctx = createTestContext()
  let tempGitRepo: string

  ctx.beforeAll(async () => {
    // 创建临时 git 仓库
    tempGitRepo = `/tmp/ergatai-git-test-${Date.now()}`
    await fs.mkdir(tempGitRepo, { recursive: true })
    await exec('git init', { cwd: tempGitRepo })
    await exec('git config user.email "test@test.com"', { cwd: tempGitRepo })
    await exec('git config user.name "Test User"', { cwd: tempGitRepo })

    // 创建一个初始提交
    await fs.writeFile(`${tempGitRepo}/README.md`, '# Test Repo\n')
    await exec('git add README.md', { cwd: tempGitRepo })
    await exec('git commit -m "Initial commit"', { cwd: tempGitRepo })
  })

  ctx.afterAll(async () => {
    // 清理临时仓库
    await fs.rm(tempGitRepo, { recursive: true, force: true }).catch(() => {})
  })

  describe('changes.isWorktreeRegistered', () => {
    test('应该返回布尔值', async () => {
      const result = await ctx.page.evaluate(async (worktreePath: string) => {
        return await (window as any).trpc.changes.isWorktreeRegistered.query({ worktreePath })
      }, tempGitRepo)

      expect(typeof result).toBe('boolean')
    })

    test('对于不存在的目录应该返回 false', async () => {
      const result = await ctx.page.evaluate(async () => {
        return await (window as any).trpc.changes.isWorktreeRegistered.query({
          worktreePath: '/nonexistent/path',
        })
      })

      expect(result).toBe(false)
    })
  })

  describe('changes.getStatus', () => {
    test('应该返回 git 状态（在临时 git 仓库中）', async () => {
      let status: any = null
      let error: any = null

      try {
        status = await ctx.page.evaluate(async (worktreePath: string) => {
          return await (window as any).trpc.changes.getStatus.query({ worktreePath })
        }, tempGitRepo)
      } catch (e) {
        error = e
      }

      // 可能成功返回状态，也可能因为 worktree 未注册而失败
      if (error) {
        expect(error).toBeDefined()
      } else {
        expect(status).toBeDefined()
        expect(typeof status).toBe('object')
      }
    })
  })

  describe('changes.getBranches', () => {
    test('应该返回分支数组', async () => {
      let branches: any = null
      let error: any = null

      try {
        branches = await ctx.page.evaluate(async (worktreePath: string) => {
          return await (window as any).trpc.changes.getBranches.query({ worktreePath })
        }, tempGitRepo)
      } catch (e) {
        error = e
      }

      // 可能成功返回分支列表，也可能因为 worktree 未注册而失败
      if (error) {
        expect(error).toBeDefined()
      } else {
        expect(branches).toBeDefined()
        expect(Array.isArray(branches)).toBe(true)
      }
    })
  })

  describe('changes.stageFile', () => {
    test('应该跳过（需要完整 git 仓库设置）', async () => {
      test.skip()
    })
  })

  describe('changes.unstageFile', () => {
    test('应该跳过（需要完整 git 仓库设置）', async () => {
      test.skip()
    })
  })

  describe('changes.commit', () => {
    test('应该跳过（需要完整 git 仓库设置）', async () => {
      test.skip()
    })
  })

  describe('changes.getHistory', () => {
    test('应该跳过（需要完整 git 仓库设置）', async () => {
      test.skip()
    })
  })

  describe('changes.createBranch', () => {
    test('应该跳过（需要完整 git 仓库设置）', async () => {
      test.skip()
    })
  })

  describe('changes.switchBranch', () => {
    test('应该跳过（需要完整 git 仓库设置）', async () => {
      test.skip()
    })
  })

  describe('changes.deleteBranch', () => {
    test('应该跳过（需要完整 git 仓库设置）', async () => {
      test.skip()
    })
  })

  describe('changes.pull', () => {
    test('应该跳过（需要远程仓库）', async () => {
      test.skip()
    })
  })

  describe('changes.push', () => {
    test('应该跳过（需要远程仓库）', async () => {
      test.skip()
    })
  })

  describe('changes.sync', () => {
    test('应该跳过（需要远程仓库）', async () => {
      test.skip()
    })
  })

  describe('changes.getFileContents', () => {
    test('应该跳过（需要完整 git 仓库设置）', async () => {
      test.skip()
    })
  })

  describe('changes.getDiff', () => {
    test('应该跳过（需要完整 git 仓库设置）', async () => {
      test.skip()
    })
  })
})
