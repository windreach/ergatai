//! Orchestration module for multi-agent collaboration
//!
//! Provides DAG-based task topology for AI-friendly workflow management.

pub mod condition;
pub mod context;
pub mod critical_path;
pub mod dag_topology;
pub mod state_channel;
pub mod template;
pub mod yaml_parser;

// Re-export DAG types
pub use condition::Condition;
pub use context::DagContext;
pub use dag_topology::{
    ConditionBranch, ConditionalEdge, TaskComplexity, TaskGraph, TaskNode, TaskStatus,
};
pub use state_channel::{MergeStrategy, StateChannel, StateField, StateValueType};
pub use template::{extract_references, render_template};
pub use yaml_parser::{parse_dag_auto, parse_dag_yaml};
