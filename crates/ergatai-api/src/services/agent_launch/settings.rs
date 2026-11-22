//! Persistence bridge for conversation launch settings.
//!
//! The storage layer is intentionally thin: `user_data_db` owns SQL, this
//! module owns the typed conversion and the "empty model means no selection"
//! rule.

use anyhow::{anyhow, Result};
use ergatai_error::ConversationId;
use serde::{Deserialize, Serialize};

use crate::user_data_db::{self, ConversationLaunchSettings};

use super::model::{ConversationModel, ModelSelection, ModelSource};

/// Provider-specific options stored alongside the model ID.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
}

impl ModelOptions {
    pub fn from_selection(selection: &ModelSelection) -> Self {
        Self {
            thinking: selection.thinking.clone(),
        }
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Convert a stored row into the typed selection.
pub fn from_row(row: &ConversationLaunchSettings) -> Option<ConversationModel> {
    let model = row
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let options: ModelOptions = serde_json::from_str(&row.model_options_json).unwrap_or_default();
    let source = ModelSource::parse(&row.source).unwrap_or(ModelSource::ConversationNative);
    Some(ConversationModel {
        selection: ModelSelection {
            id: model.to_string(),
            thinking: options.thinking,
        },
        source,
        updated_at: row.updated_at,
    })
}

/// Load the durable conversation selection, if any.
pub fn load(conversation_id: ConversationId) -> Result<Option<ConversationModel>> {
    let Some(row) = user_data_db::conversation_launch_settings::get(conversation_id)? else {
        return Ok(None);
    };
    Ok(from_row(&row))
}

/// Persist a conversation selection. An empty model is rejected rather than
/// silently clearing the setting.
pub fn save(
    conversation_id: ConversationId,
    profile_name: Option<&str>,
    selection: &ModelSelection,
    source: ModelSource,
    provider_connection_id: Option<&str>,
) -> Result<()> {
    let selection = selection
        .normalized()
        .ok_or_else(|| anyhow!("model must not be empty"))?;
    let options = ModelOptions::from_selection(&selection);
    let row = ConversationLaunchSettings {
        conversation_id,
        profile_name: profile_name.map(ToOwned::to_owned),
        model: Some(selection.id),
        model_options_json: serde_json::to_string(&options)?,
        provider_connection_id: provider_connection_id.map(ToOwned::to_owned),
        source: source.as_str().to_string(),
        updated_at: now_ms(),
    };
    user_data_db::conversation_launch_settings::upsert(&row)?;
    Ok(())
}

pub fn clear(conversation_id: ConversationId) -> Result<()> {
    user_data_db::conversation_launch_settings::delete(conversation_id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_options_round_trip() {
        let selection = ModelSelection::with_thinking("gpt-5.3-codex", "high");
        let options = ModelOptions::from_selection(&selection);
        let json = serde_json::to_string(&options).unwrap();
        let parsed: ModelOptions = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.thinking.as_deref(), Some("high"));
    }

    #[test]
    fn empty_selection_is_rejected() {
        let selection = ModelSelection::new("   ");
        assert!(selection.normalized().is_none());
    }
}
