//! Shared string constants for the API crate.

/// Projection kind for normal in-thread messages.
pub const PROJECTION_KIND_CANONICAL: &str = "canonical";
/// Projection kind for side-copy projections (e.g. inter-agent replies).
pub const PROJECTION_KIND_SIDE_COPY: &str = "side_copy";
/// Projection kind for agent-emitted output.
pub const PROJECTION_KIND_AGENT_OUTPUT: &str = "agent_output";
