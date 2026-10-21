/**
 * Shared test fixture for IPC tests.
 *
 * Eliminates boilerplate across 26+ test files that all need:
 * - Electron launch with NODE_ENV=test
 * - Process exit/SIGINT safety handlers
 * - beforeEach cleanup via test router
 * - afterAll electron close
 *
 * Usage:
 * ```ts
 * import { createTestContext } from '../../fixtures/test-context'
 *
 * describe('IPC: My Feature', () => {
 *   const ctx = createTestContext()
 *
 *   // Optional: extra beforeAll setup
 *   ctx.beforeAll(async (page) => {
 *     // create test dirs, data, etc.
 *   })
 *
 *   // Optional: extra afterAll cleanup
 *   ctx.afterAll(async (page) => {
 *     // remove temp dirs, etc.
 *   })
 *
 *   test('my test', async () => {
 *     const result = await ctx.page.evaluate(async () => {
 *       return await (window as any).trpc.test.myFeature.query()
 *     })
 *     expect(result).toBeDefined()
 *   })
 * })
 * ```
 */

import { test, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchElectron } from './electron-launcher'

interface TestContext {
  /** The Electron app instance */
  electron: any
  /** The main page (renderer process) */
  page: any
}

interface TestContextOptions {
  /** Skip the automatic beforeEach cleanup (for tests that manage their own state) */
  skipAutoCleanup?: boolean
  /** Extra environment variables to pass to Electron */
  extraEnv?: Record<string, string>
}

/**
 * Create a shared test context that handles Electron lifecycle and cleanup.
 *
 * This replaces the repeated boilerplate of:
 * - beforeAll: launchElectron + exit handlers
 * - afterAll: electron.close()
 * - beforeEach: trpc.test.helpers.cleanup
 */
export function createTestContext(options: TestContextOptions = {}) {
  const ctx: TestContext = {
    electron: null,
    page: null,
  }

  const extraBeforeAll: Array<(page: any) => Promise<void>> = []
  const extraAfterAll: Array<(page: any) => Promise<void>> = []

  beforeAll(async () => {
    ctx.electron = await launchElectron({
      extraEnv: {
        NODE_ENV: 'test',
        ELECTRON_TEST_MODE: 'true',
        ...options.extraEnv,
      },
    })
    ctx.page = ctx.electron.page

    // Process exit safety: ensure Electron is closed even if tests hang
    process.on('exit', async () => {
      if (ctx.electron) {
        try { await ctx.electron.close() } catch (_e) { /* ignore */ }
      }
    })
    process.on('SIGINT', async () => {
      if (ctx.electron) { await ctx.electron.close() }
      process.exit(130)
    })

    // Run any extra beforeAll hooks
    for (const hook of extraBeforeAll) {
      await hook(ctx.page)
    }
  })

  afterAll(async () => {
    // Run any extra afterAll hooks (before closing electron)
    for (const hook of extraAfterAll) {
      await hook(ctx.page)
    }

    if (ctx.electron) {
      await ctx.electron.close()
    }
  })

  if (!options.skipAutoCleanup) {
    beforeEach(async () => {
      if (ctx.page) {
        await ctx.page.evaluate(async () => {
          await (window as any).trpc.test.helpers.cleanup.mutate()
        })
      }
    })
  }

  // Return a proxy that allows registering extra hooks
  return {
    /** The Electron app instance (available after beforeAll) */
    get electron() { return ctx.electron },
    /** The main page (available after beforeAll) */
    get page() { return ctx.page },

    /** Register an extra beforeAll hook (runs after Electron launch) */
    beforeAll(fn: (page: any) => Promise<void>) {
      extraBeforeAll.push(fn)
    },

    /** Register an extra afterAll hook (runs before Electron close) */
    afterAll(fn: (page: any) => Promise<void>) {
      extraAfterAll.push(fn)
    },
  }
}
