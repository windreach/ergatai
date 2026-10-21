/**
 * Shared test helpers for generating valid test data
 */

/**
 * Generate a valid project ID for tests
 * Format: proj_{timestamp}_{instance}_{sequence}
 */
export function generateTestProjectId(): string {
  const timestamp = Date.now() - 1288834974657 // Snowflake epoch
  return `proj_${timestamp}_000_0000`
}

/**
 * Generate a valid workspace ID for tests
 * Format: ws_{timestamp}_{instance}_{sequence}
 */
export function generateTestWorkspaceId(): string {
  const timestamp = Date.now() - 1288834974657
  return `ws_${timestamp}_000_0000`
}
