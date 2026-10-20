/**
 * IPC 单元测试 - Claude Settings Router
 * 注意：此 router 会修改 ~/.claude/settings.json
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

describe('IPC: Claude Settings Router', () => {
  let electron: any
  let page: any
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  let originalSettings: string | null = null

  beforeAll(async () => {
    electron = await launchElectron({
      extraEnv: { NODE_ENV: 'test', ELECTRON_TEST_MODE: 'true' },
    })
    page = electron.page

    // 保存原始设置
    try {
      originalSettings = await fs.readFile(settingsPath, 'utf-8')
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
    // 恢复原始设置
    if (originalSettings !== null) {
      await fs.writeFile(settingsPath, originalSettings, 'utf-8').catch(() => {})
    } else {
      // 如果原本不存在，删除测试创建的文件
      await fs.unlink(settingsPath).catch(() => {})
    }
    await electron.close()
  })

  beforeEach(async () => {
    // 每个测试前重置设置
    if (originalSettings !== null) {
      await fs.writeFile(settingsPath, originalSettings, 'utf-8').catch(() => {})
    }
  })

  describe('claudeSettings.getIncludeCoAuthoredBy', () => {
    test('应该返回布尔值', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.claudeSettings.getIncludeCoAuthoredBy.query()
      })

      expect(typeof result).toBe('boolean')
    })

    test('默认应该返回 true', async () => {
      const result = await page.evaluate(async () => {
        return await (window as any).trpc.claudeSettings.getIncludeCoAuthoredBy.query()
      })

      expect(result).toBe(true)
    })
  })

  describe('claudeSettings.setIncludeCoAuthoredBy', () => {
    test('应该能够禁用', async () => {
      const setResult = await page.evaluate(async () => {
        return await (window as any).trpc.claudeSettings.setIncludeCoAuthoredBy.mutate({ enabled: false })
      })

      expect(setResult.success).toBe(true)

      const getResult = await page.evaluate(async () => {
        return await (window as any).trpc.claudeSettings.getIncludeCoAuthoredBy.query()
      })

      expect(getResult).toBe(false)
    })

    test('应该能够启用', async () => {
      // 先禁用
      await page.evaluate(async () => {
        await (window as any).trpc.claudeSettings.setIncludeCoAuthoredBy.mutate({ enabled: false })
      })

      // 再启用
      const setResult = await page.evaluate(async () => {
        return await (window as any).trpc.claudeSettings.setIncludeCoAuthoredBy.mutate({ enabled: true })
      })

      expect(setResult.success).toBe(true)

      const getResult = await page.evaluate(async () => {
        return await (window as any).trpc.claudeSettings.getIncludeCoAuthoredBy.query()
      })

      expect(getResult).toBe(true)
    })
  })

  describe('claudeSettings.getEnabledPlugins', () => {
    test('应该返回字符串数组', async () => {
      const plugins = await page.evaluate(async () => {
        return await (window as any).trpc.claudeSettings.getEnabledPlugins.query()
      })

      expect(Array.isArray(plugins)).toBe(true)
      for (const plugin of plugins) {
        expect(typeof plugin).toBe('string')
      }
    })
  })

  describe('claudeSettings.setPluginEnabled', () => {
    test('应该能够启用插件', async () => {
      const pluginSource = 'test-plugin:source'

      const setResult = await page.evaluate(async (ps: string) => {
        return await (window as any).trpc.claudeSettings.setPluginEnabled.mutate({
          pluginSource: ps,
          enabled: true,
        })
      }, pluginSource)

      expect(setResult.success).toBe(true)

      const plugins = await page.evaluate(async () => {
        return await (window as any).trpc.claudeSettings.getEnabledPlugins.query()
      })

      expect(plugins).toContain(pluginSource)
    })

    test('应该能够禁用插件', async () => {
      const pluginSource = 'test-plugin:disable'

      // 先启用
      await page.evaluate(async (ps: string) => {
        await (window as any).trpc.claudeSettings.setPluginEnabled.mutate({
          pluginSource: ps,
          enabled: true,
        })
      }, pluginSource)

      // 再禁用
      const setResult = await page.evaluate(async (ps: string) => {
        return await (window as any).trpc.claudeSettings.setPluginEnabled.mutate({
          pluginSource: ps,
          enabled: false,
        })
      }, pluginSource)

      expect(setResult.success).toBe(true)

      const plugins = await page.evaluate(async () => {
        return await (window as any).trpc.claudeSettings.getEnabledPlugins.query()
      })

      expect(plugins).not.toContain(pluginSource)
    })
  })

  describe('claudeSettings.getApprovedPluginMcpServers', () => {
    test('应该返回字符串数组', async () => {
      const servers = await page.evaluate(async () => {
        return await (window as any).trpc.claudeSettings.getApprovedPluginMcpServers.query()
      })

      expect(Array.isArray(servers)).toBe(true)
      for (const server of servers) {
        expect(typeof server).toBe('string')
      }
    })
  })

  describe('claudeSettings.approvePluginMcpServer', () => {
    test('应该能够批准 MCP 服务器', async () => {
      const identifier = 'test-plugin:test-server'

      const result = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.claudeSettings.approvePluginMcpServer.mutate({ identifier: id })
      }, identifier)

      expect(result.success).toBe(true)

      const servers = await page.evaluate(async () => {
        return await (window as any).trpc.claudeSettings.getApprovedPluginMcpServers.query()
      })

      expect(servers).toContain(identifier)
    })
  })

  describe('claudeSettings.revokePluginMcpServer', () => {
    test('应该能够撤销批准', async () => {
      const identifier = 'test-plugin:revoke-server'

      // 先批准
      await page.evaluate(async (id: string) => {
        await (window as any).trpc.claudeSettings.approvePluginMcpServer.mutate({ identifier: id })
      }, identifier)

      // 再撤销
      const result = await page.evaluate(async (id: string) => {
        return await (window as any).trpc.claudeSettings.revokePluginMcpServer.mutate({ identifier: id })
      }, identifier)

      expect(result.success).toBe(true)

      const servers = await page.evaluate(async () => {
        return await (window as any).trpc.claudeSettings.getApprovedPluginMcpServers.query()
      })

      expect(servers).not.toContain(identifier)
    })
  })

  describe('claudeSettings.approveAllPluginMcpServers', () => {
    test('应该能够批量批准', async () => {
      const pluginSource = 'batch-plugin'
      const serverNames = ['server1', 'server2', 'server3']

      const result = await page.evaluate(async (args: { pluginSource: string; serverNames: string[] }) => {
        return await (window as any).trpc.claudeSettings.approveAllPluginMcpServers.mutate(args)
      }, { pluginSource, serverNames })

      expect(result.success).toBe(true)

      const servers = await page.evaluate(async () => {
        return await (window as any).trpc.claudeSettings.getApprovedPluginMcpServers.query()
      })

      expect(servers).toContain('batch-plugin:server1')
      expect(servers).toContain('batch-plugin:server2')
      expect(servers).toContain('batch-plugin:server3')
    })
  })

  describe('claudeSettings.revokeAllPluginMcpServers', () => {
    test('应该能够批量撤销', async () => {
      const pluginSource = 'revoke-batch-plugin'
      const serverNames = ['server1', 'server2']

      // 先批准
      await page.evaluate(async (args: { pluginSource: string; serverNames: string[] }) => {
        await (window as any).trpc.claudeSettings.approveAllPluginMcpServers.mutate(args)
      }, { pluginSource, serverNames })

      // 再批量撤销
      const result = await page.evaluate(async (ps: string) => {
        return await (window as any).trpc.claudeSettings.revokeAllPluginMcpServers.mutate({ pluginSource: ps })
      }, pluginSource)

      expect(result.success).toBe(true)

      const servers = await page.evaluate(async () => {
        return await (window as any).trpc.claudeSettings.getApprovedPluginMcpServers.query()
      })

      expect(servers).not.toContain('revoke-batch-plugin:server1')
      expect(servers).not.toContain('revoke-batch-plugin:server2')
    })
  })
})
