//! Collaboration Session Service — 封装 CollaborationSession 业务逻辑
//!
//! 职责：
//! - CollaborationSession CRUD
//! - 状态管理
//! - 关联查询（通过 chat_id 查询）
//! - 级联删除（删除 Session 时级联删除 Conversation）

use crate::user_data_db::{collaboration_sessions, CollaborationSession};
use ergatai_core::id::{format as format_id, generate, IdType};

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

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let session = CollaborationSession {
            collaboration_session_id: format_id(generate(), IdType::Session),
            chat_id: chat_id.to_string(),
            workspace_id: workspace_id.to_string(),
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
        let session = collaboration_sessions::get(collaboration_session_id)?;
        Ok(session)
    }

    /// 列出 CollaborationSession（通过 chat_id 过滤）
    pub async fn list_sessions_by_chat(chat_id: &str) -> anyhow::Result<Vec<CollaborationSession>> {
        let sessions = collaboration_sessions::list(Some(chat_id))?;
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
        collaboration_sessions::update_state(collaboration_session_id, new_state)?;
        Ok(true)
    }

    /// 删除 CollaborationSession（级联删除 Conversation）
    pub async fn delete_session(collaboration_session_id: &str) -> anyhow::Result<bool> {
        collaboration_sessions::delete(collaboration_session_id)?;
        Ok(true)
    }
}
