/**
 * @module @ergatai/boot
 *
 * Boot kernel for the Ergatai frontend module system.
 * Creates the root context, loads plugins, and mounts the application.
 */

import type { ErgataiContext, Plugin } from '@ergatai/core-plugin-types'
import { EventBus } from '@ergatai/core-events'
import { SlotService } from '@ergatai/core-slots'

/**
 * Boot manifest — declares which plugins to load.
 */
export interface BootManifest {
  plugins: Array<{
    /** Unique identifier for this plugin entry. */
    id: string
    /** npm package name or relative path. */
    name: string
    /** Plugin-specific configuration. */
    config?: Record<string, unknown>
    /** Whether this plugin is disabled. */
    disabled?: boolean
  }>
}

/**
 * Options for the boot function.
 */
export interface BootOptions {
  /** Static shared modules (singletons like React, core services). */
  staticModules?: Record<string, unknown>
  /** Boot manifest declaring which plugins to load. */
  manifest: BootManifest
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
    const missing = deps.filter(name => !this.services.has(name))
    if (missing.length > 0) {
      // Wait for all dependencies
      for (const dep of missing) {
        let pending = this.pendingInjections.get(dep)
        if (!pending) {
          pending = []
          this.pendingInjections.set(dep, pending)
        }
        pending.push((ctx) => {
          // Check again if all deps are now available
          const stillMissing = deps.filter(name => !ctx.get(name))
          if (stillMissing.length === 0) {
            callback(ctx)
          }
        })
      }
    } else {
      // All dependencies available, run immediately
      callback(this)
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

// Re-export EventMap for type compatibility
type EventMap = import('@ergatai/core-plugin-types').EventMap

/**
 * Boot the Ergatai frontend application.
 *
 * @param container - DOM element to mount the application into
 * @param options - Boot configuration (manifest, static modules)
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
 *   manifest: window.__ERGATAI_BOOT__,
 * })
 * ```
 */
export async function boot(
  container: HTMLElement,
  options: BootOptions,
): Promise<void> {
  const ctx = new ErgataiContextImpl()

  try {
    // Load all plugins from the manifest
    for (const entry of options.manifest.plugins) {
      if (entry.disabled) continue

      // In a real implementation, we'd dynamically import the plugin here
      // For now, we expect plugins to be registered via static imports
      // This is a placeholder for the dynamic loading logic
      console.log(`[boot] Loading plugin: ${entry.name} (id: ${entry.id})`)
    }

    // Mount the app through the uiRenderer service
    // This is deferred until the uiRenderer service is provided
    ctx.inject(['uiRenderer'], (scope) => {
      scope.effect(() => {
        const uiRenderer = scope.get<{ mount: (el: HTMLElement) => void }>('uiRenderer')
        if (uiRenderer) {
          uiRenderer.mount(container)
        }
        return () => {
          // Unmount logic would go here
        }
      }, 'boot: mount application')
    })

    console.log('[boot] Application boot complete')
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
