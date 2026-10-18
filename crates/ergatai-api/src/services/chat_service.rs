//! Chat Service — 封装 Chat 业务逻辑
//!
//! 职责：
//! - Chat CRUD
//! - 关联查询（通过 workspace_id 查询）
//! - 级联删除（删除 Chat 时级联删除 CollaborationSession 和 Conversation）

use crate::user_data_db::{chats, Chat, DEFAULT_COLLABORATION_MODE};
use ergatai_core::id::generate;

pub struct ChatService;

impl ChatService {
    /// 创建 Chat
    pub fn create_chat(workspace_id: i64, name: Option<String>) -> anyhow::Result<Chat> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let chat = Chat {
            chat_id: generate(),
            workspace_id,
            name,
            collaboration_mode: Some(DEFAULT_COLLABORATION_MODE.to_string()),
            worktree_path: None,
            branch: None,
            base_branch: None,
            pr_url: None,
            pr_number: None,
            created_at: now,
            updated_at: now,
            archived_at: None,
        };

        let chat = chats::create(chat)?;
        Ok(chat)
    }

    /// 获取 Chat
    pub fn get_chat(chat_id: i64) -> anyhow::Result<Option<Chat>> {
        let chat = chats::get(chat_id)?;
        Ok(chat)
    }

    /// 列出 Chat（通过 workspace_id 过滤）
    pub fn list_chats_by_workspace(workspace_id: i64) -> anyhow::Result<Vec<Chat>> {
        let chats = chats::list(Some(workspace_id))?;
        Ok(chats)
    }

    /// 列出所有 Chat
    pub fn list_chats(workspace_id: Option<i64>) -> anyhow::Result<Vec<Chat>> {
        let chats = chats::list(workspace_id)?;
        Ok(chats)
    }

    /// 更新 Chat
    pub fn update_chat(chat: Chat) -> anyhow::Result<()> {
        chats::update(chat)?;
        Ok(())
    }

    /// 删除 Chat（级联删除 CollaborationSession 和 Conversation）
    pub fn delete_chat(chat_id: i64) -> anyhow::Result<()> {
        // TODO: 实现级联删除
        // 1. 删除该 chat 下的所有 collaboration_session
        // 2. 删除该 chat 下的所有 conversation
        // 3. 删除 chat 本身
        chats::delete(chat_id)?;
        Ok(())
    }

    /// 归档 Chat
    pub fn archive_chat(chat_id: i64) -> anyhow::Result<()> {
        chats::archive(chat_id)?;
        Ok(())
    }

    /// 取消归档 Chat
    pub fn unarchive_chat(chat_id: i64) -> anyhow::Result<()> {
        chats::unarchive(chat_id)?;
        Ok(())
    }
}
