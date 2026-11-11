//! Message Service — 封装 Message 业务逻辑
//!
//! 职责：
//! - Message CRUD
//! - 多维度查询（通过 conversation_id, collaboration_session_id, chat_id 查询）
//! - 序列化和反序列化

use crate::user_data_db::{messages, Message};
use ergatai_error::{ChatId, CollaborationSessionId, ConversationId};
use serde_json;

pub struct MessageService;

impl MessageService {
    /// 创建 Message
    pub fn create_message(
        conversation_id: ConversationId,
        role: &str,
        content: &str,
        metadata: Option<serde_json::Value>,
    ) -> anyhow::Result<Message> {
        // 构建 parts JSON
        let parts = serde_json::json!([{
            "type": "text",
            "text": content
        }]);

        let metadata = metadata.unwrap_or(serde_json::json!({}));

        let message = messages::append(conversation_id, role, parts, metadata, None)?;
        Ok(message)
    }

    /// 获取 Message
    pub fn get_message(
        conversation_id: ConversationId,
        message_id: &str,
    ) -> anyhow::Result<Option<Message>> {
        let message_id = ergatai_error::MessageId::decode(message_id)?;
        let message = messages::get(conversation_id, message_id)?;
        Ok(message)
    }

    /// 列出 Message（通过 conversation_id 过滤）
    pub fn list_messages_by_conversation(
        conversation_id: ConversationId,
    ) -> anyhow::Result<Vec<Message>> {
        let messages = messages::list(conversation_id)?;
        Ok(messages)
    }

    /// 列出 Message（通过 collaboration_session_id 过滤）
    pub fn list_messages_by_collaboration_session(
        collaboration_session_id: CollaborationSessionId,
    ) -> anyhow::Result<Vec<Message>> {
        let messages = messages::list_by_collaboration_session(collaboration_session_id)?;
        Ok(messages)
    }

    /// 列出 Message（通过 chat_id 过滤）
    pub fn list_messages_by_chat(chat_id: ChatId) -> anyhow::Result<Vec<Message>> {
        let messages = messages::list_by_chat(chat_id)?;
        Ok(messages)
    }

    /// 列出 Message（after_sequence 之后的）
    pub fn list_messages_after_sequence(
        conversation_id: ConversationId,
        after_sequence: i64,
    ) -> anyhow::Result<Vec<Message>> {
        let messages = messages::list_after_sequence(conversation_id, after_sequence)?;
        Ok(messages)
    }

    /// 获取最后一个 Message
    pub fn get_last_message(conversation_id: ConversationId) -> anyhow::Result<Option<Message>> {
        let message = messages::get_last(conversation_id)?;
        Ok(message)
    }

    /// 更新 Message
    pub async fn update_message(
        conversation_id: ConversationId,
        message_id: &str,
        content: &str,
    ) -> anyhow::Result<bool> {
        let message_id = ergatai_error::MessageId::decode(message_id)?;

        // 构建新的 parts JSON
        let parts = Self::build_text_parts(content);

        let result = messages::update(conversation_id, message_id, Some(parts), None).await?;
        Ok(result.is_some())
    }

    /// 构建文本消息的 parts JSON
    ///
    /// 将纯文本内容转换为消息存储格式：`[{"type": "text", "text": "..."}]`
    fn build_text_parts(content: &str) -> String {
        serde_json::json!([{
            "type": "text",
            "text": content
        }])
        .to_string()
    }

    /// 删除 Message
    pub async fn delete_message(
        conversation_id: ConversationId,
        message_id: &str,
    ) -> anyhow::Result<bool> {
        let message_id = ergatai_error::MessageId::decode(message_id)?;
        let deleted = messages::delete(conversation_id, message_id).await?;
        Ok(deleted)
    }

    /// 替换历史消息（用于同步）
    pub fn replace_legacy_messages(
        conversation_id: ConversationId,
        messages_json: &str,
        updated_at: i64,
    ) -> anyhow::Result<()> {
        messages::replace_legacy(conversation_id, messages_json, updated_at)?;
        Ok(())
    }

    /// 序列化消息为旧格式
    pub fn serialize_legacy(conversation_id: ConversationId) -> anyhow::Result<String> {
        let serialized = messages::serialize_legacy(conversation_id)?;
        Ok(serialized)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::conversation_service::ConversationService;
    use crate::user_data_db::{chats, collaboration_sessions, workspaces, CollaborationSession};
    use std::sync::Mutex;

    static TEST_DB_MUTEX: Mutex<()> = Mutex::new(());
    static TEST_DB_DATA_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

    fn lock_db() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_DB_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        TEST_DB_DATA_DIR.get_or_init(|| {
            let data_dir = std::env::temp_dir()
                .join("ergatai-msg-tests")
                .join(std::process::id().to_string());
            let _ = std::fs::remove_dir_all(&data_dir);
            std::fs::create_dir_all(&data_dir).unwrap();
            std::env::set_var("ERGATAI_DATA_DIR", &data_dir);
            data_dir
        });
        let _ = crate::user_data_db::get_user_data_db();
        guard
    }

    fn setup_conv() -> (
        ergatai_error::ConversationId,
        ergatai_error::CollaborationSessionId,
    ) {
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
        let chat = chats::create(crate::user_data_db::Chat {
            chat_id: ergatai_error::ChatId::generate(),
            workspace_id: ws.workspace_id,
            name: Some("c".to_string()),
            collaboration_mode: Some("supervisor".to_string()),
            worktree_path: None,
            branch: None,
            base_branch: None,
            pr_url: None,
            pr_number: None,
            created_at: 0,
            updated_at: 0,
            archived_at: None,
        })
        .unwrap();
        let collab = CollaborationSession {
            collaboration_session_id: ergatai_error::CollaborationSessionId::generate(),
            chat_id: chat.chat_id,
            workspace_id: ws.workspace_id,
            mode: "supervisor".to_string(),
            state: "idle".to_string(),
            goal: None,
            active_plan_revision: None,
            created_at: 0,
            updated_at: 0,
        };
        collaboration_sessions::create(collab.clone()).unwrap();
        let conv = ConversationService::create_conversation(
            collab.collaboration_session_id,
            chat.chat_id,
            None,
            "agent".to_string(),
            "peer".to_string(),
        )
        .unwrap();
        (conv.conversation_id, collab.collaboration_session_id)
    }

    #[test]
    fn test_create_and_list_messages() {
        let _g = lock_db();
        let (conv_id, _) = setup_conv();
        let m1 = MessageService::create_message(conv_id, "user", "hello", None).unwrap();
        let m2 = MessageService::create_message(conv_id, "assistant", "hi", None).unwrap();
        let list = MessageService::list_messages_by_conversation(conv_id).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].message_id, m1.message_id);
        assert_eq!(list[1].message_id, m2.message_id);
    }

    #[test]
    fn test_get_last_message() {
        let _g = lock_db();
        let (conv_id, _) = setup_conv();
        MessageService::create_message(conv_id, "user", "first", None).unwrap();
        let last = MessageService::create_message(conv_id, "assistant", "second", None).unwrap();
        let fetched = MessageService::get_last_message(conv_id).unwrap().unwrap();
        assert_eq!(fetched.message_id, last.message_id);
    }

    #[test]
    fn test_list_after_sequence() {
        let _g = lock_db();
        let (conv_id, _) = setup_conv();
        let m1 = MessageService::create_message(conv_id, "user", "first", None).unwrap();
        MessageService::create_message(conv_id, "assistant", "second", None).unwrap();
        let after = MessageService::list_messages_after_sequence(conv_id, m1.sequence).unwrap();
        assert_eq!(after.len(), 1);
    }
}
