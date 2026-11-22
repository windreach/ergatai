//! Model selection types and the single precedence resolver.
//!
//! This module is deliberately pure: it does not read the database or talk to
//! an agent. Callers gather candidates and call [`resolve_model`]. That keeps
//! the precedence rules testable and prevents the old pattern where each spawn
//! path re-implemented its own fallback order.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// A model selectable by an ACP session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ModelSelection {
    /// Canonical ACP config-option value, for example `glm-5.3-flash` or
    /// `opencode-go/glm-5.3`.
    pub id: String,
    /// Provider-specific thinking level (currently Codex). `None` for agents
    /// that do not expose one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
}

impl ModelSelection {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            thinking: None,
        }
    }

    pub fn with_thinking(id: impl Into<String>, thinking: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            thinking: Some(thinking.into()),
        }
    }

    /// Trim and drop empty IDs/options. An empty model is never a valid
    /// selection and must not suppress fallback.
    pub fn normalized(&self) -> Option<Self> {
        let id = self.id.trim();
        if id.is_empty() {
            return None;
        }
        let thinking = self
            .thinking
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        Some(Self {
            id: id.to_string(),
            thinking,
        })
    }
}

/// How a caller supplied a model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ModelInput {
    /// New-chat seed. Applied only when the conversation has no setting yet.
    Seed(ModelSelection),
    /// Explicit user/API override. Always wins and is persisted.
    Override(ModelSelection),
    /// No explicit input; use conversation/runtime/default sources.
    #[default]
    None,
}

impl ModelInput {
    pub fn selection(&self) -> Option<&ModelSelection> {
        match self {
            Self::Seed(selection) | Self::Override(selection) => Some(selection),
            Self::None => None,
        }
    }

    pub fn is_override(&self) -> bool {
        matches!(self, Self::Override(_))
    }
}

/// Where the effective model came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModelSource {
    /// Explicit API request.
    Request,
    /// Explicit user choice stored on the conversation.
    ConversationUser,
    /// New-chat initial choice stored on the conversation.
    ConversationInitial,
    /// Mirrored from the agent's own model selector.
    ConversationNative,
    /// Historical `agent_runtime_models` row.
    AgentRuntime,
    /// Provider connection default.
    ProviderDefault,
    /// Profile catalogue default.
    ProfileDefault,
    /// Adapter's native default.
    NativeDefault,
}

impl ModelSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Request => "request",
            Self::ConversationUser => "user",
            Self::ConversationInitial => "initial",
            Self::ConversationNative => "native",
            Self::AgentRuntime => "agent_runtime",
            Self::ProviderDefault => "provider_default",
            Self::ProfileDefault => "profile_default",
            Self::NativeDefault => "native_default",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "request" | "spawn_request" => Some(Self::Request),
            "user" | "user_selected" => Some(Self::ConversationUser),
            "initial" => Some(Self::ConversationInitial),
            "native" => Some(Self::ConversationNative),
            "agent_runtime" => Some(Self::AgentRuntime),
            "provider_default" | "spawn_default" => Some(Self::ProviderDefault),
            "profile_default" => Some(Self::ProfileDefault),
            "native_default" => Some(Self::NativeDefault),
            _ => None,
        }
    }

    pub fn is_explicit(self) -> bool {
        matches!(
            self,
            Self::Request | Self::ConversationUser | Self::ConversationInitial
        )
    }
}

/// A persisted conversation-level selection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationModel {
    pub selection: ModelSelection,
    pub source: ModelSource,
    pub updated_at: i64,
}

/// All model candidates for one resolution pass.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelCandidates {
    pub explicit_override: Option<ModelSelection>,
    pub seed: Option<ModelSelection>,
    pub conversation: Option<ConversationModel>,
    pub live: Option<ModelSelection>,
    pub runtime: Option<ModelSelection>,
    pub provider_default: Option<ModelSelection>,
    pub profile_default: Option<ModelSelection>,
}

/// Result of model resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedModel {
    pub selection: ModelSelection,
    pub source: ModelSource,
}

/// Resolve the effective model using the unified precedence:
///
/// 1. explicit override
/// 2. sticky conversation selection (`user` / `initial` / `request`)
/// 3. new-chat seed when the conversation has no setting
/// 4. live ACP model (mirrored from the agent's own selector)
/// 5. any remaining conversation setting
/// 6. historical runtime model
/// 7. provider connection default
/// 8. profile catalogue default
/// 9. `None` (adapter native default is only allowed through an explicit
///    `allow_native_default` policy at the call site)
pub fn resolve_model(candidates: ModelCandidates) -> Option<ResolvedModel> {
    if let Some(selection) = candidates.explicit_override.and_then(|m| m.normalized()) {
        return Some(ResolvedModel {
            selection,
            source: ModelSource::Request,
        });
    }

    if let Some(conversation) = candidates.conversation.as_ref() {
        if conversation.source.is_explicit() {
            if let Some(selection) = conversation.selection.normalized() {
                return Some(ResolvedModel {
                    selection,
                    source: conversation.source,
                });
            }
        }
    }

    if candidates.conversation.is_none() {
        if let Some(selection) = candidates.seed.and_then(|m| m.normalized()) {
            return Some(ResolvedModel {
                selection,
                source: ModelSource::ConversationInitial,
            });
        }
    }

    if let Some(selection) = candidates.live.and_then(|m| m.normalized()) {
        return Some(ResolvedModel {
            selection,
            source: ModelSource::ConversationNative,
        });
    }

    if let Some(conversation) = candidates.conversation.as_ref() {
        if let Some(selection) = conversation.selection.normalized() {
            return Some(ResolvedModel {
                selection,
                source: conversation.source,
            });
        }
    }

    if let Some(selection) = candidates.runtime.and_then(|m| m.normalized()) {
        return Some(ResolvedModel {
            selection,
            source: ModelSource::AgentRuntime,
        });
    }

    if let Some(selection) = candidates.provider_default.and_then(|m| m.normalized()) {
        return Some(ResolvedModel {
            selection,
            source: ModelSource::ProviderDefault,
        });
    }

    candidates
        .profile_default
        .and_then(|m| m.normalized())
        .map(|selection| ResolvedModel {
            selection,
            source: ModelSource::ProfileDefault,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str) -> ModelSelection {
        ModelSelection::new(id)
    }

    fn conversation(id: &str, source: ModelSource) -> ConversationModel {
        ConversationModel {
            selection: model(id),
            source,
            updated_at: 1,
        }
    }

    #[test]
    fn explicit_override_wins_over_everything() {
        let resolved = resolve_model(ModelCandidates {
            explicit_override: Some(model("override")),
            conversation: Some(conversation("user", ModelSource::ConversationUser)),
            live: Some(model("live")),
            provider_default: Some(model("provider")),
            profile_default: Some(model("profile")),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(resolved.selection.id, "override");
        assert_eq!(resolved.source, ModelSource::Request);
    }

    #[test]
    fn sticky_conversation_user_beats_live() {
        let resolved = resolve_model(ModelCandidates {
            conversation: Some(conversation("glm", ModelSource::ConversationUser)),
            live: Some(model("qwen")),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(resolved.selection.id, "glm");
        assert_eq!(resolved.source, ModelSource::ConversationUser);
    }

    #[test]
    fn sticky_new_chat_selection_beats_live_wrong_model() {
        // Regression for the reported incident: new chat selected glm, the
        // agent was later spawned with qwen, and the next prompt must restore
        // glm rather than trusting the live model.
        let resolved = resolve_model(ModelCandidates {
            conversation: Some(conversation(
                "glm-5.3-flash",
                ModelSource::ConversationInitial,
            )),
            live: Some(model("qwen3.7-plus")),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(resolved.selection.id, "glm-5.3-flash");
        assert_eq!(resolved.source, ModelSource::ConversationInitial);
    }

    #[test]
    fn seed_only_applies_without_a_conversation_setting() {
        let with_setting = resolve_model(ModelCandidates {
            seed: Some(model("seed")),
            conversation: Some(conversation("saved", ModelSource::ConversationNative)),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(with_setting.selection.id, "saved");

        let without_setting = resolve_model(ModelCandidates {
            seed: Some(model("seed")),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(without_setting.selection.id, "seed");
        assert_eq!(without_setting.source, ModelSource::ConversationInitial);
    }

    #[test]
    fn live_beats_non_explicit_conversation_setting() {
        let resolved = resolve_model(ModelCandidates {
            conversation: Some(conversation("stale", ModelSource::ConversationNative)),
            live: Some(model("live")),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(resolved.selection.id, "live");
        assert_eq!(resolved.source, ModelSource::ConversationNative);
    }

    #[test]
    fn runtime_then_provider_then_profile_fill_the_gap() {
        let runtime = resolve_model(ModelCandidates {
            runtime: Some(model("runtime")),
            provider_default: Some(model("provider")),
            profile_default: Some(model("profile")),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(runtime.selection.id, "runtime");
        assert_eq!(runtime.source, ModelSource::AgentRuntime);

        let provider = resolve_model(ModelCandidates {
            provider_default: Some(model("provider")),
            profile_default: Some(model("profile")),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(provider.selection.id, "provider");
        assert_eq!(provider.source, ModelSource::ProviderDefault);

        let profile = resolve_model(ModelCandidates {
            profile_default: Some(model("profile")),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(profile.selection.id, "profile");
        assert_eq!(profile.source, ModelSource::ProfileDefault);
    }

    #[test]
    fn empty_values_are_ignored() {
        assert!(resolve_model(ModelCandidates {
            explicit_override: Some(model("   ")),
            live: Some(ModelSelection::new("")),
            provider_default: Some(model("")),
            ..Default::default()
        })
        .is_none());
    }

    #[test]
    fn thinking_is_preserved_and_trimmed() {
        let resolved = resolve_model(ModelCandidates {
            explicit_override: Some(ModelSelection::with_thinking("gpt-5.3-codex", " high ")),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(resolved.selection.id, "gpt-5.3-codex");
        assert_eq!(resolved.selection.thinking.as_deref(), Some("high"));
    }

    #[test]
    fn source_round_trips_through_strings() {
        for source in [
            ModelSource::Request,
            ModelSource::ConversationUser,
            ModelSource::ConversationInitial,
            ModelSource::ConversationNative,
            ModelSource::AgentRuntime,
            ModelSource::ProviderDefault,
            ModelSource::ProfileDefault,
            ModelSource::NativeDefault,
        ] {
            assert_eq!(ModelSource::parse(source.as_str()), Some(source));
        }
        assert_eq!(
            ModelSource::parse("user_selected"),
            Some(ModelSource::ConversationUser),
            "legacy source strings must remain explicit"
        );
    }
}
