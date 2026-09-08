//! Service 层 — 封装业务逻辑，供 handler 层调用。
//!
//! 目标：将 handler 中重复的初始化/查询代码集中到 service 层，
//! handler 只负责 HTTP 协议细节（请求解析、响应格式化、状态码映射）。

pub mod agent_service;
pub mod dag_service;
pub mod lock_service;
pub mod profile_service;
