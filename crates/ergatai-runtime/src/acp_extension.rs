//! ACP extension-field consumption.
//!
//! Official ACP adapters (claude-agent-acp / codex-acp / opencode acp) already
//! emit rich information through three channels:
//!
//!   1. the standard ACP fields,
//!   2. the reserved `_meta` map on notifications/updates,
//!   3. custom `sessionUpdate` kinds (e.g. `subagent_spawned`).
//!
//! This module is the *consumer* side: pure parsing helpers that turn those
//! extension payloads into typed Rust values, plus defensive handling so that
//! missing/unknown fields never panic. It deliberately does not spawn or
//! rewrite any adapter process.

use serde_json::Value;

/// Parsed thread status reported by Codex via `_meta.codex.threadStatus`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ThreadStatus {
    pub kind: String,
    pub active_flags: Vec<String>,
}

/// Parsed quota/token-count detail reported by Codex via
/// `_meta.codex.quota.token_count`.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct QuotaDetail {
    pub total_tokens: Option<u64>,
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub cache_write_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_output_tokens: Option<u64>,
    pub model_usage: Option<Value>,
}

/// Parsed structured error payload from a JSON-RPC `error.data` object
/// (e.g. OpenCode's `{ service, errorName }`).
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct ErrorDetail {
    pub service: Option<String>,
    pub error_name: Option<String>,
    pub code: Option<i64>,
    pub message: Option<String>,
}

/// Unified, provider-normalized view of ACP extension metadata.
///
/// This is the canonical rule set for Claude/Codex/OpenCode (and known
/// vendor namespaces): adapter-specific `_meta` keys are mapped into these
/// common categories so consumers do not need per-adapter branching.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UnifiedExtensionMeta {
    /// Schema identifier for the unified mapping rules.
    pub schema: String,
    /// Detected provider/adapter sources contributing to this metadata.
    pub sources: Vec<String>,
    pub capabilities: UnifiedCapabilities,
    pub status: UnifiedStatus,
    pub usage: UnifiedUsage,
    pub limits: UnifiedLimits,
    pub auth: UnifiedAuth,
    pub context: UnifiedContext,
    pub error: Option<ErrorDetail>,
}

/// Adapter/session capability declarations (usually from init/capability negotiation),
/// used by backend/runtime behavior control.
/// NOTE: Not emitted on the unified `AgentOutputEvent` stream by default; add later
/// per-field if a frontend/external consumer needs it ("提一个发一个").
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UnifiedCapabilities {
    pub steering_supported: Option<bool>,
    pub idle_behavior: Option<String>,
    pub child_session_updates: Option<bool>,
}

/// Adapter-reported thread/session status from ACP extension `_meta`
/// (e.g. Codex `threadStatus`: state + active flags). Values are adapter-defined.
/// NOTE: May overlap with the project's own state machine; kept for now for
/// observation and potential mapping/calibration, not emitted on the unified
/// `AgentOutputEvent` stream unless explicitly mapped/agreed ("提一个发一个").
/// Revisit later whether to retain, map, or remove.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UnifiedStatus {
    pub thread_state: Option<String>,
    pub active_flags: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UnifiedUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub cache_write_input_tokens: Option<u64>,
    pub reasoning_output_tokens: Option<u64>,
    pub model_usage: Option<Value>,
}

/// Rate/usage limit metadata (e.g. 429/quota window/reset info) reported by adapters.
/// This is status/metadata for dashboards or state inspection; it is not emitted on
/// the unified `AgentOutputEvent` stream unless explicitly agreed (use "提一个发一个").
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UnifiedLimits {
    pub rate_limit: Option<Value>,
}

/// Authentication/authorization status (e.g. account/gateway/session auth state).
/// This is status/metadata for dashboards or state inspection; actual auth failures
/// are surfaced via `AgentOutputEvent::Error`. Not emitted on the unified stream
/// unless explicitly agreed (use "提一个发一个").
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UnifiedAuth {
    pub status: Option<Value>,
}

/// Model/context/vendor-specific metadata carried in extension fields.
/// Mostly for backend/runtime handling, diagnostics, or passthrough.
/// NOTE: Not emitted on the unified `AgentOutputEvent` stream by default; add later
/// per-field if a frontend/external consumer needs it ("提一个发一个").
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UnifiedContext {
    pub compaction: Option<Value>,
    pub prompt_suggestions: Option<Value>,
    pub goal: Option<Value>,
    pub model: Option<Value>,
    pub origin: Option<Value>,
    pub sdk_message: Option<Value>,
    pub claude_code: Option<Value>,
}

/// Aggregated extension metadata extracted from a single `_meta` map (or
/// from an `error.data` payload). Every field is optional; missing data is
/// simply `None`.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ExtensionMeta {
    pub steering_supported: Option<bool>,
    pub idle_behavior: Option<String>,
    pub child_session_updates: Option<bool>,
    pub compaction: Option<Value>,
    pub thread_status: Option<ThreadStatus>,
    pub quota: Option<QuotaDetail>,
    pub rate_limit: Option<Value>,
    pub auth_status: Option<Value>,
    pub model: Option<Value>,
    pub origin: Option<Value>,
    pub sdk_message: Option<Value>,
    pub claude_code: Option<Value>,
    pub model_usage: Option<Value>,
    pub prompt_suggestions: Option<Value>,
    pub jetbrains: Option<Value>,
    pub goal: Option<Value>,
    pub error: Option<ErrorDetail>,
    /// Provider-normalized canonical view derived from the fields above.
    pub unified: Option<UnifiedExtensionMeta>,
}

/// Helper: read a `u64` from a JSON value that may be a number or a string.
fn as_u64(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse::<u64>().ok(),
        _ => None,
    }
}

/// Helper: read a bool from a JSON value.
fn as_bool(v: &Value) -> Option<bool> {
    v.as_bool()
}

/// Look up a value trying several candidate keys (flat slash-keys first, then
/// nested). Returns the first hit.
fn get_any<'a>(meta: &'a serde_json::Map<String, Value>, candidates: &[&str]) -> Option<&'a Value> {
    for key in candidates {
        if let Some(v) = meta.get(*key) {
            return Some(v);
        }
    }
    // Nested fallback: try splitting on '/' for keys like "codex/threadStatus"
    // stored under a parent "codex" object.
    for key in candidates {
        if let Some((parent, child)) = key.split_once('/') {
            if let Some(parent_obj) = meta.get(parent).and_then(|v| v.as_object()) {
                if let Some(v) = parent_obj.get(child) {
                    return Some(v);
                }
                // also try camelCase child
                let camel = to_camel(child);
                if let Some(v) = parent_obj.get(&camel) {
                    return Some(v);
                }
            }
        }
    }
    None
}

fn to_camel(s: &str) -> String {
    // simple snake_case -> camelCase for a single segment
    let mut out = String::new();
    let mut upper = false;
    for c in s.chars() {
        if c == '_' || c == '-' {
            upper = true;
        } else if upper {
            out.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// Parse a `_meta` map into [`ExtensionMeta`].
pub fn parse_meta(meta: Option<&serde_json::Map<String, Value>>) -> ExtensionMeta {
    let mut out = ExtensionMeta::default();
    let Some(meta) = meta else {
        return out;
    };

    // steering: { "supported": bool } or { "idleBehavior": ... } (Codex)
    // (top-level or under "steering")
    if let Some(v) = get_any(
        meta,
        &[
            "steering",
            "opencode/steering",
            "_session/steering",
            "session/steering",
        ],
    ) {
        if let Some(obj) = v.as_object() {
            if let Some(s) = obj.get("supported").and_then(as_bool) {
                out.steering_supported = Some(s);
            }
            // Codex ACP advertises steering via `idleBehavior` instead of
            // `supported`; treat its presence as supported.
            if obj.contains_key("idleBehavior") || obj.contains_key("idle_behavior") {
                if out.steering_supported.is_none() {
                    out.steering_supported = Some(true);
                }
                let ib = obj.get("idleBehavior").or_else(|| obj.get("idle_behavior"));
                if let Some(s) = ib.and_then(|x| x.as_str()) {
                    out.idle_behavior = Some(s.to_string());
                } else if let Some(s) = ib.map(|x| x.to_string()) {
                    // keep a stringified fallback for non-string values
                    if !s.is_empty() && s != "null" {
                        out.idle_behavior = Some(s);
                    }
                }
            }
        } else if let Some(b) = as_bool(v) {
            out.steering_supported = Some(b);
        }
    }

    // child-session-updates: bool (flat key "opencode/child-session-updates")
    if let Some(v) = get_any(
        meta,
        &[
            "opencode/child-session-updates",
            "childSessionUpdates",
            "child_session_updates",
        ],
    ) {
        if let Some(b) = as_bool(v) {
            out.child_session_updates = Some(b);
        } else if let Some(obj) = v.as_object() {
            if let Some(b) = obj.get("supported").and_then(as_bool) {
                out.child_session_updates = Some(b);
            }
        }
    }

    // compaction: OpenCode reports compaction progress via _meta.opencode/compaction
    if let Some(v) = get_any(meta, &["opencode/compaction", "compaction"]) {
        out.compaction = Some(v.clone());
    }

    // thread status: _meta.codex.threadStatus { type, activeFlags }
    if let Some(v) = get_any(
        meta,
        &["codex/threadStatus", "threadStatus", "thread_status"],
    ) {
        out.thread_status = parse_thread_status(v);
    }

    // quota: _meta.codex.quota.token_count { ... }
    if let Some(v) = get_any(meta, &["codex/quota", "quota"]) {
        // v may be { token_count: {...}, model_usage: [...] } or the token_count object itself
        let token_obj = v.get("token_count").unwrap_or(v);
        if let Some(mut q) = parse_quota(token_obj) {
            if q.model_usage.is_none() {
                if let Some(mu) = v.get("model_usage").or_else(|| v.get("modelUsage")) {
                    q.model_usage = Some(mu.clone());
                }
            }
            out.quota = Some(q);
        }
        // Also keep a top-level mirror for callers that read extension model_usage.
        if let Some(mv) = v.get("model_usage").or_else(|| v.get("modelUsage")) {
            if out.model_usage.is_none() {
                out.model_usage = Some(mv.clone());
            }
        }
    }

    // rate limit (claude)
    if let Some(v) = get_any(
        meta,
        &[
            "_claude/rateLimit",
            "claude/rateLimit",
            "rateLimit",
            "rate_limit",
        ],
    ) {
        out.rate_limit = Some(v.clone());
    }

    // model (claude)
    if let Some(v) = get_any(meta, &["_claude/model", "claude/model", "model"]) {
        out.model = Some(v.clone());
    }

    // origin (claude)
    if let Some(v) = get_any(meta, &["_claude/origin", "claude/origin", "origin"]) {
        out.origin = Some(v.clone());
    }

    // sdkMessage (claude)
    if let Some(v) = get_any(
        meta,
        &[
            "_claude/sdkMessage",
            "claude/sdkMessage",
            "sdkMessage",
            "sdk_message",
        ],
    ) {
        out.sdk_message = Some(v.clone());
    }

    // auth status
    if let Some(v) = get_any(meta, &["authStatus", "auth_status"]) {
        out.auth_status = Some(v.clone());
    }

    // claudeCode (nested object)
    if let Some(v) = meta
        .get("claudeCode")
        .cloned()
        .or_else(|| meta.get("claude_code").cloned())
    {
        out.claude_code = Some(v);
    }

    // jetbrains (AIR extensions nest under _meta.jetbrains, e.g. jetbrains.air)
    if let Some(v) = meta.get("jetbrains").cloned() {
        out.jetbrains = Some(v);
    }

    // goal (session_info_update._meta.goal)
    if let Some(v) = meta.get("goal").cloned() {
        out.goal = Some(v);
    }

    // model_usage (session/prompt response _meta, e.g. Claude token accounting)
    if let Some(v) = get_any(meta, &["model_usage", "modelUsage", "modelUsageDetail"]) {
        out.model_usage = Some(v.clone());
    }

    // prompt suggestions (session_info_update._meta)
    if let Some(v) = get_any(
        meta,
        &[
            "promptSuggestions",
            "prompt_suggestions",
            "promptSuggestions",
        ],
    ) {
        out.prompt_suggestions = Some(v.clone());
    }

    out.unified = build_unified(&out, Some(meta));
    out
}

fn detect_sources(
    meta: Option<&serde_json::Map<String, Value>>,
    ext: &ExtensionMeta,
) -> Vec<String> {
    let mut sources: Vec<String> = Vec::new();
    let push_source = |sources: &mut Vec<String>, s: &str| {
        if !sources.iter().any(|x| x == s) {
            sources.push(s.to_string());
        }
    };
    if let Some(meta) = meta {
        for (k, v) in meta {
            let lk = k.to_ascii_lowercase();
            if lk.starts_with("codex") || lk.contains("/codex") || k == "codex" {
                push_source(&mut sources, "codex");
            }
            if lk.starts_with("_claude")
                || lk.starts_with("claude")
                || lk == "claudecode"
                || lk == "claude_code"
                || lk.contains("/claude")
                || matches!(
                    k.as_str(),
                    "_claude" | "claude" | "claudeCode" | "claude_code"
                )
            {
                push_source(&mut sources, "claude");
            }
            if lk.starts_with("opencode") || lk.contains("/opencode") || k == "opencode" {
                push_source(&mut sources, "opencode");
            }
            if lk.starts_with("jetbrains") || lk.contains("/jetbrains") || k == "jetbrains" {
                push_source(&mut sources, "jetbrains");
            }
            let _ = v; // value may inform nested presence in other checks
        }
    }
    if ext.thread_status.is_some() || ext.quota.is_some() {
        push_source(&mut sources, "codex");
    }
    if ext.rate_limit.is_some()
        || ext.origin.is_some()
        || ext.sdk_message.is_some()
        || ext.claude_code.is_some()
    {
        push_source(&mut sources, "claude");
    }
    if ext.child_session_updates.is_some() || ext.compaction.is_some() {
        push_source(&mut sources, "opencode");
    }
    if ext.jetbrains.is_some() {
        push_source(&mut sources, "jetbrains");
    }
    if sources.is_empty() {
        push_source(&mut sources, "unknown");
    }
    sources
}

fn build_unified(
    ext: &ExtensionMeta,
    meta: Option<&serde_json::Map<String, Value>>,
) -> Option<UnifiedExtensionMeta> {
    let has_signal = ext.steering_supported.is_some()
        || ext.idle_behavior.is_some()
        || ext.child_session_updates.is_some()
        || ext.compaction.is_some()
        || ext.thread_status.is_some()
        || ext.quota.is_some()
        || ext.rate_limit.is_some()
        || ext.auth_status.is_some()
        || ext.model.is_some()
        || ext.origin.is_some()
        || ext.sdk_message.is_some()
        || ext.claude_code.is_some()
        || ext.model_usage.is_some()
        || ext.prompt_suggestions.is_some()
        || ext.jetbrains.is_some()
        || ext.goal.is_some()
        || ext.error.is_some();
    if !has_signal {
        return None;
    }
    let (thread_state, active_flags) = ext
        .thread_status
        .as_ref()
        .map(|t| (Some(t.kind.clone()), t.active_flags.clone()))
        .unwrap_or((None, Vec::new()));
    let q = ext.quota.as_ref();
    Some(UnifiedExtensionMeta {
        schema: "ergatai.acp.extension.v1".to_string(),
        sources: detect_sources(meta, ext),
        capabilities: UnifiedCapabilities {
            steering_supported: ext.steering_supported,
            idle_behavior: ext.idle_behavior.clone(),
            child_session_updates: ext.child_session_updates,
        },
        status: UnifiedStatus {
            thread_state,
            active_flags,
        },
        usage: UnifiedUsage {
            input_tokens: q.and_then(|x| x.input_tokens),
            output_tokens: q.and_then(|x| x.output_tokens),
            total_tokens: q.and_then(|x| x.total_tokens),
            cached_input_tokens: q.and_then(|x| x.cached_input_tokens),
            cache_write_input_tokens: q.and_then(|x| x.cache_write_input_tokens),
            reasoning_output_tokens: q.and_then(|x| x.reasoning_output_tokens),
            model_usage: ext
                .model_usage
                .clone()
                .or_else(|| q.and_then(|x| x.model_usage.clone())),
        },
        limits: UnifiedLimits {
            rate_limit: ext.rate_limit.clone(),
        },
        auth: UnifiedAuth {
            status: ext.auth_status.clone(),
        },
        context: UnifiedContext {
            compaction: ext.compaction.clone(),
            prompt_suggestions: ext.prompt_suggestions.clone(),
            goal: ext.goal.clone(),
            model: ext.model.clone(),
            origin: ext.origin.clone(),
            sdk_message: ext.sdk_message.clone(),
            claude_code: ext.claude_code.clone(),
        },
        error: ext.error.clone(),
    })
}

/// Recompute the provider-normalized `unified` view from current fields.
/// Use after merging partial updates when raw `_meta` map is unavailable.
pub fn normalize_extension_meta(ext: &mut ExtensionMeta) {
    ext.unified = build_unified(ext, None);
}

/// Parse a thread-status JSON value.
pub fn parse_thread_status(v: &Value) -> Option<ThreadStatus> {
    let obj = v.as_object()?;
    let kind = obj
        .get("type")
        .or_else(|| obj.get("kind"))
        .or_else(|| obj.get("status"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())?;
    let active_flags = obj
        .get("activeFlags")
        .or_else(|| obj.get("active_flags"))
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| e.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Some(ThreadStatus { kind, active_flags })
}

/// Parse a quota/token-count JSON value.
pub fn parse_quota(v: &Value) -> Option<QuotaDetail> {
    let obj = v.as_object()?;
    let mut q = QuotaDetail::default();
    let mut any = false;
    macro_rules! field {
        ($rust:ident, $keys:expr) => {
            for k in $keys {
                if let Some(val) = obj.get(*k) {
                    if let Some(n) = as_u64(val) {
                        q.$rust = Some(n);
                        any = true;
                        break;
                    }
                }
            }
        };
    }
    field!(total_tokens, &["totalTokens", "total_tokens", "total"]);
    field!(input_tokens, &["inputTokens", "input_tokens", "input"]);
    field!(
        cached_input_tokens,
        &[
            "cachedInputTokens",
            "cached_input_tokens",
            "cachedReadTokens",
            "cached_read_tokens",
            "cachedInput",
            "cachedRead",
            "cached_read",
            "cached"
        ]
    );
    field!(
        cache_write_input_tokens,
        &[
            "cacheWriteInputTokens",
            "cache_write_input_tokens",
            "cacheWrite",
            "cachedWriteTokens",
            "cached_write_tokens",
            "cachedWrite"
        ]
    );
    field!(output_tokens, &["outputTokens", "output_tokens", "output"]);
    field!(
        reasoning_output_tokens,
        &[
            "reasoningOutputTokens",
            "reasoning_output_tokens",
            "reasoning",
            "thoughtTokens",
            "thought_tokens",
            "thoughts"
        ]
    );
    // model_usage: [{ model, token_count }] (Codex quota)
    if let Some(mu) = obj.get("model_usage").or_else(|| obj.get("modelUsage")) {
        q.model_usage = Some(mu.clone());
        any = true;
    }
    if any {
        Some(q)
    } else {
        None
    }
}

/// Top-level `_meta` keys that the consumer explicitly understands.
const KNOWN_META_TOP_KEYS: &[&str] = &[
    "steering",
    "codex",
    "claude",
    "_claude",
    "opencode",
    "authStatus",
    "auth_status",
    "claudeCode",
    "claude_code",
    "jetbrains",
    "goal",
    "model_usage",
    "modelUsage",
    "promptSuggestions",
    "prompt_suggestions",
    "_askUserQuestionCustomAnswer",
    "terminal_info",
    "terminal_output",
    "terminal_exit",
    "quota",
];

/// Flat (slash) `_meta` keys that the consumer explicitly understands.
const KNOWN_META_SLASH_KEYS: &[&str] = &[
    "opencode/child-session-updates",
    "opencode/steering",
    "opencode/compaction",
    "codex/threadStatus",
    "codex/quota",
    "_claude/rateLimit",
    "_claude/model",
    "_claude/origin",
    "_claude/sdkMessage",
    "_claude/askUserQuestionOption",
];

/// Return the list of top-level `_meta` keys that are *not* explicitly
/// understood by the consumer. Used for drift detection: when an adapter
/// upgrades and starts emitting new extension keys, they show up here.
pub fn unknown_meta_keys(meta: &serde_json::Map<String, Value>) -> Vec<String> {
    let mut out = Vec::new();
    for key in meta.keys() {
        let known = KNOWN_META_TOP_KEYS.contains(&key.as_str())
            || KNOWN_META_SLASH_KEYS.contains(&key.as_str());
        if !known {
            out.push(key.clone());
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Enrich an error message with structured detail from an `error.data` payload
/// (when present), so callers see e.g. the service / error name.
pub fn enrich_error_message(base: &str, data: Option<&Value>) -> String {
    let Some(data) = data else {
        return base.to_string();
    };
    let detail = parse_error_data(data);
    let mut parts = Vec::new();
    if let Some(s) = &detail.service {
        parts.push(format!("service={s}"));
    }
    if let Some(n) = &detail.error_name {
        parts.push(format!("code={n}"));
    }
    if let Some(c) = detail.code {
        parts.push(format!("numeric_code={c}"));
    }
    if let Some(m) = &detail.message {
        if m != base {
            parts.push(format!("detail={m}"));
        }
    }
    if parts.is_empty() {
        base.to_string()
    } else {
        format!("{base} [{}]", parts.join(", "))
    }
}

/// Parse an `error.data` JSON value into [`ErrorDetail`].
pub fn parse_error_data(v: &Value) -> ErrorDetail {
    let mut out = ErrorDetail::default();
    if let Some(obj) = v.as_object() {
        out.service = obj
            .get("service")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        out.error_name = obj
            .get("errorName")
            .or_else(|| obj.get("error_name"))
            .or_else(|| obj.get("errorKind"))
            .or_else(|| obj.get("error_kind"))
            .or_else(|| obj.get("code"))
            .and_then(|x| x.as_str().map(|s| s.to_string()));
        out.code = obj.get("code").and_then(|x| {
            if let Some(n) = x.as_i64() {
                Some(n)
            } else {
                x.as_str().and_then(|s| s.parse::<i64>().ok())
            }
        });
        out.message = obj
            .get("message")
            .or_else(|| obj.get("detail"))
            .or_else(|| obj.get("details"))
            .or_else(|| obj.get("additionalDetails"))
            .or_else(|| obj.get("additional_details"))
            .or_else(|| obj.get("title"))
            .or_else(|| obj.get("reason"))
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
    } else if let Some(s) = v.as_str() {
        out.message = Some(s.to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_meta_codex_quota_and_thread() {
        let meta = json!({
            "codex": {
                "threadStatus": { "type": "active", "activeFlags": [] },
                "quota": { "token_count": {
                    "totalTokens": 14326,
                    "inputTokens": 14307,
                    "cachedInputTokens": 0,
                    "cacheWriteInputTokens": 0,
                    "outputTokens": 19,
                    "reasoningOutputTokens": 16
                }}
            },
            "steering": { "supported": true },
            "authStatus": {}
        });
        let obj = meta.as_object().unwrap();
        let ext = parse_meta(Some(obj));
        assert_eq!(ext.steering_supported, Some(true));
        let ts = ext.thread_status.unwrap();
        assert_eq!(ts.kind, "active");
        assert!(ts.active_flags.is_empty());
        let q = ext.quota.unwrap();
        assert_eq!(q.total_tokens, Some(14326));
        assert_eq!(q.input_tokens, Some(14307));
        assert_eq!(q.cached_input_tokens, Some(0));
        assert_eq!(q.cache_write_input_tokens, Some(0));
        assert_eq!(q.output_tokens, Some(19));
        assert_eq!(q.reasoning_output_tokens, Some(16));
        assert!(ext.auth_status.is_some());
    }

    #[test]
    fn parse_meta_claude_flat_keys() {
        let meta = json!({
            "_claude/rateLimit": { "remaining": 10 },
            "_claude/model": "claude-sonnet-4",
            "_claude/origin": "anthropic",
            "steering": { "supported": true }
        });
        let obj = meta.as_object().unwrap();
        let ext = parse_meta(Some(obj));
        assert_eq!(ext.steering_supported, Some(true));
        assert!(ext.rate_limit.is_some());
        assert_eq!(ext.model.as_ref().unwrap(), &json!("claude-sonnet-4"));
        assert_eq!(ext.origin.as_ref().unwrap(), &json!("anthropic"));
    }

    #[test]
    fn parse_meta_opencode_child_session_updates() {
        let meta = json!({
            "opencode/child-session-updates": true,
            "steering": { "supported": true }
        });
        let obj = meta.as_object().unwrap();
        let ext = parse_meta(Some(obj));
        assert_eq!(ext.child_session_updates, Some(true));
        assert_eq!(ext.steering_supported, Some(true));
    }

    #[test]
    fn parse_meta_opencode_compaction_and_steering_slash() {
        let meta = json!({
            "opencode/compaction": { "status": "started", "messageId": "m1", "reason": "user" },
            "opencode/steering": { "supported": true }
        });
        let obj = meta.as_object().unwrap();
        let ext = parse_meta(Some(obj));
        assert!(ext.compaction.is_some());
        assert_eq!(ext.steering_supported, Some(true));
        // The flat slash key must be recognized as known (no drift).
        assert!(unknown_meta_keys(obj).is_empty());
    }

    #[test]
    fn parse_quota_claude_cached_write_alias() {
        let v = json!({
            "totalTokens": 10,
            "inputTokens": 5,
            "cachedWriteTokens": 2,
            "outputTokens": 3,
            "reasoningOutputTokens": 0
        });
        let q = parse_quota(&v).unwrap();
        assert_eq!(q.total_tokens, Some(10));
        assert_eq!(q.cache_write_input_tokens, Some(2));
        assert_eq!(q.output_tokens, Some(3));
    }

    #[test]
    fn parse_meta_none_is_empty() {
        let ext = parse_meta(None);
        assert_eq!(ext, ExtensionMeta::default());
    }

    #[test]
    fn parse_meta_missing_fields_no_panic() {
        let meta = json!({ "unrelated": 42 });
        let obj = meta.as_object().unwrap();
        let ext = parse_meta(Some(obj));
        assert!(ext.steering_supported.is_none());
        assert!(ext.quota.is_none());
        assert!(ext.thread_status.is_none());
        assert!(ext.compaction.is_none());
    }

    #[test]
    fn parse_thread_status_camel_and_snake() {
        let v = json!({ "type": "idle", "activeFlags": ["x"] });
        let ts = parse_thread_status(&v).unwrap();
        assert_eq!(ts.kind, "idle");
        assert_eq!(ts.active_flags, vec!["x".to_string()]);

        let v2 = json!({ "status": "active", "active_flags": [] });
        let ts2 = parse_thread_status(&v2).unwrap();
        assert_eq!(ts2.kind, "active");
    }

    #[test]
    fn parse_quota_partial() {
        let v = json!({ "inputTokens": 5, "outputTokens": 7 });
        let q = parse_quota(&v).unwrap();
        assert_eq!(q.input_tokens, Some(5));
        assert_eq!(q.output_tokens, Some(7));
        assert!(q.total_tokens.is_none());
    }

    #[test]
    fn parse_quota_empty_returns_none() {
        let v = json!({ "foo": "bar" });
        assert!(parse_quota(&v).is_none());
    }

    #[test]
    fn parse_error_data_opencode() {
        let v = json!({ "service": "session", "errorName": "provider.free-limit" });
        let e = parse_error_data(&v);
        assert_eq!(e.service.as_deref(), Some("session"));
        assert_eq!(e.error_name.as_deref(), Some("provider.free-limit"));
    }

    #[test]
    fn parse_error_data_string_fallback() {
        let v = json!("boom");
        let e = parse_error_data(&v);
        assert_eq!(e.message.as_deref(), Some("boom"));
    }

    #[test]
    fn enrich_error_message_with_data() {
        let data = json!({ "service": "session", "errorName": "provider.free-limit" });
        let out = enrich_error_message("Internal error: boom", Some(&data));
        assert!(out.contains("service=session"));
        assert!(out.contains("code=provider.free-limit"));
    }

    #[test]
    fn enrich_error_message_without_data() {
        assert_eq!(enrich_error_message("boom", None), "boom");
    }

    #[test]
    fn parse_error_data_code_numeric() {
        let v = json!({ "code": 42, "message": "nope" });
        let e = parse_error_data(&v);
        assert_eq!(e.code, Some(42));
        assert_eq!(e.message.as_deref(), Some("nope"));
    }

    #[test]
    fn unknown_meta_keys_detects_new_keys() {
        let meta = json!({
            "steering": { "supported": true },
            "codex": { "threadStatus": { "type": "idle" } },
            "brand_new_extension": 1,
            "another/unknown": 2
        });
        let obj = meta.as_object().unwrap();
        let mut unknown = unknown_meta_keys(obj);
        unknown.sort();
        assert_eq!(
            unknown,
            vec![
                "another/unknown".to_string(),
                "brand_new_extension".to_string()
            ]
        );
    }

    #[test]
    fn unknown_meta_keys_empty_for_known() {
        let meta = json!({
            "steering": { "supported": true },
            "authStatus": {},
            "model_usage": { "inputTokens": 1 },
            "promptSuggestions": ["a"]
        });
        let obj = meta.as_object().unwrap();
        assert!(unknown_meta_keys(obj).is_empty());
    }

    #[test]
    fn parse_meta_model_usage_and_prompt_suggestions() {
        let meta = json!({
            "model_usage": { "totalTokens": 5 },
            "promptSuggestions": ["x", "y"]
        });
        let obj = meta.as_object().unwrap();
        let ext = parse_meta(Some(obj));
        assert!(ext.model_usage.is_some());
        assert!(ext.prompt_suggestions.is_some());
    }
}
