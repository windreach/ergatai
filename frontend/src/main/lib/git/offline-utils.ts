import { checkInternetConnection } from '../ollama'

/**
 * Warns if a git command requires internet connection and we're offline.
 * Returns a warning message if the command will likely fail, null otherwise.
 */
export async function warnIfOfflineGitOperation(command: string): Promise<string | null> {
  // Use word boundary matching to avoid false positives
  // e.g., "git push" should match but "git pusher" should not
  const requiresInternet = [
    /\bgit\s+push\b/,
    /\bgit\s+pull\b/,
    /\bgit\s+fetch\b/,
    /\bgit\s+clone\b/,
    /\bgh\s+pr\b/,
    /\bgh\s+issue\b/,
    /\bgh\s+repo\b/,
  ].some(pattern => pattern.test(command))

  if (requiresInternet) {
    const hasInternet = await checkInternetConnection()

    if (!hasInternet) {
      return `⚠️ Warning: "${command}" requires internet connection and will likely fail.`
    }
  }

  return null
}
