//! ACP session model-selector extraction.
//!
//! The running agent's `session config_options` is the most authoritative model
//! source: its values are exactly the IDs accepted by `session/set_config_option`.

use std::time::Duration;

use agent_client_protocol::schema::v1::SessionConfigOption;

use crate::services::profile_service::{ProfileModelDetail, ProfileModelSource};

use super::source::SourceReading;

#[derive(Debug, Clone)]
pub struct DetectedModels {
    pub models: Vec<String>,
    pub details: Vec<ProfileModelDetail>,
    #[allow(dead_code)]
    pub current: Option<String>,
    pub option_id: Option<String>,
}

impl DetectedModels {
    pub fn into_reading(self) -> SourceReading {
        SourceReading::success(
            ProfileModelSource::AcpConfigOptions,
            self.details,
            self.current,
            None,
        )
    }
}

/// Read the live model selector from a running agent. When `wait` is set, poll
/// briefly so post-spawn detection can catch config options that are still
/// being initialized.
pub async fn read_model_options(agent_id: Option<&str>, wait: bool) -> SourceReading {
    let Some(agent_id) = agent_id.filter(|id| !id.trim().is_empty()) else {
        return SourceReading::unavailable(
            ProfileModelSource::AcpConfigOptions,
            "no live agent for ACP read",
        );
    };

    let attempts = if wait { 6 } else { 1 };
    for attempt in 0..attempts {
        match crate::services::agent_service::get_agent_config_options(agent_id).await {
            Ok(Some(options)) => {
                if let Some(detected) = extract_models_from_config_options(&options) {
                    return detected.into_reading();
                }
                // The session is live but may still be adding the model
                // selector. Retry within the wait window before giving up.
                if attempt + 1 < attempts {
                    tokio::time::sleep(Duration::from_millis(400)).await;
                    continue;
                }
                return SourceReading::unavailable(
                    ProfileModelSource::AcpConfigOptions,
                    "session has no model selector",
                );
            }
            Ok(None) => {
                if attempt + 1 < attempts {
                    tokio::time::sleep(Duration::from_millis(400)).await;
                }
            }
            Err(error) => {
                return SourceReading::unavailable(
                    ProfileModelSource::AcpConfigOptions,
                    format!("config options unavailable: {error}"),
                );
            }
        }
    }

    SourceReading::unavailable(
        ProfileModelSource::AcpConfigOptions,
        "config options not available",
    )
}

/// Extract model list and current selection from ACP config options.
///
/// Handles both Ungrouped (flat list) and Grouped (provider-grouped) formats:
/// - Ungrouped: `[{"value": "opus", "name": "Opus"}, ...]`
/// - Grouped: `[{"group": "anthropic", "name": "Anthropic", "options": [{"value": "opus", ...}]}, ...]`
pub(crate) fn extract_models_from_config_options(
    opts: &[SessionConfigOption],
) -> Option<DetectedModels> {
    use agent_client_protocol::schema::v1::SessionConfigOptionCategory;

    fn selector_identity(value: &str) -> String {
        value
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_lowercase()
    }

    // `category` is optional UX metadata in ACP. Prefer it, but a compliant
    // agent can still identify the selector with `id = "model"` or `name`.
    let model_option = opts
        .iter()
        .find(|o| matches!(o.category, Some(SessionConfigOptionCategory::Model)))
        .or_else(|| {
            opts.iter().find(|o| {
                if matches!(
                    o.category,
                    Some(SessionConfigOptionCategory::Mode)
                        | Some(SessionConfigOptionCategory::ModelConfig)
                        | Some(SessionConfigOptionCategory::ThoughtLevel)
                ) {
                    return false;
                }
                let id = selector_identity(&o.id.to_string());
                let name = selector_identity(&o.name);
                matches!(id.as_str(), "model" | "modelselector")
                    || matches!(name.as_str(), "model" | "modelselector")
            })
        })?;

    // The kind field contains the select options
    let kind_json = serde_json::to_value(&model_option.kind).ok()?;
    if kind_json.get("type")?.as_str()? != "select" {
        return None;
    }

    let current = kind_json
        .get("currentValue")
        .and_then(|v| v.as_str())
        .map(String::from);
    let options = kind_json.get("options")?.as_array()?;

    let mut models: Vec<String> = Vec::new();
    let mut details: Vec<ProfileModelDetail> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let mut push_model = |value: &str, name: Option<&str>| {
        if value.is_empty() || !seen.insert(value.to_string()) {
            return;
        }
        let (provider, fallback_name) = match value.split_once('/') {
            Some((provider, model)) => (provider.to_string(), model.to_string()),
            None => (String::new(), value.to_string()),
        };
        let display_name = name
            .filter(|name| !name.trim().is_empty())
            .map(str::to_string)
            .unwrap_or(fallback_name);
        models.push(value.to_string());
        details.push(ProfileModelDetail {
            id: value.to_string(),
            name: display_name,
            description: String::new(),
            provider,
        });
    };

    // Extract models from both Ungrouped and Grouped option formats.
    // Ungrouped: each item has "value"/"id" directly.
    // Grouped: each item has "group", "name", and nested "options" array.
    for option in options {
        if let Some(value) = option
            .get("value")
            .or_else(|| option.get("id"))
            .and_then(|v| v.as_str())
        {
            push_model(value, option.get("name").and_then(|v| v.as_str()));
            continue;
        }
        if let Some(nested) = option.get("options").and_then(|v| v.as_array()) {
            for item in nested {
                if let Some(value) = item
                    .get("value")
                    .or_else(|| item.get("id"))
                    .and_then(|v| v.as_str())
                {
                    push_model(value, item.get("name").and_then(|v| v.as_str()));
                }
            }
        }
    }

    if models.is_empty() {
        None
    } else {
        Some(DetectedModels {
            models,
            details,
            current,
            option_id: Some(model_option.id.to_string()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Build a minimal SessionConfigOption with category=Model and a given kind JSON value.
    /// Note: SessionConfigOption uses #[serde(flatten)] on `kind`, so type/currentValue/options
    /// are at the top level of the JSON, not nested under "kind".
    fn make_model_config_option(
        kind_value: serde_json::Value,
    ) -> agent_client_protocol::schema::v1::SessionConfigOption {
        let mut raw = json!({
            "id": "model-selector",
            "name": "Model",
            "category": "model",
        });
        if let Some(obj) = raw.as_object_mut() {
            if let Some(kind_obj) = kind_value.as_object() {
                for (k, v) in kind_obj {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }
        serde_json::from_value(raw).expect("Failed to deserialize SessionConfigOption")
    }

    #[test]
    fn test_extract_models_ungrouped() {
        let kind = json!({
            "type": "select",
            "currentValue": "sonnet",
            "options": [
                {"value": "opus", "name": "Opus 4.6"},
                {"value": "sonnet", "name": "Sonnet 4.6"},
                {"value": "haiku", "name": "Haiku 4.5"},
            ]
        });
        let opts = vec![make_model_config_option(kind)];
        let detection = extract_models_from_config_options(&opts).unwrap();
        assert_eq!(detection.models, vec!["opus", "sonnet", "haiku"]);
        assert_eq!(detection.current.as_deref(), Some("sonnet"));
        assert_eq!(detection.option_id.as_deref(), Some("model-selector"));
        assert_eq!(detection.details[1].name, "Sonnet 4.6");
    }

    #[test]
    fn test_extract_models_grouped_builds_provider_details() {
        let kind = json!({
            "type": "select",
            "currentValue": "anthropic/sonnet",
            "options": [
                {
                    "group": "anthropic",
                    "name": "Anthropic",
                    "options": [
                        {"value": "anthropic/opus", "name": "Opus 4.6"},
                        {"value": "anthropic/sonnet", "name": "Sonnet 4.6"},
                    ]
                },
                {
                    "group": "openai",
                    "name": "OpenAI",
                    "options": [
                        {"value": "openai/gpt-5", "name": "GPT-5"},
                    ]
                },
            ]
        });
        let opts = vec![make_model_config_option(kind)];
        let detection = extract_models_from_config_options(&opts).unwrap();
        assert_eq!(
            detection.models,
            vec!["anthropic/opus", "anthropic/sonnet", "openai/gpt-5"]
        );
        assert_eq!(detection.details[0].provider, "anthropic");
        assert_eq!(detection.details[2].provider, "openai");
    }

    #[test]
    fn test_extract_models_no_model_category() {
        use agent_client_protocol::schema::v1::SessionConfigOption;
        let raw = json!({
            "id": "mode-selector",
            "name": "Mode",
            "category": "mode",
            "type": "select",
            "currentValue": "agent",
            "options": [{"value": "agent", "name": "Agent"}],
        });
        let opts: Vec<SessionConfigOption> = vec![serde_json::from_value(raw).unwrap()];
        assert!(extract_models_from_config_options(&opts).is_none());
    }

    #[test]
    fn test_extract_models_without_category() {
        use agent_client_protocol::schema::v1::SessionConfigOption;
        let raw = json!({
            "id": "model",
            "name": "Model",
            "type": "select",
            "currentValue": "model-1",
            "options": [
                {"value": "model-1", "name": "Model One"},
                {"value": "model-2", "name": "Model Two"},
            ],
        });
        let opts: Vec<SessionConfigOption> = vec![serde_json::from_value(raw).unwrap()];
        let detection = extract_models_from_config_options(&opts).unwrap();
        assert_eq!(detection.models, vec!["model-1", "model-2"]);
        assert_eq!(detection.option_id.as_deref(), Some("model"));
    }

    #[test]
    fn test_extract_models_does_not_mistake_model_config() {
        use agent_client_protocol::schema::v1::SessionConfigOption;
        let raw = json!({
            "id": "thinking",
            "name": "Thinking",
            "category": "model_config",
            "type": "select",
            "currentValue": "high",
            "options": [{"value": "high", "name": "High"}],
        });
        let opts: Vec<SessionConfigOption> = vec![serde_json::from_value(raw).unwrap()];
        assert!(extract_models_from_config_options(&opts).is_none());
    }

    #[test]
    fn test_extract_models_empty_options() {
        let kind = json!({
            "type": "select",
            "currentValue": "default",
            "options": []
        });
        let opts = vec![make_model_config_option(kind)];
        assert!(extract_models_from_config_options(&opts).is_none());
    }

    #[test]
    fn test_extract_models_boolean_kind() {
        let kind = json!({
            "type": "boolean",
            "currentValue": true,
        });
        let opts = vec![make_model_config_option(kind)];
        assert!(extract_models_from_config_options(&opts).is_none());
    }
}
