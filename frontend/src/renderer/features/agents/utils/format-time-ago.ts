/**
 * Format a timestamp as a human-readable "time ago" string.
 *
 * @param date - Date to format (Date object, timestamp number, ISO string, or undefined)
 * @returns Human-readable string like "2 minutes ago", "1 hour ago", etc.
 */
export function formatTimeAgo(date: Date | number | string | undefined | null): string {
  if (!date) {
    return 'just now'
  }

  const now = Date.now()
  const then = new Date(date).getTime()
  const diffMs = now - then

  if (diffMs < 0 || isNaN(then)) {
    return 'just now'
  }

  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)
  const diffWeek = Math.floor(diffDay / 7)
  const diffMonth = Math.floor(diffDay / 30)
  const diffYear = Math.floor(diffDay / 365)

  if (diffSec < 60) {
    return 'just now'
  } else if (diffMin < 60) {
    return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`
  } else if (diffHour < 24) {
    return `${diffHour} hour${diffHour === 1 ? '' : 's'} ago`
  } else if (diffDay < 7) {
    return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`
  } else if (diffWeek < 4) {
    return `${diffWeek} week${diffWeek === 1 ? '' : 's'} ago`
  } else if (diffMonth < 12) {
    return `${diffMonth} month${diffMonth === 1 ? '' : 's'} ago`
  } else {
    return `${diffYear} year${diffYear === 1 ? '' : 's'} ago`
  }
}

/**
 * Format a timestamp as a short relative time string.
 *
 * @param date - Date to format
 * @returns Short string like "2m", "1h", "3d", etc.
 */
export function formatTimeAgoShort(date: Date | number | string | undefined | null): string {
  if (!date) {
    return 'now'
  }

  const now = Date.now()
  const then = new Date(date).getTime()
  const diffMs = now - then

  if (diffMs < 0 || isNaN(then)) {
    return 'now'
  }

  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)
  const diffWeek = Math.floor(diffDay / 7)
  const diffMonth = Math.floor(diffDay / 30)
  const diffYear = Math.floor(diffDay / 365)

  if (diffSec < 60) {
    return 'now'
  } else if (diffMin < 60) {
    return `${diffMin}m`
  } else if (diffHour < 24) {
    return `${diffHour}h`
  } else if (diffDay < 7) {
    return `${diffDay}d`
  } else if (diffWeek < 4) {
    return `${diffWeek}w`
  } else if (diffMonth < 12) {
    return `${diffMonth}mo`
  } else {
    return `${diffYear}y`
  }
}
