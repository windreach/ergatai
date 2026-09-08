/**
 * @module @ergatai/core-plugin-types
 *
 * Core plugin contract and Context interface for the Ergatai module system.
 * This is the foundation that all feature modules depend on.
 */

import type { ComponentType, ReactNode } from 'react'

// Re-export event types for convenience
export type { EventMap } from '@ergatai/core-events'

/**
 * The plugin contract. Every feature module exports one of these.
 *
 * @example
 * ```typescript
 * // packages/ui-layout/src/client/index.ts
 * export const inject = ['slots', 'theme', 'locale']
 *
 * export function apply(ctx: ErgataiContext): void {
 *   ctx.effect(() => {
 *     const dispose = ctx.provide('layout', new LayoutController())
 *     return dispose
 *   }, 'ui-layout: provide layout service')
 * }
 * ```
 */
export interface Plugin {
  /** Display name for diagnostics. */
  name?: string
  /** Service dependencies — plugin won't activate until all are available. */
  inject?: string[]
  /** Called once when the plugin loads. Register services, effects, and UI here. */
  apply(ctx: ErgataiContext): void
}

/**
 * The dependency injection context available to all plugins.
 *
 * Provides:
 * - Service registry (provide/get)
 * - Side effect tracking (effect)
 * - Typed event bus (on/emit)
 * - Plugin loading (plugin/inject)
 * - UI slot system (slots)
 *
 * Feature modules extend this interface via declaration merging to add
 * type-safe service access (e.g., `ctx.layout`, `ctx.chat`).
 *
 * @example
 * ```typescript
 * // In a feature module:
 * declare module '@ergatai/core-plugin-types' {
 *   interface ErgataiContext {
 *     layout: ILayout
 *   }
 * }
 * ```
 */
export interface ErgataiContext {
  // ── Service registry ──
  /**
   * Provide a service on the context. Returns a disposer that removes the service.
   *
   * @param name - Service name (e.g., 'layout', 'chat', 'theme')
   * @param service - The service instance
   * @returns Disposer function that removes the service when called
   *
   * @example
   * ```typescript
   * ctx.effect(() => {
   *   return ctx.provide('layout', new LayoutController())
   * }, 'provide layout')
   * ```
   */
  provide<T>(name: string, service: T): () => void

  /**
   * Get a service by name. Returns undefined if not provided.
   *
   * @param name - Service name
   * @returns The service instance, or undefined if not found
   *
   * @example
   * ```typescript
   * const layout = ctx.get<ILayout>('layout')
   * if (layout) layout.toggleSidebar()
   * ```
   */
  get<T>(name: string): T | undefined

  // ── Side effects ──
  /**
   * Register a disposable side effect. The body function should return a disposer
   * that cleans up the effect. All disposers are called in reverse order when the
   * context is disposed.
   *
   * @param body - Effect body that returns a disposer (or void if no cleanup needed)
   * @param label - Human-readable label for diagnostics
   *
   * @example
   * ```typescript
   * ctx.effect(() => {
   *   const interval = setInterval(poll, 1000)
   *   return () => clearInterval(interval)
   * }, 'polling effect')
   * ```
   */
  effect(body: () => (() => void) | void, label: string): void

  // ── Typed events ──
  /**
   * Subscribe to a typed event. Returns a disposer that removes the listener.
   *
   * @param name - Event name (must be a key of EventMap)
   * @param listener - Event handler
   * @returns Disposer function that removes the listener when called
   *
   * @example
   * ```typescript
   * ctx.effect(() => {
   *   return ctx.on('theme/change', (snapshot) => {
   *     applyTheme(snapshot)
   *   })
   * }, 'theme listener')
   * ```
   */
  on<K extends keyof EventMap>(name: K, listener: EventMap[K]): () => void

  /**
   * Emit a typed event. All listeners are called synchronously.
   *
   * @param name - Event name
   * @param args - Event arguments (type-checked against EventMap)
   *
   * @example
   * ```typescript
   * ctx.emit('theme/change', { mode: 'dark', colors: {...} })
   * ```
   */
  emit<K extends keyof EventMap>(name: K, ...args: Parameters<EventMap[K]>): void

  // ── Plugin loading ──
  /**
   * Load a plugin. The plugin's apply() function is called immediately if all
   * dependencies are available, or deferred until they are.
   *
   * @param plugin - The plugin to load
   *
   * @example
   * ```typescript
   * await ctx.plugin(LayoutPlugin)
   * ```
   */
  plugin(plugin: Plugin): void

  /**
   * Wait for services to be available, then run a callback. This is a convenience
   * for plugins that need to coordinate with other services.
   *
   * @param deps - Service names to wait for
   * @param callback - Function to run once all services are available
   *
   * @example
   * ```typescript
   * ctx.inject(['layout', 'theme'], (ctx) => {
   *   const layout = ctx.get<ILayout>('layout')
   *   layout.attachTheme(ctx.get<ITheme>('theme'))
   * })
   * ```
   */
  inject(deps: string[], callback: (ctx: ErgataiContext) => void): void

  // ── UI slot system ──
  /**
   * The slot service for UI composition. Allows plugins to register React components
   * into named slots, which are then rendered by the layout.
   */
  slots: SlotService
}

/**
 * Event map interface. Feature modules extend this via declaration merging to add
 * their own event types.
 *
 * @example
 * ```typescript
 * // In ui-theme:
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
 * Slot service interface for UI composition.
 */
export interface SlotService {
  /**
   * Register a React component into a named slot.
   *
   * @param registration - Slot registration config
   * @param component - React component to render
   * @returns Disposer that removes the registration
   *
   * @example
   * ```typescript
   * ctx.slots.register({
   *   name: 'sidebar',
   *   scope: 'root',
   * }, SidebarComponent)
   * ```
   */
  register<P>(
    registration: SlotRegistration,
    component: ComponentType<P>,
  ): () => void

  /**
   * Inject into a list slot (additive — doesn't replace existing entries).
   * This is a deferred registration that waits for the parent slot to exist.
   *
   * @param slotName - Parent slot name
   * @param factory - Factory function that performs the registration
   *
   * @example
   * ```typescript
   * ctx.slots.inject('settings.general.item', () =>
   *   ctx.slots.register({
   *     name: 'settings.general.item',
   *     id: 'transcript-view',
   *     order: 12,
   *   }, TranscriptViewRow))
   * ```
   */
  inject(slotName: string, factory: () => () => void): void

  /**
   * Render a slot's occupants. Called by the React renderer to display slot content.
   *
   * @param slotName - Slot name to render
   * @param ownerProps - Props passed to the slot occupants
   * @returns React node(s) to render
   */
  renderSlot(slotName: string, ownerProps?: Record<string, unknown>): ReactNode
}

/**
 * Configuration for registering a component into a slot.
 */
export interface SlotRegistration {
  /** Slot name (e.g., 'sidebar', 'conversation', 'shell.overlay'). */
  name: string
  /** Entry ID (for list slots — must be unique within the slot). */
  id?: string
  /** Sort order (for list slots). Lower numbers render first. */
  order?: number
  /** When this slot is mounted. Defaults to 'root'. */
  scope?: 'root' | 'session' | 'session-maybe'
  /** Child slots declared by this registration. */
  children?: Record<string, SlotDefinition>
  /** State store factory (for module-owned state). */
  store?: () => unknown
  /** Props injection hook — receives bound store actions, returns props. */
  inject?: (actions: unknown) => Record<string, unknown>
  /** Locale namespace for i18n. */
  locale?: string
}

/**
 * Definition of a child slot within a registration.
 */
export interface SlotDefinition {
  /** One occupant ('single') or multiple ('list') or keyed ('keyed'). */
  kind: 'single' | 'list' | 'keyed'
  /** When this slot is mounted. */
  scope: 'root' | 'session' | 'session-maybe'
  /** Props injection for child occupants. */
  inject?: Record<string, unknown>
}
