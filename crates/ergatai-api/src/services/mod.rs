//! Service 层 — 封装业务逻辑，供 handler 层调用。
//!
//! 目标：将 handler 中重复的初始化/查询代码集中到 service 层，
//! handler 只负责 HTTP 协议细节（请求解析、响应格式化、状态码映射）。

pub mod agent;
pub mod agent_history_import;
pub mod agent_output_cleanup;
pub mod agent_output_persistence;
pub mod agent_sdk_service;
pub mod agent_service;
pub mod chat_service;
pub mod collab_runtime;
pub mod collaboration_planner;
pub mod collaboration_session;
pub mod collaboration_session_dag;
pub mod collaboration_session_service;
pub mod conversation_runtime;
pub mod conversation_service;
pub mod dag_service;
pub mod deletion_helpers;
pub mod discovery_service;
pub mod embedded_scripts;
pub mod initial_prompt_turns;
pub mod job_queue_worker;
pub mod lock_service;
pub mod message_service;
pub mod model_file_reader;
pub mod native_agent_config;
pub mod nats_interrupt_event_publisher;
pub mod nats_output_publisher;
pub mod profile_service;
pub mod provider_connection_service;
pub mod skills_service;
pub mod terminal_sessions;
pub mod workspace_manager;
pub mod workspace_service;
