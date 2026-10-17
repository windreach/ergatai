/**
 * Typed module for DevTools unlock state.
 * Replaces the (global as any).__unlockDevTools anti-pattern.
 *
 * The DevTools menu item is hidden by default in packaged builds.
 * Users can unlock it via a hidden feature (5 clicks on Beta tab),
 * which triggers the IPC handler that calls unlockDevTools().
 */

type UnlockCallback = () => void;

let unlocked = false;
const listeners: UnlockCallback[] = [];

/**
 * Mark DevTools as unlocked and notify listeners (e.g., menu rebuild).
 * Idempotent — calling multiple times has no additional effect.
 */
export function unlockDevTools(): void {
  if (!unlocked) {
    unlocked = true;
    // Copy array to prevent modification during iteration
    const listenersCopy = [...listeners];
    for (const listener of listenersCopy) {
      try {
        listener();
      } catch (err) {
        console.error("[DevTools] Listener error:", err);
      }
    }
  }
}

/**
 * Check if DevTools has been unlocked.
 */
export function isDevToolsUnlocked(): boolean {
  return unlocked;
}

/**
 * Register a callback to be invoked when DevTools is unlocked.
 * Used by the menu builder to rebuild the menu when the unlock happens.
 * Returns an unsubscribe function.
 */
export function onUnlock(callback: UnlockCallback): () => void {
  listeners.push(callback);
  return () => {
    const index = listeners.indexOf(callback);
    if (index >= 0) listeners.splice(index, 1);
  };
}
