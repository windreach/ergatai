//! Chat Service — 封装 Chat 业务逻辑
//!
//! 职责：
//! - Chat CRUD
//! - 关联查询（通过 workspace_id 查询）
//! - 级联删除（删除 Chat 时级联删除 CollaborationSession 和 Conversation）

use crate::user_data_db::{chats, Chat, DEFAULT_COLLABORATION_MODE};
use ergatai_error::{ChatId, WorkspaceId};

pub struct ChatService;

impl ChatService {
    /// 创建 Chat
    pub fn create_chat(workspace_id: WorkspaceId, name: Option<String>) -> anyhow::Result<Chat> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let chat = Chat {
            chat_id: ChatId::generate(),
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
    pub fn get_chat(chat_id: ChatId) -> anyhow::Result<Option<Chat>> {
        let chat = chats::get(chat_id)?;
        Ok(chat)
    }

    /// 列出 Chat（通过 workspace_id 过滤）
    pub fn list_chats_by_workspace(workspace_id: WorkspaceId) -> anyhow::Result<Vec<Chat>> {
        let chats = chats::list(Some(workspace_id))?;
        Ok(chats)
    }

    /// 列出所有 Chat
    pub fn list_chats(workspace_id: Option<WorkspaceId>) -> anyhow::Result<Vec<Chat>> {
        let chats = chats::list(workspace_id)?;
        Ok(chats)
    }

    /// 更新 Chat
    pub fn update_chat(chat: Chat) -> anyhow::Result<()> {
        chats::update(chat)?;
        Ok(())
    }

    /// 删除 Chat（数据库已配置 ON DELETE CASCADE，会自动删除关联的 CollaborationSession 和 Conversation）
    pub fn delete_chat(chat_id: ChatId) -> anyhow::Result<()> {
        chats::delete(chat_id)?;
        Ok(())
    }

    /// 归档 Chat
    pub fn archive_chat(chat_id: ChatId) -> anyhow::Result<()> {
        chats::archive(chat_id)?;
        Ok(())
    }

    /// 取消归档 Chat
    pub fn unarchive_chat(chat_id: ChatId) -> anyhow::Result<()> {
        chats::unarchive(chat_id)?;
        Ok(())
    }
}
