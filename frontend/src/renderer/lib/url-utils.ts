/**
 * URL validation utilities for renderer process
 */

/**
 * Check if a URL is a safe HTTP/HTTPS URL
 *
 * @param url - The URL to check
 * @returns true if the URL is valid and uses HTTP or HTTPS, false otherwise
 */
export function isSafeHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}
