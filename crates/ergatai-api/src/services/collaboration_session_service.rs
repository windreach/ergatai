//! Collaboration Session Service — 封装 CollaborationSession 业务逻辑
//!
//! 职责：
//! - CollaborationSession CRUD
//! - 状态管理
//! - 关联查询（通过 chat_id 查询）
//! - 级联删除（删除 Session 时级联删除 Conversation）

use crate::user_data_db::{collaboration_sessions, CollaborationSession};
use ergatai_core::id::generate;

pub struct CollaborationSessionService;

impl CollaborationSessionService {
    /// 创建 CollaborationSession
    pub async fn create_session(
        chat_id: &str,
        workspace_id: &str,
        mode: String,
        goal: Option<String>,
    ) -> anyhow::Result<CollaborationSession> {
        // 验证 mode
        if !["supervisor", "group"].contains(&mode.as_str()) {
            anyhow::bail!("mode must be 'supervisor' or 'group'");
        }

        // Parse IDs to i64
        let chat_id_i64 = chat_id
            .parse::<i64>()
            .map_err(|_| anyhow::anyhow!("Invalid chat_id format: {}", chat_id))?;
        let workspace_id_i64 = workspace_id
            .parse::<i64>()
            .map_err(|_| anyhow::anyhow!("Invalid workspace_id format: {}", workspace_id))?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let session = CollaborationSession {
            collaboration_session_id: generate(),
            chat_id: chat_id_i64,
            workspace_id: workspace_id_i64,
            mode,
            state: "idle".to_string(),
            goal,
            active_plan_revision: None,
            created_at: now,
            updated_at: now,
        };

        let session = collaboration_sessions::create(session)?;
        Ok(session)
    }

    /// 获取 CollaborationSession
    pub async fn get_session(
        collaboration_session_id: &str,
    ) -> anyhow::Result<Option<CollaborationSession>> {
        let session_id_i64 = collaboration_session_id.parse::<i64>().map_err(|_| {
            anyhow::anyhow!(
                "Invalid collaboration_session_id format: {}",
                collaboration_session_id
            )
        })?;
        let session = collaboration_sessions::get(session_id_i64)?;
        Ok(session)
    }

    /// 列出 CollaborationSession（通过 chat_id 过滤）
    pub async fn list_sessions_by_chat(chat_id: &str) -> anyhow::Result<Vec<CollaborationSession>> {
        let chat_id_i64 = chat_id
            .parse::<i64>()
            .map_err(|_| anyhow::anyhow!("Invalid chat_id format: {}", chat_id))?;
        let sessions = collaboration_sessions::list(Some(chat_id_i64))?;
        Ok(sessions)
    }

    /// 更新 CollaborationSession
    pub async fn update_session(session: CollaborationSession) -> anyhow::Result<()> {
        collaboration_sessions::update(session)?;
        Ok(())
    }

    /// 更新 Session 状态
    pub async fn update_state(
        collaboration_session_id: &str,
        new_state: &str,
    ) -> anyhow::Result<bool> {
        let session_id_i64 = collaboration_session_id.parse::<i64>().map_err(|_| {
            anyhow::anyhow!(
                "Invalid collaboration_session_id format: {}",
                collaboration_session_id
            )
        })?;
        collaboration_sessions::update_state(session_id_i64, new_state)?;
        Ok(true)
    }

    /// 删除 CollaborationSession（级联删除 Conversation）
    pub async fn delete_session(collaboration_session_id: &str) -> anyhow::Result<bool> {
        let session_id_i64 = collaboration_session_id.parse::<i64>().map_err(|_| {
            anyhow::anyhow!(
                "Invalid collaboration_session_id format: {}",
                collaboration_session_id
            )
        })?;
        collaboration_sessions::delete(session_id_i64)?;
        Ok(true)
    }
}
