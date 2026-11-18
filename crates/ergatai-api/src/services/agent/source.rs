//! Shared model-source priority pipeline.
//!
//! Every agent kind exposes its model catalogue through the same ordered set of
//! sources. Higher-ranked sources win; a lower-ranked detection never replaces a
//! higher-ranked cached catalogue. The static config file is always merged as an
//! overlay so user-defined providers/models cannot disappear when a live source
//! succeeds.

use std::collections::{HashMap, HashSet};

use crate::services::profile_service::{ProfileModelDetail, ProfileModelSource};

use super::{acp, claude, codex, opencode, AgentKind, DiscoveredModels};

/// Inputs shared by all source readers. `live_agent_id` is required for the ACP
/// source; `wait_for_live_agent` lets post-spawn detection poll briefly for the
/// session config options to become available.
pub struct ModelReadContext<'a> {
    pub profile_name: &'a str,
    pub cwd: Option<&'a str>,
    pub live_agent_id: Option<&'a str>,
    pub wait_for_live_agent: bool,
}

impl<'a> ModelReadContext<'a> {
    pub fn new(profile_name: &'a str) -> Self {
        Self {
            profile_name,
            cwd: None,
            live_agent_id: None,
            wait_for_live_agent: false,
        }
    }

    pub fn with_cwd(mut self, cwd: Option<&'a str>) -> Self {
        self.cwd = cwd;
        self
    }

    pub fn with_live_agent(mut self, agent_id: Option<&'a str>) -> Self {
        self.live_agent_id = agent_id.filter(|id| !id.is_empty());
        self.wait_for_live_agent = self.live_agent_id.is_some();
        self
    }
}

/// Result of consulting one source. `ok` means the source was reachable and is
/// authoritative for this read; it may still contain zero models.
#[derive(Debug, Clone)]
pub struct SourceReading {
    pub source: ProfileModelSource,
    pub details: Vec<ProfileModelDetail>,
    pub current: Option<String>,
    pub default_model: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
}

impl SourceReading {
    pub fn success(
        source: ProfileModelSource,
        details: Vec<ProfileModelDetail>,
        current: Option<String>,
        default_model: Option<String>,
    ) -> Self {
        Self {
            source,
            details,
            current,
            default_model,
            ok: true,
            error: None,
        }
    }

    pub fn unavailable(source: ProfileModelSource, error: impl Into<String>) -> Self {
        Self {
            source,
            details: Vec::new(),
            current: None,
            default_model: None,
            ok: false,
            error: Some(error.into()),
        }
    }
}

/// Ordered sources for each agent kind. This is the single place where agent
/// capabilities are declared; the orchestration and persistence rules stay
/// shared.
fn source_chain(kind: AgentKind) -> &'static [ProfileModelSource] {
    use ProfileModelSource::*;
    match kind {
        AgentKind::Claude => &[AcpConfigOptions, CliModelCommand, AgentSdk, ConfigFile],
        AgentKind::Codex => &[AcpConfigOptions, AgentSdk, ConfigFile],
        AgentKind::OpenCode => &[AcpConfigOptions, AgentSdk, ModelsDevCache, ConfigFile],
        AgentKind::Unknown => &[],
    }
}

/// Read the highest-ranked successful source, with the config file overlaid.
pub async fn read_by_priority(kind: AgentKind, ctx: &ModelReadContext<'_>) -> DiscoveredModels {
    let native_default = super::detect_native_config(kind)
        .ok()
        .flatten()
        .and_then(|cfg| cfg.default_model);
    let config_details = super::read_models(kind, ctx.cwd);

    for source in source_chain(kind) {
        let reading = read_source(kind, *source, ctx).await;
        if !reading.ok {
            tracing::debug!(
                profile = %ctx.profile_name,
                source = source.as_str(),
                error = reading.error.as_deref().unwrap_or("unavailable"),
                "Model source skipped"
            );
            continue;
        }

        let mut details = reading.details;
        let mut sources = vec![*source];

        // Custom providers/models declared in config must survive a live read.
        if *source != ProfileModelSource::ConfigFile && !config_details.is_empty() {
            details = merge_config_overlay(details, &config_details);
            sources.push(ProfileModelSource::ConfigFile);
        }

        let details = dedup_details(details);
        if details.is_empty() {
            tracing::debug!(
                profile = %ctx.profile_name,
                source = source.as_str(),
                "Model source returned no models"
            );
            continue;
        }

        tracing::info!(
            profile = %ctx.profile_name,
            source = source.as_str(),
            models = details.len(),
            "Model source selected"
        );

        return DiscoveredModels {
            details,
            source: *source,
            sources,
            current: reading.current,
            default_model: reading.default_model.or(native_default),
            success: true,
        };
    }

    // Claude Code always has a small built-in alias catalogue even when no
    // config file exists. This is the last-resort fallback, not a live source.
    if kind == AgentKind::Claude {
        return DiscoveredModels {
            details: claude::base_catalog(),
            source: ProfileModelSource::ConfigFile,
            sources: vec![ProfileModelSource::ConfigFile],
            current: None,
            default_model: native_default,
            success: true,
        };
    }

    DiscoveredModels::none(native_default)
}

async fn read_source(
    kind: AgentKind,
    source: ProfileModelSource,
    ctx: &ModelReadContext<'_>,
) -> SourceReading {
    use ProfileModelSource::*;
    match source {
        AcpConfigOptions => {
            acp::read_model_options(ctx.live_agent_id, ctx.wait_for_live_agent).await
        }
        CliModelCommand => match kind {
            AgentKind::Claude => claude::read_cli_models().await,
            _ => SourceReading::unavailable(source, "CLI model query not supported"),
        },
        AgentSdk => match kind {
            AgentKind::Claude => claude::read_sdk().await,
            AgentKind::Codex => codex::read_sdk().await,
            AgentKind::OpenCode => opencode::read_sdk(ctx.cwd).await,
            AgentKind::Unknown => SourceReading::unavailable(source, "unknown agent kind"),
        },
        ModelsDevCache => match kind {
            AgentKind::OpenCode => opencode::read_models_dev_cache(ctx.cwd),
            _ => SourceReading::unavailable(source, "models.dev cache not used for this agent"),
        },
        ConfigFile => {
            let details = super::read_models(kind, ctx.cwd);
            if details.is_empty() {
                SourceReading::unavailable(source, "no models in config file")
            } else {
                SourceReading::success(source, details, Option::None, Option::None)
            }
        }
        None => SourceReading::unavailable(source, "no source"),
    }
}

/// Merge config-declared models into a live source. Config metadata wins for
/// models the user explicitly declared (custom provider names, display names).
pub(crate) fn merge_config_overlay(
    mut base: Vec<ProfileModelDetail>,
    overlay: &[ProfileModelDetail],
) -> Vec<ProfileModelDetail> {
    let mut index: HashMap<String, usize> = base
        .iter()
        .enumerate()
        .map(|(idx, detail)| (detail.id.clone(), idx))
        .collect();

    for item in overlay {
        if let Some(&idx) = index.get(&item.id) {
            let existing = &mut base[idx];
            if !item.name.is_empty() {
                existing.name = item.name.clone();
            }
            if !item.description.is_empty() {
                existing.description = item.description.clone();
            }
            if !item.provider.is_empty() {
                existing.provider = item.provider.clone();
            }
        } else {
            index.insert(item.id.clone(), base.len());
            base.push(item.clone());
        }
    }
    base
}

fn dedup_details(details: Vec<ProfileModelDetail>) -> Vec<ProfileModelDetail> {
    let mut seen = HashSet::new();
    details
        .into_iter()
        .filter(|detail| !detail.id.is_empty() && seen.insert(detail.id.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detail(id: &str, name: &str, provider: &str) -> ProfileModelDetail {
        ProfileModelDetail {
            id: id.to_string(),
            name: name.to_string(),
            description: String::new(),
            provider: provider.to_string(),
        }
    }

    #[test]
    fn config_overlay_adds_custom_models_and_overrides_metadata() {
        let base = vec![
            detail("agnes/agnes-2.5-flash", "agnes/Agnes 2.5 Flash", "agnes"),
            detail("openai/gpt-5", "GPT-5", "openai"),
        ];
        let overlay = vec![
            detail("agnes/agnes-2.5-flash", "agnes-2.5-flash", "Agnes AI"),
            detail("local/custom-model", "custom-model", "Local"),
        ];
        let merged = merge_config_overlay(base, &overlay);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].name, "agnes-2.5-flash");
        assert_eq!(merged[0].provider, "Agnes AI");
        assert_eq!(merged[2].id, "local/custom-model");
    }

    #[test]
    fn source_ranks_are_strictly_ordered() {
        assert!(
            ProfileModelSource::AcpConfigOptions.rank()
                > ProfileModelSource::CliModelCommand.rank()
        );
        assert!(ProfileModelSource::CliModelCommand.rank() > ProfileModelSource::AgentSdk.rank());
        assert!(ProfileModelSource::AgentSdk.rank() > ProfileModelSource::ModelsDevCache.rank());
        assert!(ProfileModelSource::ModelsDevCache.rank() > ProfileModelSource::ConfigFile.rank());
        assert!(ProfileModelSource::ConfigFile.rank() > ProfileModelSource::None.rank());
    }

    #[test]
    fn dedup_keeps_first_occurrence() {
        let input = vec![
            detail("a", "A", "p"),
            detail("a", "A2", "p"),
            detail("b", "B", "p"),
        ];
        let out = dedup_details(input);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "A");
    }
}
