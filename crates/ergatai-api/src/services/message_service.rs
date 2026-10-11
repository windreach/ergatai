//! Message Service — 封装 Message 业务逻辑
//!
//! 职责：
//! - Message CRUD
//! - 多维度查询（通过 conversation_id, collaboration_session_id, chat_id 查询）
//! - 序列化和反序列化

use crate::user_data_db::{messages, Message};
use serde_json;

pub struct MessageService;

impl MessageService {
    /// 创建 Message
    pub async fn create_message(
        conversation_id: &str,
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

        let message = messages::append(conversation_id, role, parts, metadata)?;
        Ok(message)
    }

    /// 获取 Message
    pub async fn get_message(_message_id: &str) -> anyhow::Result<Option<Message>> {
        // TODO: 实现单个 message 查询
        // 目前 messages 模块没有 get 方法，需要添加
        Ok(None)
    }

    /// 列出 Message（通过 conversation_id 过滤）
    pub async fn list_messages_by_conversation(
        conversation_id: &str,
    ) -> anyhow::Result<Vec<Message>> {
        let messages = messages::list(conversation_id)?;
        Ok(messages)
    }

    /// 列出 Message（通过 collaboration_session_id 过滤）
    pub async fn list_messages_by_collaboration_session(
        collaboration_session_id: &str,
    ) -> anyhow::Result<Vec<Message>> {
        let messages = messages::list_by_collaboration_session(collaboration_session_id)?;
        Ok(messages)
    }

    /// 列出 Message（通过 chat_id 过滤）
    pub async fn list_messages_by_chat(chat_id: &str) -> anyhow::Result<Vec<Message>> {
        let messages = messages::list_by_chat(chat_id)?;
        Ok(messages)
    }

    /// 列出 Message（after_sequence 之后的）
    pub async fn list_messages_after_sequence(
        conversation_id: &str,
        after_sequence: i64,
    ) -> anyhow::Result<Vec<Message>> {
        let messages = messages::list_after_sequence(conversation_id, after_sequence)?;
        Ok(messages)
    }

    /// 获取最后一个 Message
    pub async fn get_last_message(conversation_id: &str) -> anyhow::Result<Option<Message>> {
        let message = messages::get_last(conversation_id)?;
        Ok(message)
    }

    /// 更新 Message
    pub async fn update_message(_message_id: &str, _content: &str) -> anyhow::Result<bool> {
        // TODO: 实现 message 更新
        Ok(true)
    }

    /// 删除 Message
    pub async fn delete_message(_message_id: &str) -> anyhow::Result<bool> {
        // TODO: 实现 message 删除
        Ok(true)
    }

    /// 替换历史消息（用于同步）
    pub async fn replace_legacy_messages(
        conversation_id: &str,
        messages_json: &str,
        updated_at: i64,
    ) -> anyhow::Result<()> {
        messages::replace_legacy(conversation_id, messages_json, updated_at)?;
        Ok(())
    }

    /// 序列化消息为旧格式
    pub async fn serialize_legacy(conversation_id: &str) -> anyhow::Result<String> {
        let serialized = messages::serialize_legacy(conversation_id)?;
        Ok(serialized)
    }
}
