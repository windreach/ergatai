/**
 * Shared projection-kind constants.
 *
 * Projection kind describes how a message is rendered in the conversation:
 * - `canonical`: normal in-thread message
 * - `side_copy`: rendered separately (e.g. inter-agent replies disclosure)
 * - `agent_output`: agent-emitted output projection
 *
 * Keep these as the single source of truth instead of scattering string literals.
 */
export const PROJECTION_KINDS = {
  CANONICAL: "canonical",
  SIDE_COPY: "side_copy",
  AGENT_OUTPUT: "agent_output",
} as const

export type ProjectionKind = (typeof PROJECTION_KINDS)[keyof typeof PROJECTION_KINDS]
