/**
 * URL validation utilities
 */

/**
 * Validate that a URL uses only HTTP or HTTPS schemes
 * Throws an error if the URL is invalid or uses an unsafe scheme
 *
 * @param url - The URL to validate
 * @throws Error if the URL is invalid or uses a non-HTTP(S) scheme
 */
export function validateHttpUrl(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Blocked unsafe URL scheme: ${parsed.protocol}`)
    }
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error("Invalid URL")
    }
    throw err
  }
}

/**
 * Check if a URL is a safe HTTP/HTTPS URL
 *
 * @param url - The URL to check
 * @returns true if the URL is valid and uses HTTP or HTTPS, false otherwise
 */
export function isSafeHttpUrl(url: string): boolean {
  try {
    validateHttpUrl(url)
    return true
  } catch {
    return false
  }
}
