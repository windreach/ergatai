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
    /// 异步清理关联的 message 表（避免阻塞 API 响应）
    pub fn delete_chat(chat_id: ChatId) -> anyhow::Result<()> {
        use crate::user_data_db::conversations;

        // 1. 先获取所有 conversation IDs（用于异步清理 message 表）
        let conversation_ids = match conversations::list_conversation_ids_by_chat(chat_id) {
            Ok(ids) => ids,
            Err(e) => {
                tracing::warn!(error = %e, "Failed to list conversation IDs for chat cleanup; proceeding with chat deletion but message tables may not be cleaned up");
                Vec::new()
            }
        };

        // 2. 删除 chat（级联删除 conversations）
        chats::delete(chat_id)?;

        // 3. 入队异步清理任务（删除 message 表）
        let entity_id = chat_id.to_string();
        crate::services::deletion_helpers::enqueue_conversation_cleanup(
            "chat",
            &entity_id,
            "cleanup_chat",
            conversation_ids,
        );

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::user_data_db::workspaces;
    use std::sync::Mutex;

    static TEST_DB_MUTEX: Mutex<()> = Mutex::new(());
    static TEST_DB_DATA_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

    fn lock_db() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_DB_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        TEST_DB_DATA_DIR.get_or_init(|| {
            let data_dir = std::env::temp_dir()
                .join("ergatai-chat-tests")
                .join(std::process::id().to_string());
            let _ = std::fs::remove_dir_all(&data_dir);
            std::fs::create_dir_all(&data_dir).unwrap();
            std::env::set_var("ERGATAI_DATA_DIR", &data_dir);
            data_dir
        });
        let _ = crate::user_data_db::get_user_data_db();
        guard
    }

    fn make_workspace() -> ergatai_error::WorkspaceId {
        let ws = workspaces::create(crate::user_data_db::Workspace {
            workspace_id: ergatai_error::WorkspaceId::generate(),
            name: "w".to_string(),
            work_dir: "/tmp/w".to_string(),
            env: "{}".to_string(),
            resources: "{}".to_string(),
            config: "{}".to_string(),
            collaboration_mode: "none".to_string(),
            status: "active".to_string(),
            default_project_id: None,
            created_at: 0,
            updated_at: 0,
        })
        .unwrap();
        ws.workspace_id
    }

    #[test]
    fn test_create_and_get_chat() {
        let _g = lock_db();
        let ws = make_workspace();
        let chat = ChatService::create_chat(ws, Some("c1".to_string())).unwrap();
        let fetched = ChatService::get_chat(chat.chat_id).unwrap().unwrap();
        assert_eq!(fetched.name, Some("c1".to_string()));
    }

    #[test]
    fn test_list_chats_by_workspace() {
        let _g = lock_db();
        let ws = make_workspace();
        let _ = ChatService::create_chat(ws, Some("a".to_string())).unwrap();
        let _ = ChatService::create_chat(ws, Some("b".to_string())).unwrap();
        let list = ChatService::list_chats_by_workspace(ws).unwrap();
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn test_archive_unarchive() {
        let _g = lock_db();
        let ws = make_workspace();
        let chat = ChatService::create_chat(ws, None).unwrap();
        ChatService::archive_chat(chat.chat_id).unwrap();
        ChatService::unarchive_chat(chat.chat_id).unwrap();
    }

    #[test]
    fn test_delete_chat() {
        let _g = lock_db();
        let ws = make_workspace();
        let chat = ChatService::create_chat(ws, None).unwrap();
        ChatService::delete_chat(chat.chat_id).unwrap();
        assert!(ChatService::get_chat(chat.chat_id).unwrap().is_none());
    }
}
