/**
 * @module @ergatai/core-events
 *
 * Typed event bus for the Ergatai module system.
 * Feature modules extend the EventMap interface via declaration merging.
 */

/**
 * Event map interface. Feature modules extend this via declaration merging to add
 * their own event types.
 *
 * @example
 * ```typescript
 * // In packages/ui-theme/src/client/index.ts:
 * declare module '@ergatai/core-events' {
 *   interface EventMap {
 *     'theme/change'(snapshot: ThemeSnapshot): void
 *   }
 * }
 * ```
 */
export interface EventMap {
  // Built-in events can be added here
  // Feature modules extend this via declaration merging
}

/**
 * Simple typed event bus implementation.
 */
export class EventBus {
  private listeners = new Map<keyof EventMap, Set<(...args: unknown[]) => void>>()

  /**
   * Subscribe to an event.
   * @param name - Event name
   * @param listener - Event handler
   * @returns Disposer function that removes the listener
   */
  on<K extends keyof EventMap>(name: K, listener: EventMap[K]): () => void {
    let set = this.listeners.get(name)
    if (!set) {
      set = new Set()
      this.listeners.set(name, set)
    }
    set.add(listener as (...args: unknown[]) => void)

    return () => {
      set!.delete(listener as (...args: unknown[]) => void)
      if (set!.size === 0) {
        this.listeners.delete(name)
      }
    }
  }

  /**
   * Emit an event. All listeners are called synchronously.
   * @param name - Event name
   * @param args - Event arguments
   */
  emit<K extends keyof EventMap>(name: K, ...args: Parameters<EventMap[K]>): void {
    const set = this.listeners.get(name)
    if (!set) return
    for (const listener of set) {
      listener(...args)
    }
  }

  /**
   * Remove all listeners. Called during context disposal.
   */
  dispose(): void {
    this.listeners.clear()
  }
}
