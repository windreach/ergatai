/// <reference types="vite/client" />

// Extend Vite's ImportMetaEnv with our custom env vars
declare global {
  interface ImportMetaEnv {
    // Main process (MAIN_VITE_ prefix)
    readonly MAIN_VITE_SENTRY_DSN?: string
    readonly MAIN_VITE_POSTHOG_KEY?: string
    readonly MAIN_VITE_POSTHOG_HOST?: string

    // Renderer process (Vite_ prefix)
    readonly VITE_POSTHOG_KEY?: string
    readonly VITE_POSTHOG_HOST?: string
    readonly VITE_ERGATAI_TERMINAL_PROVIDER?:
      | "backend-managed"
      | "legacy-electron-local"
  }
}

export {}
