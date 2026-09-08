/**
 * @module @ergatai/ui-renderer/client
 *
 * Client entry for the UI renderer plugin.
 * Provides the React mount service on ctx.uiRenderer.
 */

import { createElement, StrictMode, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ErgataiContext, Plugin } from '@ergatai/core-plugin-types'
import { SlotOutlet } from '@ergatai/core-slots'

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
  private appComponent: ComponentType | null = null

  private ctx: ErgataiContext

  constructor(ctx: ErgataiContext) {
    this.ctx = ctx
  }

  /**
   * Set the root application component to render.
   * This is called by the layout plugin to provide the root component.
   */
  setAppComponent(component: ComponentType): void {
    this.appComponent = component
    // If already mounted, re-render with new component
    if (this.root && this.appComponent) {
      this.root.render(<this.appComponent />)
    }
  }

  mount(container: HTMLElement): void {
    this.root = createRoot(container)

    if (this.appComponent) {
      this.root.render(<StrictMode><this.appComponent /></StrictMode>)
    } else {
      // SlotOutlet reacts to plugins that register before or after mount.
      this.root.render(
        <StrictMode>
          <SlotOutlet
            context={this.ctx}
            name="root"
            fallback={createElement(
              'div',
              { style: { padding: '2rem', textAlign: 'center' } },
              'Loading Ergatai...',
            )}
          />
        </StrictMode>
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

export const uiRendererPlugin: Plugin = {
  name: '@ergatai/ui-renderer',
  inject: ['slots'],
  apply,
}

export default uiRendererPlugin

// Declaration merging — add uiRenderer to ErgataiContext
declare module '@ergatai/core-plugin-types' {
  interface ErgataiContext {
    /** The UI renderer service — mount/unmount the React application. */
    uiRenderer?: IUIRenderer
  }
}
