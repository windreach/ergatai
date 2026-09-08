/**
 * @module @ergatai/core-slots
 *
 * Slot system for UI composition in the Ergatai module system.
 * Allows feature modules to register React components into named slots,
 * which are then rendered by the layout.
 */

import { createElement, Fragment, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { ErgataiContext, SlotRegistration } from '@ergatai/core-plugin-types'

/**
 * Slot map interface. Feature modules extend this via declaration merging to declare
 * which slots they own and what props they accept.
 *
 * @example
 * ```typescript
 * // In packages/ui-layout/src/client/index.ts:
 * declare module '@ergatai/core-slots' {
 *   interface SlotMap {
 *     'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
 *     'conversation': { kind: 'single'; scope: 'session-maybe' }
 *     'shell.overlay': { kind: 'list'; scope: 'root' }
 *   }
 * }
 * ```
 */
export interface SlotMap {
  // Feature modules extend this via declaration merging
}

/**
 * Public representation of a slot registration, used by renderer outlets.
 */
export interface SlotEntry {
  id: string
  order: number
  component: ComponentType<unknown>
  registration: SlotRegistration
}

const EMPTY_ENTRIES: readonly SlotEntry[] = Object.freeze([])

/**
 * Slot service implementation.
 */
export class SlotService {
  private slots = new Map<string, SlotEntry[]>()
  private pendingInjections = new Map<string, Array<() => () => void>>()
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  /**
   * Register a React component into a named slot.
   */
  register<P>(
    registration: SlotRegistration,
    component: ComponentType<P>,
  ): () => void {
    const slotName = registration.name
    const id = registration.id ?? `auto-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const order = registration.order ?? 0

    const entry: SlotEntry = {
      id,
      order,
      component: component as ComponentType<unknown>,
      registration,
    }

    let entries = this.slots.get(slotName)
    if (!entries) {
      entries = []
    } else {
      entries = [...entries]
    }
    this.slots.set(slotName, entries)

    if ((registration.kind ?? 'single') === 'single') {
      entries = [entry]
      this.slots.set(slotName, entries)
    } else {
      entries.push(entry)
    }

    // Sort by order
    entries.sort((a, b) => a.order - b.order)
    this.notify()

    // Process any pending injections for this slot
    const pending = this.pendingInjections.get(slotName)
    if (pending) {
      for (const factory of pending) {
        factory()
      }
      this.pendingInjections.delete(slotName)
      this.notify()
    }

    // Return disposer
    return () => {
      const remaining = (this.slots.get(slotName) ?? []).filter(entry => entry.id !== id)
      if (remaining.length > 0) {
        this.slots.set(slotName, remaining)
      } else {
        this.slots.delete(slotName)
      }
      this.notify()
    }
  }

  /**
   * Inject into a list slot (additive — doesn't replace existing entries).
   * If the parent slot doesn't exist yet, the injection is deferred.
   */
  inject(slotName: string, factory: () => () => void): void {
    const entries = this.slots.get(slotName)
    if (!entries || entries.length === 0) {
      // Defer injection until slot exists
      let pending = this.pendingInjections.get(slotName)
      if (!pending) {
        pending = []
        this.pendingInjections.set(slotName, pending)
      }
      pending.push(factory)
    } else {
      // Slot exists, inject immediately
      factory()
    }
  }

  /**
   * Render a slot's occupants.
   */
  renderSlot(slotName: string, ownerProps?: Record<string, unknown>): ReactNode {
    const entries = this.slots.get(slotName)
    if (!entries || entries.length === 0) {
      return null
    }

    // For single-occupant slots, render the first entry
    // For list slots, render all entries
    const elements = entries.map(entry =>
      createElement(entry.component, { key: entry.id, ...ownerProps })
    )

    if (elements.length === 1) {
      return elements[0]
    }

    return createElement(Fragment, null, ...elements)
  }

  /**
   * Check if a slot has any occupants.
   */
  hasSlot(slotName: string): boolean {
    const entries = this.slots.get(slotName)
    return entries !== undefined && entries.length > 0
  }

  /**
   * Get all slot names that have occupants.
   */
  getSlotNames(): string[] {
    return Array.from(this.slots.keys())
  }

  getEntries(slotName: string): readonly SlotEntry[] {
    return this.slots.get(slotName) ?? EMPTY_ENTRIES
  }

  /**
   * Remove all registrations. Called during context disposal.
   */
  dispose(): void {
    this.slots.clear()
    this.pendingInjections.clear()
    this.notify()
  }
}

export function SlotOutlet({ context, name, props, fallback = null }: {
  context: ErgataiContext
  name: string
  props?: Record<string, unknown>
  fallback?: ReactNode
}): ReactNode {
  const entries = useSyncExternalStore(
    context.slots.subscribe,
    () => context.slots.getEntries(name),
  )

  if (entries.length === 0) {
    return fallback
  }

  return createElement(
    Fragment,
    null,
    entries.map(entry =>
      createElement((entry as SlotEntry).component, { key: (entry as SlotEntry).id, ...props }),
    ),
  )
}
