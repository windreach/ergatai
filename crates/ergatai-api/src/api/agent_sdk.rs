use axum::extract::{Path, Query};
use axum::Json;
use lru::LruCache;
use serde::Deserialize;
use std::num::NonZeroUsize;
use std::sync::LazyLock;
use std::sync::Mutex;

/// Maximum number of conversation model overrides to keep in memory.
/// Oldest entries are evicted when this limit is reached (LRU policy).
const CONVERSATION_MODEL_CACHE_SIZE: usize = 1000;

fn conversation_model_store() -> &'static Mutex<LruCache<String, String>> {
    static STORE: LazyLock<Mutex<LruCache<String, String>>> = LazyLock::new(|| {
        Mutex::new(LruCache::new(
            NonZeroUsize::new(CONVERSATION_MODEL_CACHE_SIZE).unwrap(),
        ))
    });
    &STORE
}

pub fn set_conversation_model_override(conv: &str, model: &str) {
    if let Ok(mut g) = conversation_model_store().lock() {
        g.put(conv.to_string(), model.to_string());
    }
}

pub fn get_conversation_model_override(conv: &str) -> Option<String> {
    // LruCache::get requires &mut self to update access order
    conversation_model_store().lock().ok()?.get(conv).cloned()
}

pub async fn apply_model_override(agent_id: &str, conversation_id: &str) {
    if let Some(model) = get_conversation_model_override(conversation_id) {
        let body = SwitchModelRequest {
            model,
            session_id: None,
            conversation_id: None,
        };
        let result = switch_model(Path(agent_id.to_string()), Json(body)).await;
        // Log if the switch returned an error in the JSON response
        if let Some(error) = result.0.get("error") {
            tracing::warn!(%agent_id, %conversation_id, %error, "Failed to apply model override");
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct DiscoverQuery {
    pub agent: String,
    pub cwd: Option<String>,
}

/// GET /api/v1/agent-sdk/discover?agent=claude&cwd=/path
///
/// Internal endpoint. Calls the Node SDK helper and returns the raw JSON.
/// Frontend normally does not call this directly — it goes through
/// `/api/v1/agents/:id/discovery` instead.
pub async fn discover(Query(q): Query<DiscoverQuery>) -> Json<serde_json::Value> {
    Json(crate::services::agent_sdk_service::discover(&q.agent, q.cwd.as_deref()).await)
}

#[derive(Debug, Deserialize)]
pub struct SwitchModelRequest {
    pub model: String,
    pub session_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
}

/// POST /api/v1/agents/:id/model
///
/// Switch the model for a running agent via the SDK helper.
/// Falls back through SDK → ACP → /model slash command (see agent_sdk_service).
pub async fn switch_model(
    Path(agent_id): Path<String>,
    Json(body): Json<SwitchModelRequest>,
) -> Json<serde_json::Value> {
    // Resolve agent kind + cwd from runtime registry.
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    let agent_info = runtime.get_agent(&agent_id).await;

    if agent_info.is_none() {
        if let Some(conv) = body.conversation_id.as_deref() {
            if !body.model.trim().is_empty() {
                set_conversation_model_override(conv, body.model.trim());
                return Json(serde_json::json!({
                    "ok": true,
                    "recorded": true,
                    "message": "model recorded for agent resume"
                }));
            }
        }
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("agent not found: {}", agent_id)
        }));
    }

    let cwd: Option<String> = agent_info.as_ref().and_then(|info| {
        info.handle
            .metadata
            .get("work_dir")
            .cloned()
            .or_else(|| info.handle.workspace.metadata.get("work_dir").cloned())
    });

    let profile_name = agent_info.as_ref().and_then(|i| i.profile.clone());

    let mut kind = String::new();
    if let Some(pn) = profile_name.as_deref() {
        if let Ok(reg) = crate::services::profile_service::get_profile_registry() {
            if let Ok(profiles) = reg.list_with_status() {
                if let Some(p) = profiles.into_iter().find(|x| x.name == pn) {
                    let hay = format!("{} {} {}", p.name, p.command, p.agent_type).to_lowercase();
                    if hay.contains("opencode") {
                        kind = "opencode".into();
                    } else if hay.contains("codex") {
                        kind = "codex".into();
                    } else if hay.contains("claude") {
                        kind = "claude".into();
                    }
                }
            }
        }
    }

    // Fallback: infer kind from profile name when registry lookup missed.
    if kind.is_empty() {
        if let Some(pn) = profile_name.as_deref() {
            let hay = pn.to_lowercase();
            if hay.contains("opencode") {
                kind = "opencode".into();
            } else if hay.contains("codex") {
                kind = "codex".into();
            } else if hay.contains("claude") {
                kind = "claude".into();
            }
        }
    }

    // Priority: SDK first (Claude/OpenCode), then ACP fallback for agents
    // whose SDK does not support runtime model switching (e.g. Codex) or
    // when the SDK call fails. This keeps OpenCode's HTTP SDK path preferred
    // while still allowing ACP-native switching.
    let sdk_result = crate::services::agent_sdk_service::switch_model(
        &kind,
        &body.model,
        cwd.as_deref(),
        body.session_id.as_deref(),
    )
    .await;

    let mut result = sdk_result.clone();
    if !result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        // Fallback to ACP (session/set_model, then /model).
        match crate::services::agent_service::set_agent_model(&agent_id, &body.model).await {
            Ok(_) => {
                result = serde_json::json!({
                    "ok": true,
                    "via": "acp_fallback",
                    "sdk_error": sdk_result.get("error").cloned().unwrap_or(serde_json::Value::Null),
                });
            }
            Err(e) => {
                // Preserve the original SDK error for diagnostics.
                if result.get("error").is_none() {
                    result = serde_json::json!({
                        "ok": false,
                        "error": format!("SDK and ACP model switch failed: {}", e),
                    });
                }
            }
        }
    }

    // On success, refresh the profile model catalog via SDK so future
    // `get_profile_models` reads see the full SDK-reported list with
    // source=agent_sdk. Fall back to recording the single model if SDK
    // refresh returns empty (e.g. codex has no model list API) or when
    // switching succeeded through ACP fallback.
    if result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        if let Some(pn) = profile_name.as_deref() {
            if kind.is_empty() {
                tracing::debug!(agent_id = %agent_id, "Skipping SDK model refresh: unknown agent kind");
            } else {
                match crate::services::profile_service::refresh_profile_models_via_sdk(
                    &kind,
                    pn,
                    cwd.as_deref(),
                )
                .await
                {
                    Ok(refreshed) if refreshed.is_empty() => {
                        let _ = crate::services::profile_service::save_profile_models_by_name(
                            pn,
                            std::slice::from_ref(&body.model),
                            Some(&body.model),
                        )
                        .await;
                    }
                    Ok(_) => {}
                    Err(e) => {
                        tracing::warn!(error = %e, profile = %pn, "SDK model refresh failed");
                    }
                }
            }
        }
    }

    // Persist the selected model for this conversation so a later auto-resume
    // can re-apply it to the restored agent.
    if result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        if let Some(conv) = body.conversation_id.as_deref() {
            set_conversation_model_override(conv, body.model.trim());
        }
    }

    Json(result)
}

/// GET /api/v1/agent-sdk/models?agent=claude&cwd=/path
///
/// Fetch supported models for an agent kind via the SDK helper.
pub async fn models(Query(q): Query<DiscoverQuery>) -> Json<serde_json::Value> {
    let sdk = crate::services::agent_sdk_service::discover(&q.agent, q.cwd.as_deref()).await;
    let models = sdk
        .get("models")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    Json(models)
}

#[derive(Debug, serde::Deserialize)]
pub struct InjectMcpRequest {
    pub session_id: Option<String>,
    /// Optional override of MCP servers to inject. When omitted, all enabled
    /// servers from the Ergatai MCP registry are used.
    pub servers: Option<serde_json::Value>,
}

/// POST /api/v1/agents/:id/mcp/inject
pub async fn inject_mcp(
    axum::extract::Path(agent_id): axum::extract::Path<String>,
    Json(body): Json<InjectMcpRequest>,
) -> Json<serde_json::Value> {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    let agent_info = runtime.get_agent(&agent_id).await;

    if agent_info.is_none() {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("agent not found: {}", agent_id)
        }));
    }

    let cwd: Option<String> = agent_info.as_ref().and_then(|info| {
        info.handle
            .metadata
            .get("work_dir")
            .cloned()
            .or_else(|| info.handle.workspace.metadata.get("work_dir").cloned())
    });

    let profile_name = agent_info.as_ref().and_then(|i| i.profile.clone());

    // Resolve agent kind
    let mut kind = String::new();
    if let Some(pn) = profile_name.as_deref() {
        if let Ok(reg) = crate::services::profile_service::get_profile_registry() {
            if let Ok(profiles) = reg.list_with_status() {
                if let Some(p) = profiles.into_iter().find(|x| x.name == pn) {
                    let hay = format!("{} {} {}", p.name, p.command, p.agent_type).to_lowercase();
                    if hay.contains("opencode") {
                        kind = "opencode".into();
                    } else if hay.contains("codex") {
                        kind = "codex".into();
                    } else if hay.contains("claude") {
                        kind = "claude".into();
                    }
                }
            }
        }
    }
    if kind.is_empty() {
        if let Some(pn) = profile_name.as_deref() {
            let hay = pn.to_lowercase();
            if hay.contains("opencode") {
                kind = "opencode".into();
            } else if hay.contains("codex") {
                kind = "codex".into();
            } else if hay.contains("claude") {
                kind = "claude".into();
            }
        }
    }

    // Resolve session id: body override, then runtime ACP session id.
    let runtime_session_id = if body.session_id.is_none() {
        runtime.backend().session_id(&agent_id).await.ok().flatten()
    } else {
        None
    };
    let session_id = body.session_id.clone().or(runtime_session_id);

    // Build SDK-shaped MCP server map.
    let servers_value = if let Some(s) = body.servers.clone() {
        s
    } else {
        // Fetch enabled Ergatai MCP servers and map to SDK config.
        let mut map = serde_json::Map::new();
        if let Ok(servers) = crate::user_data_db::mcp_servers::list() {
            for s in servers {
                if !s.enabled {
                    continue;
                }
                let cfg = match s.server_type.as_str() {
                    "stdio" => {
                        let c = serde_json::json!({
                            "type": "stdio",
                            "command": s.command.clone().unwrap_or_default(),
                            "args": s.args,
                            "env": s.env,
                        });
                        c
                    }
                    "http" => {
                        serde_json::json!({
                            "type": "http",
                            "url": s.url.clone().unwrap_or_default(),
                            "headers": s.headers,
                        })
                    }
                    "sse" => {
                        serde_json::json!({
                            "type": "sse",
                            "url": s.url.clone().unwrap_or_default(),
                            "headers": s.headers,
                        })
                    }
                    _ => continue,
                };
                map.insert(s.name, cfg);
            }
        }
        serde_json::Value::Object(map)
    };

    let servers_json = servers_value.to_string();

    let result = crate::services::agent_sdk_service::inject_mcp(
        &kind,
        cwd.as_deref(),
        session_id.as_deref(),
        &servers_json,
    )
    .await;

    // Update pending marker in runtime metadata.
    let ok = result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    {
        let mut guard = runtime.registry().write().await;
        if let Some(info) = guard.get_mut(&agent_id) {
            if ok {
                info.handle.metadata.remove("mcp_pending_injection");
            } else {
                info.handle
                    .metadata
                    .insert("mcp_pending_injection".to_string(), "true".to_string());
            }
        }
    }

    Json(result)
}

/// POST /api/v1/mcp/inject-running
///
/// Batch-inject MCP servers into all running agents.
pub async fn inject_mcp_running() -> Json<serde_json::Value> {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    let agents = runtime.list_agents().await;
    let mut results = Vec::new();
    for agent in agents {
        let is_inactive = matches!(
            agent.lifecycle,
            ergatai_runtime::agent_lifecycle::AgentLifecycleState::Suspended { .. }
        ) || matches!(
            agent.lifecycle,
            ergatai_runtime::agent_lifecycle::AgentLifecycleState::Created
        ) || matches!(
            agent.lifecycle,
            ergatai_runtime::agent_lifecycle::AgentLifecycleState::Terminated { .. }
        );
        if is_inactive {
            // Mark pending and skip
            {
                let mut guard = runtime.registry().write().await;
                if let Some(info) = guard.get_mut(&agent.agent_id) {
                    info.handle
                        .metadata
                        .insert("mcp_pending_injection".to_string(), "true".to_string());
                }
            }
            results.push(serde_json::json!({
                "agent_id": agent.agent_id,
                "ok": false,
                "pending": true,
                "error": "agent not running"
            }));
            continue;
        }
        // Reuse per-agent logic by calling inject_mcp handler is not possible (needs Path); inline minimal.
        let cwd = agent
            .handle
            .metadata
            .get("work_dir")
            .cloned()
            .or_else(|| agent.handle.workspace.metadata.get("work_dir").cloned());
        let profile_name = agent.profile.clone();
        let mut kind = String::new();
        if let Some(pn) = profile_name.as_deref() {
            if let Ok(reg) = crate::services::profile_service::get_profile_registry() {
                if let Ok(profiles) = reg.list_with_status() {
                    if let Some(p) = profiles.into_iter().find(|x| x.name == pn) {
                        let hay =
                            format!("{} {} {}", p.name, p.command, p.agent_type).to_lowercase();
                        if hay.contains("opencode") {
                            kind = "opencode".into();
                        } else if hay.contains("codex") {
                            kind = "codex".into();
                        } else if hay.contains("claude") {
                            kind = "claude".into();
                        }
                    }
                }
            }
        }
        if kind.is_empty() {
            if let Some(pn) = profile_name.as_deref() {
                let hay = pn.to_lowercase();
                if hay.contains("opencode") {
                    kind = "opencode".into();
                } else if hay.contains("codex") {
                    kind = "codex".into();
                } else if hay.contains("claude") {
                    kind = "claude".into();
                }
            }
        }

        let session_id = runtime
            .backend()
            .session_id(&agent.agent_id)
            .await
            .ok()
            .flatten();

        // Build servers map
        let mut map = serde_json::Map::new();
        if let Ok(servers) = crate::user_data_db::mcp_servers::list() {
            for s in servers {
                if !s.enabled {
                    continue;
                }
                let cfg = match s.server_type.as_str() {
                    "stdio" => serde_json::json!({
                        "type": "stdio",
                        "command": s.command.clone().unwrap_or_default(),
                        "args": s.args,
                        "env": s.env,
                    }),
                    "http" => serde_json::json!({
                        "type": "http",
                        "url": s.url.clone().unwrap_or_default(),
                        "headers": s.headers,
                    }),
                    "sse" => serde_json::json!({
                        "type": "sse",
                        "url": s.url.clone().unwrap_or_default(),
                        "headers": s.headers,
                    }),
                    _ => continue,
                };
                map.insert(s.name, cfg);
            }
        }
        let servers_json = serde_json::Value::Object(map).to_string();

        let res = crate::services::agent_sdk_service::inject_mcp(
            &kind,
            cwd.as_deref(),
            session_id.as_deref(),
            &servers_json,
        )
        .await;

        let ok = res.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
        {
            let mut guard = runtime.registry().write().await;
            if let Some(info) = guard.get_mut(&agent.agent_id) {
                if ok {
                    info.handle.metadata.remove("mcp_pending_injection");
                } else {
                    info.handle
                        .metadata
                        .insert("mcp_pending_injection".to_string(), "true".to_string());
                }
            }
        }

        results.push(serde_json::json!({
            "agent_id": agent.agent_id,
            "ok": ok,
            "result": res,
        }));
    }

    Json(serde_json::json!({
        "ok": true,
        "results": results,
    }))
}

/// Process pending MCP injections for agents that were marked while suspended.
pub async fn process_pending_mcp_injections() -> Json<serde_json::Value> {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    let agents = runtime.list_agents().await;
    let mut results = Vec::new();
    for agent in agents {
        let pending = agent
            .handle
            .metadata
            .get("mcp_pending_injection")
            .map(|v| v == "true")
            .unwrap_or(false);
        if !pending {
            continue;
        }
        // Only inject when alive
        let alive = !matches!(
            agent.lifecycle,
            ergatai_runtime::agent_lifecycle::AgentLifecycleState::Suspended { .. }
        ) && !matches!(
            agent.lifecycle,
            ergatai_runtime::agent_lifecycle::AgentLifecycleState::Terminated { .. }
        );
        if !alive {
            continue;
        }
        let cwd = agent
            .handle
            .metadata
            .get("work_dir")
            .cloned()
            .or_else(|| agent.handle.workspace.metadata.get("work_dir").cloned());
        let profile_name = agent.profile.clone();
        let mut kind = String::new();
        if let Some(pn) = profile_name.as_deref() {
            if let Ok(reg) = crate::services::profile_service::get_profile_registry() {
                if let Ok(profiles) = reg.list_with_status() {
                    if let Some(p) = profiles.into_iter().find(|x| x.name == pn) {
                        let hay =
                            format!("{} {} {}", p.name, p.command, p.agent_type).to_lowercase();
                        if hay.contains("opencode") {
                            kind = "opencode".into();
                        } else if hay.contains("codex") {
                            kind = "codex".into();
                        } else if hay.contains("claude") {
                            kind = "claude".into();
                        }
                    }
                }
            }
        }
        if kind.is_empty() {
            if let Some(pn) = profile_name.as_deref() {
                let hay = pn.to_lowercase();
                if hay.contains("opencode") {
                    kind = "opencode".into();
                } else if hay.contains("codex") {
                    kind = "codex".into();
                } else if hay.contains("claude") {
                    kind = "claude".into();
                }
            }
        }

        let session_id = runtime
            .backend()
            .session_id(&agent.agent_id)
            .await
            .ok()
            .flatten();

        let mut map = serde_json::Map::new();
        if let Ok(servers) = crate::user_data_db::mcp_servers::list() {
            for s in servers {
                if !s.enabled {
                    continue;
                }
                let cfg = match s.server_type.as_str() {
                    "stdio" => serde_json::json!({
                        "type": "stdio",
                        "command": s.command.clone().unwrap_or_default(),
                        "args": s.args,
                        "env": s.env,
                    }),
                    "http" => serde_json::json!({
                        "type": "http",
                        "url": s.url.clone().unwrap_or_default(),
                        "headers": s.headers,
                    }),
                    "sse" => serde_json::json!({
                        "type": "sse",
                        "url": s.url.clone().unwrap_or_default(),
                        "headers": s.headers,
                    }),
                    _ => continue,
                };
                map.insert(s.name, cfg);
            }
        }
        let servers_json = serde_json::Value::Object(map).to_string();

        let res = crate::services::agent_sdk_service::inject_mcp(
            &kind,
            cwd.as_deref(),
            session_id.as_deref(),
            &servers_json,
        )
        .await;

        let ok = res.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
        {
            let mut guard = runtime.registry().write().await;
            if let Some(info) = guard.get_mut(&agent.agent_id) {
                if ok {
                    info.handle.metadata.remove("mcp_pending_injection");
                }
            }
        }

        results.push(serde_json::json!({
            "agent_id": agent.agent_id,
            "ok": ok,
            "result": res,
        }));
    }

    Json(serde_json::json!({
        "ok": true,
        "processed": results.len(),
        "results": results,
    }))
}
