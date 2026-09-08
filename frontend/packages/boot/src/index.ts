/**
 * @module @ergatai/boot
 *
 * Boot kernel for the Ergatai frontend module system.
 * Creates the root context, loads plugins, and mounts the application.
 */

import type { ErgataiContext, EventMap, Plugin } from '@ergatai/core-plugin-types'
import { EventBus } from '@ergatai/core-events'
import { SlotService } from '@ergatai/core-slots'

/**
 * Options for the boot function.
 */
export interface BootOptions {
  /** Plugins loaded by the application host. */
  plugins: Plugin[]
}

/**
 * Implementation of the ErgataiContext interface.
 */
class ErgataiContextImpl implements ErgataiContext {
  private services = new Map<string, unknown>()
  private effects: Array<{ label: string; dispose: () => void }> = []
  private eventBus = new EventBus()
  private pendingInjections = new Map<string, Array<(ctx: ErgataiContext) => void>>()
  slots: SlotService

  constructor() {
    this.slots = new SlotService()
    // Provide the slot service on the context
    this.provide('slots', this.slots)
  }

  provide<T>(name: string, service: T): () => void {
    this.services.set(name, service)

    // Resolve any pending injections that were waiting for this service
    const pending = this.pendingInjections.get(name)
    if (pending) {
      for (const callback of pending) {
        callback(this)
      }
      this.pendingInjections.delete(name)
    }

    return () => {
      this.services.delete(name)
    }
  }

  get<T>(name: string): T | undefined {
    return this.services.get(name) as T | undefined
  }

  effect(body: () => (() => void) | void, label: string): void {
    const result = body()
    const dispose = typeof result === 'function' ? result : () => {}
    this.effects.push({ label, dispose })
  }

  on<K extends keyof EventMap>(name: K, listener: EventMap[K]): () => void {
    return this.eventBus.on(name, listener)
  }

  emit<K extends keyof EventMap>(name: K, ...args: Parameters<EventMap[K]>): void {
    this.eventBus.emit(name, ...args)
  }

  plugin(plugin: Plugin): void {
    // Check if all dependencies are available
    if (plugin.inject && plugin.inject.length > 0) {
      const missing = plugin.inject.filter(name => !this.services.has(name))
      if (missing.length > 0) {
        // Defer plugin loading until dependencies are available
        // For simplicity, we'll just register a pending injection for the first missing dep
        const firstMissing = missing[0]!
        let pending = this.pendingInjections.get(firstMissing)
        if (!pending) {
          pending = []
          this.pendingInjections.set(firstMissing, pending)
        }
        pending.push(() => this.plugin(plugin))
        return
      }
    }

    // All dependencies available, load the plugin
    plugin.apply(this)
  }

  inject(deps: string[], callback: (ctx: ErgataiContext) => void): void {
    const waitForMissing = (missing: string[]) => {
      for (const dep of missing) {
        let pending = this.pendingInjections.get(dep)
        if (!pending) {
          pending = []
          this.pendingInjections.set(dep, pending)
        }
        pending.push((ctx) => {
          const stillMissing = deps.filter(name => !ctx.get(name))
          if (stillMissing.length === 0) {
            callback(ctx)
          } else {
            waitForMissing(stillMissing)
          }
        })
      }
    }

    const missing = deps.filter(name => !this.services.has(name))
    if (missing.length === 0) {
      callback(this)
    } else {
      waitForMissing(missing)
    }
  }

  /**
   * Dispose all effects and clear state. Called during shutdown.
   */
  async dispose(): Promise<void> {
    // Dispose effects in reverse order
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i]!
      try {
        effect.dispose()
      } catch (error) {
        console.error(`Error disposing effect "${effect.label}":`, error)
      }
    }
    this.effects = []

    // Dispose services
    this.eventBus.dispose()
    this.slots.dispose()
    this.services.clear()
    this.pendingInjections.clear()
  }
}

/**
 * Boot the Ergatai frontend application.
 *
 * @param container - DOM element to mount the application into
 * @param options - Boot configuration and plugin list
 * @returns Promise that resolves when the app is mounted
 *
 * @example
 * ```typescript
 * // apps/web/src/main.ts
 * import { boot } from '@ergatai/boot'
 *
 * const el = document.getElementById('root')
 * if (!el) throw new Error('Missing #root element')
 *
 * void boot(el, {
 *   plugins: [layoutPlugin, uiRendererPlugin],
 * })
 * ```
 */
export async function boot(
  container: HTMLElement,
  options: BootOptions,
): Promise<ErgataiContext> {
  const ctx = new ErgataiContextImpl()

  try {
    for (const plugin of options.plugins) {
      ctx.plugin(plugin)
    }

    if (!ctx.get('uiRenderer')) {
      throw new Error('Boot requires the @ergatai/ui-renderer plugin.')
    }

    await new Promise<void>((resolve) => {
      ctx.inject(['uiRenderer'], (scope) => {
        scope.effect(() => {
          const uiRenderer = scope.get<{ mount: (element: HTMLElement) => void }>('uiRenderer')
          uiRenderer?.mount(container)
        }, 'boot: mount application')
        resolve()
      })
    })

    return ctx
  } catch (error) {
    console.error('[boot] Boot failed:', error)
    await ctx.dispose()
    throw error
  }
}

/**
 * Create a test context for unit testing plugins.
 *
 * @example
 * ```typescript
 * import { createTestContext } from '@ergatai/boot'
 *
 * test('plugin registers service', () => {
 *   const ctx = createTestContext()
 *   ctx.plugin(myPlugin)
 *   expect(ctx.get('myService')).toBeDefined()
 * })
 * ```
 */
export function createTestContext(): ErgataiContext {
  return new ErgataiContextImpl()
}
