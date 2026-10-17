export async function initAnalytics() {}

export function capture(_eventName: string, _properties?: Record<string, unknown>) {}

export function identify(_userId?: string, _traits?: Record<string, unknown>) {}

export function getCurrentUserId(): string | null {
  return "local-user"
}

export function reset() {}

export function shutdown() {}

export function trackMessageSent(data: Record<string, unknown>) {
  capture("message_sent", data)
}
