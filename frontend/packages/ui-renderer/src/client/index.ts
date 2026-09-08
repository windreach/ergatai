/**
 * @module @ergatai/ui-renderer/client
 *
 * Client entry for the UI renderer plugin.
 * Provides the React mount service on ctx.uiRenderer.
 */

import { createRoot, type Root } from 'react-dom/client'
import type { ErgataiContext } from '@ergatai/core-plugin-types'

/**
 * UI Renderer service interface.
 */
export interface IUIRenderer {
  /**
   * Mount the React application into a DOM element.
   * @param container - DOM element to mount into
   */
  mount(container: HTMLElement): void

  /**
   * Unmount the React application.
   */
  unmount(): void
}

/**
 * UI Renderer service implementation.
 */
class UIRenderer implements IUIRenderer {
  private root: Root | null = null
  private appComponent: React.ComponentType | null = null

  constructor(private ctx: ErgataiContext) {}

  /**
   * Set the root application component to render.
   * This is called by the layout plugin to provide the root component.
   */
  setAppComponent(component: React.ComponentType): void {
    this.appComponent = component
    // If already mounted, re-render with new component
    if (this.root && this.appComponent) {
      this.root.render(<this.appComponent />)
    }
  }

  mount(container: HTMLElement): void {
    this.root = createRoot(container)

    // Render the root slot content
    // The layout plugin should have registered into the 'root' slot
    const rootContent = this.ctx.slots.renderSlot('root')

    if (this.appComponent) {
      this.root.render(<this.appComponent />)
    } else if (rootContent) {
      // Wrap slot content in a basic container
      this.root.render(
        <div id="ergatai-app">
          {rootContent}
        </div>
      )
    } else {
      // No content registered yet — show loading state
      this.root.render(
        <div id="ergatai-app" style={{ padding: '2rem', textAlign: 'center' }}>
          <p>Loading Ergatai...</p>
        </div>
      )
    }
  }

  unmount(): void {
    if (this.root) {
      this.root.unmount()
      this.root = null
    }
  }
}

/**
 * Required services for the UI renderer plugin.
 */
export const inject = ['slots']

/**
 * Plugin apply function — provides the uiRenderer service.
 */
export function apply(ctx: ErgataiContext): void {
  const renderer = new UIRenderer(ctx)

  ctx.effect(() => {
    const dispose = ctx.provide('uiRenderer', renderer)
    return () => {
      renderer.unmount()
      dispose()
    }
  }, 'ui-renderer: provide service')
}

// Declaration merging — add uiRenderer to ErgataiContext
declare module '@ergatai/core-plugin-types' {
  interface ErgataiContext {
    /** The UI renderer service — mount/unmount the React application. */
    uiRenderer: IUIRenderer
  }
}

// Need React for JSX
import React from 'react'
