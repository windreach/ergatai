/**
 * E2E UI 测试 - 窗口管理和应用信息
 */

import { test, expect, describe, beforeAll, afterAll } from '@playwright/test'
import { launchElectron } from '../../fixtures/electron-launcher'

describe('E2E: 窗口管理与应用信息', () => {
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
    await electron.close()
  })

  describe('应用信息', () => {
    test('isPackaged 应该返回布尔值', async () => {
      const isPackaged = await page.evaluate(async () => {
        return await (window as any).desktopApi.isPackaged()
      })
      expect(typeof isPackaged).toBe('boolean')
    })

    test('getDefaultWorkspacePath 应该返回路径字符串', async () => {
      const defaultPath = await page.evaluate(async () => {
        return await (window as any).desktopApi.getDefaultWorkspacePath()
      })
      expect(typeof defaultPath).toBe('string')
      expect(defaultPath.length).toBeGreaterThan(0)
    })
  })

  describe('窗口管理', () => {
    test('windowIsMaximized 应该返回布尔值', async () => {
      const isMaximized = await page.evaluate(async () => {
        return await (window as any).desktopApi.windowIsMaximized()
      })
      expect(typeof isMaximized).toBe('boolean')
    })

    test('getZoom 应该返回数字', async () => {
      const zoom = await page.evaluate(async () => {
        return await (window as any).desktopApi.getZoom()
      })
      expect(typeof zoom).toBe('number')
      expect(zoom).toBeGreaterThan(0)
    })

    test('getWindowFrameState 应该返回布尔值', async () => {
      const frameState = await page.evaluate(async () => {
        return await (window as any).desktopApi.getWindowFrameState()
      })
      expect(typeof frameState).toBe('boolean')
    })
  })

  describe('剪贴板', () => {
    test('clipboardWrite 和 clipboardRead 应该工作', async () => {
      const testText = `ergatai-test-${Date.now()}`

      await page.evaluate(async (text: string) => {
        await (window as any).desktopApi.clipboardWrite(text)
      }, testText)

      const read = await page.evaluate(async () => {
        return await (window as any).desktopApi.clipboardRead()
      })

      expect(read).toBe(testText)
    })
  })

  describe('更新通道', () => {
    test('getUpdateChannel 在打包应用中应该返回合法值', async () => {
      // 开发/测试模式下 auto-updater 可能未注册 handler
      const isPackaged = await page.evaluate(async () => {
        return await (window as any).desktopApi.isPackaged()
      })

      if (!isPackaged) {
        test.skip()
        return
      }

      const channel = await page.evaluate(async () => {
        return await (window as any).desktopApi.getUpdateChannel()
      })
      expect(['latest', 'beta']).toContain(channel)
    })
  })

  describe('多次 API 调用稳定性', () => {
    test('连续调用 100 次应该全部成功', async () => {
      const results = await page.evaluate(async () => {
        const promises = []
        for (let i = 0; i < 100; i++) {
          promises.push(
            (window as any).trpc.test.isTestMode.query().catch((e: any) => `error-${i}`)
          )
        }
        return await Promise.all(promises)
      })

      const errors = results.filter((r: any) => typeof r === 'string' && r.startsWith('error-'))
      expect(errors.length).toBe(0)
      expect(results.every((r: any) => r === true)).toBe(true)
    })

    test('并发创建和删除应该稳定', async () => {
      const createResults = await page.evaluate(async () => {
        const promises = []
        for (let i = 0; i < 20; i++) {
          promises.push(
            (window as any).trpc.test.projects.create.mutate({
              name: `concurrent-${i}`,
              path: `/tmp/concurrent-${i}`,
            })
          )
        }
        return await Promise.all(promises)
      })

      expect(createResults.length).toBe(20)
      expect(createResults.every((r: any) => r.id)).toBe(true)

      const deleteResults = await page.evaluate(async () => {
        const projects = await (window as any).trpc.test.projects.list.query()
        const promises = projects
          .filter((p: any) => p.name.startsWith('concurrent-'))
          .map((p: any) => (window as any).trpc.test.projects.delete.mutate({ id: p.id }))
        return await Promise.all(promises)
      })

      expect(deleteResults.length).toBe(20)

      const remaining = await page.evaluate(async () => {
        return await (window as any).trpc.test.projects.list.query()
      })
      expect(remaining.filter((p: any) => p.name.startsWith('concurrent-')).length).toBe(0)
    })
  })
})
