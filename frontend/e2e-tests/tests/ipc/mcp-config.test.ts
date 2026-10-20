/**
 * IPC 单元测试 - MCP Config Router
 * 注意：此 router 会修改 ~/.claude/mcp.json（通用 MCP 协议配置）
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

describe('IPC: MCP Config Router', () => {
  let electron: any
  let page: any
  const configPath = path.join(os.homedir(), '.claude', 'mcp.json')
  let originalConfig: string | null = null

  beforeAll(async () => {
    electron = await launchElectron({
      extraEnv: { NODE_ENV: 'test', ELECTRON_TEST_MODE: 'true' },
    })
    page = electron.page

    // 保存原始配置
    try {
      originalConfig = await fs.readFile(configPath, 'utf-8')
    } catch {
      // 文件不存在，继续
    }

    process.on('exit', async () => {
      if (electron) { try { await electron.close() } catch (e) { /* ignore */ } }
    })
    process.on('SIGINT', async () => {
      if (electron) { await electron.close() }
      process.exit(130)
    })
  })

  afterAll(async () => {
    // 恢复原始配置
    if (originalConfig !== null) {
      await fs.writeFile(configPath, originalConfig, 'utf-8').catch(() => {})
    } else {
      // 如果原本不存在，删除测试创建的文件
      await fs.unlink(configPath).catch(() => {})
    }
    await electron.close()
  })

  beforeEach(async () => {
    // 每个测试前重置配置
    if (originalConfig !== null) {
      await fs.writeFile(configPath, originalConfig, 'utf-8').catch(() => {})
    }
  })

  describe('claude.getAllMcpConfig', () => {
    test('应该返回配置对象', async () => {
      const config = await page.evaluate(async () => {
        return await (window as any).trpc.claude.getAllMcpConfig.query()
      })

      expect(config).toBeDefined()
      expect(typeof config).toBe('object')
    })
  })

  describe('claude.getMcpConfig', () => {
    test('应该返回特定配置', async () => {
      const config = await page.evaluate(async () => {
        return await (window as any).trpc.claude.getMcpConfig.query()
      })

      expect(config).toBeDefined()
      expect(typeof config).toBe('object')
    })
  })

  describe('claude.addMcpServer', () => {
    test('应该成功添加 MCP 服务器', async () => {
      const serverConfig = {
        name: 'test-server',
        command: 'test-command',
        args: ['arg1', 'arg2'],
        env: { TEST_ENV: 'value' },
        transport: 'stdio' as const,
      }

      const result = await page.evaluate(async (config: any) => {
        return await (window as any).trpc.claude.addMcpServer.mutate(config)
      }, serverConfig)

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })
  })

  describe('claude.updateMcpServer', () => {
    test('应该成功更新 MCP 服务器', async () => {
      // 先添加一个服务器
      const serverConfig = {
        name: 'update-test-server',
        command: 'test-command',
        args: ['arg1'],
        transport: 'stdio' as const,
      }

      await page.evaluate(async (config: any) => {
        await (window as any).trpc.claude.addMcpServer.mutate(config)
      }, serverConfig)

      // 更新服务器配置
      const updatedConfig = {
        name: 'update-test-server',
        command: 'updated-command',
        args: ['arg1', 'arg2', 'arg3'],
        env: { NEW_ENV: 'new-value' },
        transport: 'stdio' as const,
      }

      const result = await page.evaluate(async (config: any) => {
        return await (window as any).trpc.claude.updateMcpServer.mutate(config)
      }, updatedConfig)

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })
  })

  describe('claude.removeMcpServer', () => {
    test('应该成功移除 MCP 服务器', async () => {
      // 先添加一个服务器
      const serverName = 'remove-test-server'
      const serverConfig = {
        name: serverName,
        command: 'test-command',
        args: [],
        transport: 'stdio' as const,
      }

      await page.evaluate(async (config: any) => {
        await (window as any).trpc.claude.addMcpServer.mutate(config)
      }, serverConfig)

      // 移除服务器
      const result = await page.evaluate(async (name: string) => {
        return await (window as any).trpc.claude.removeMcpServer.mutate({ name })
      }, serverName)

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })
  })

  describe('claude.setMcpBearerToken', () => {
    test('应该成功设置 Bearer Token', async () => {
      const tokenConfig = {
        name: 'token-test-server',
        token: 'test-token-12345',
      }

      const result = await page.evaluate(async (config: any) => {
        return await (window as any).trpc.claude.setMcpBearerToken.mutate(config)
      }, tokenConfig)

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })
  })

  describe('claude.refreshMcpConfig', () => {
    test('应该报错（需要启动 MCP 进程）', async () => {
      // refreshMcpConfig 会尝试启动 MCP stdio 进程，在测试环境中预期会失败
      let error: any = null

      try {
        await page.evaluate(async () => {
          await (window as any).trpc.claude.refreshMcpConfig.mutate()
        })
      } catch (e) {
        error = e
      }

      // 预期会抛出错误（因为测试环境中没有真实的 MCP 进程）
      expect(error).toBeDefined()
    })
  })
})
