import { trpc } from "@/lib/trpc"

const HTTP_URL_REGEX = /^https?:\/\//i

/**
 * Resolve a remote image URL to a locally cached file:// URL.
 *
 * The actual download/cache happens in the Electron main process under
 * ~/.local/share/ergatai/agent-logos. While caching (or on failure) the
 * original remote URL is returned so the UI keeps working.
 */
export function useCachedRemoteImage(url: string | null | undefined): string | null {
  const enabled = !!url && HTTP_URL_REGEX.test(url)
  const query = trpc.files.cacheRemoteImage.useQuery(
    { url: url ?? "" },
    { enabled, staleTime: Infinity, retry: false },
  )

  if (!url) return null

  if (!HTTP_URL_REGEX.test(url)) {
    return url
  }

  const localPath = query.data?.path
  if (localPath) {
    return `file://${localPath}`
  }

  // Fall back to the remote URL while caching (or if caching failed).
  return url
}
