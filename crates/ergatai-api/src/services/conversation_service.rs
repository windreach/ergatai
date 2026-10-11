//! Conversation Service — 封装 Conversation 业务逻辑
//!
//! 职责：
//! - Conversation CRUD
//! - 多维度查询（通过 collaboration_session_id, chat_id 查询）
//! - 树形结构管理（parent-child 关系）
//! - 级联删除（删除 Conversation 时级联删除 Agent 和 Message）

use crate::user_data_db::{conversations, Conversation};
use ergatai_core::id::{format as format_id, generate, IdType};

pub struct ConversationService;

impl ConversationService {
    /// 创建 Conversation
    pub async fn create_conversation(
        collaboration_session_id: &str,
        chat_id: &str,
        name: Option<String>,
        mode: String,
        participant_role: String,
    ) -> anyhow::Result<Conversation> {
        // 验证 participant_role
        if !["peer", "supervisor", "hub"].contains(&participant_role.as_str()) {
            anyhow::bail!("participant_role must be 'peer', 'supervisor', or 'hub'");
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let conversation = Conversation {
            conversation_id: format_id(generate(), IdType::Conversation),
            collaboration_session_id: collaboration_session_id.to_string(),
            chat_id: chat_id.to_string(),
            parent_id: None,
            name,
            mode,
            participant_role,
            status: "ready".to_string(),
            created_at: now,
            updated_at: now,
        };

        let conversation = conversations::create(conversation)?;
        Ok(conversation)
    }

    /// 获取 Conversation
    pub async fn get_conversation(conversation_id: &str) -> anyhow::Result<Option<Conversation>> {
        let conversation = conversations::get(conversation_id)?;
        Ok(conversation)
    }

    /// 列出 Conversation（通过 collaboration_session_id 过滤）
    pub async fn list_conversations_by_session(
        collaboration_session_id: &str,
    ) -> anyhow::Result<Vec<Conversation>> {
        let conversations = conversations::list_by_collaboration_session(collaboration_session_id)?;
        Ok(conversations)
    }

    /// 列出 Conversation（通过 chat_id 过滤）
    pub async fn list_conversations_by_chat(chat_id: &str) -> anyhow::Result<Vec<Conversation>> {
        let conversations = conversations::list_by_chat(chat_id)?;
        Ok(conversations)
    }

    /// 更新 Conversation
    pub async fn update_conversation(conversation: Conversation) -> anyhow::Result<()> {
        conversations::update(conversation)?;
        Ok(())
    }

    /// 更新 Conversation 状态
    pub async fn update_status(_conversation_id: &str, _status: &str) -> anyhow::Result<bool> {
        // TODO: 实现状态更新
        Ok(true)
    }

    /// 删除 Conversation（级联删除 Agent 和 Message）
    pub async fn delete_conversation(conversation_id: &str) -> anyhow::Result<()> {
        // TODO: 实现级联删除
        // 1. 删除该 conversation 下的所有 message
        // 2. 删除该 conversation 下的 agent（如果有）
        // 3. 删除 conversation 本身
        conversations::delete(conversation_id)?;
        Ok(())
    }

    /// 列出子 Conversation
    pub async fn list_children(parent_id: &str) -> anyhow::Result<Vec<Conversation>> {
        let children = conversations::list_children(parent_id)?;
        Ok(children)
    }

    /// 创建子 Conversation
    pub async fn create_child(
        parent_id: &str,
        name: Option<String>,
        mode: String,
    ) -> anyhow::Result<Conversation> {
        // 获取父 conversation
        let parent = conversations::get(parent_id)?
            .ok_or_else(|| anyhow::anyhow!("Parent conversation not found: {}", parent_id))?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let child = Conversation {
            conversation_id: format_id(generate(), IdType::Conversation),
            collaboration_session_id: parent.collaboration_session_id.clone(),
            chat_id: parent.chat_id.clone(),
            parent_id: Some(parent_id.to_string()),
            name,
            mode,
            participant_role: "peer".to_string(),
            status: "ready".to_string(),
            created_at: now,
            updated_at: now,
        };

        let child = conversations::create(child)?;
        Ok(child)
    }
}
