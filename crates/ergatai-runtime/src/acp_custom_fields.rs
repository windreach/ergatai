//! ACP adapter-specific custom fields.
//!
//! This module centralizes parsing/normalization for non-standard ACP data that
//! is carried either in `_meta` maps or in adapter-specific tool-call metadata.
//! Keeping these rules here prevents `acp.rs` / `acp_extension.rs` from becoming
//! a dumping ground for adapter-specific heuristics.

use agent_client_protocol::schema::v1::ToolCall as AcpToolCall;
use serde_json::Value;

/// Extract a compaction payload from an ACP `_meta` map.
///
/// Supported sources:
/// - OpenCode: `opencode/compaction` or `compaction`
/// - Claude AIR: `jetbrains.air.contextCompaction` or `contextCompaction`
pub fn extract_compaction(meta: Option<&serde_json::Map<String, Value>>) -> Option<Value> {
    let meta = meta?;

    for key in [
        "opencode/compaction",
        "compaction",
        "contextCompaction",
        "context_compaction",
    ] {
        if let Some(v) = meta.get(key) {
            return Some(v.clone());
        }
    }

    // Nested AIR extension: _meta.jetbrains.air.contextCompaction
    if let Some(jetbrains) = meta.get("jetbrains").and_then(|v| v.as_object()) {
        if let Some(air) = jetbrains.get("air").and_then(|v| v.as_object()) {
            if let Some(v) = air
                .get("contextCompaction")
                .or_else(|| air.get("context_compaction"))
            {
                return Some(v.clone());
            }
        }
        if let Some(v) = jetbrains
            .get("contextCompaction")
            .or_else(|| jetbrains.get("context_compaction"))
        {
            return Some(v.clone());
        }
    }

    None
}

/// Whether an ACP tool call represents a context compaction operation.
pub fn is_compaction_tool_call(tc: &AcpToolCall) -> bool {
    let title_l = tc.title.to_lowercase();
    if title_l == "compact"
        || title_l.starts_with("compact ")
        || title_l.contains("compact conversation")
        || title_l.contains("context compaction")
    {
        return true;
    }

    let Some(meta) = tc.meta.as_ref() else {
        return false;
    };

    if meta.get("contextCompaction").is_some() || meta.get("context_compaction").is_some() {
        return true;
    }

    if let Some(jetbrains) = meta.get("jetbrains").and_then(|v| v.as_object()) {
        if let Some(air) = jetbrains.get("air").and_then(|v| v.as_object()) {
            if air.get("contextCompaction").is_some() || air.get("context_compaction").is_some() {
                return true;
            }
        }
        if jetbrains.get("contextCompaction").is_some()
            || jetbrains.get("context_compaction").is_some()
        {
            return true;
        }
    }

    let claude_tool_name = meta
        .get("claudeCode")
        .or_else(|| meta.get("claude_code"))
        .and_then(|v| v.get("toolName").or_else(|| v.get("tool_name")))
        .and_then(|v| v.as_str());

    matches!(claude_tool_name, Some(name) if name.eq_ignore_ascii_case("compact"))
}

/// Extract the Claude Code metadata object (`claudeCode` / `claude_code`).
pub fn extract_claude_code(meta: Option<&serde_json::Map<String, Value>>) -> Option<Value> {
    let meta = meta?;
    meta.get("claudeCode")
        .cloned()
        .or_else(|| meta.get("claude_code").cloned())
}

/// Extract a Claude tool name from `claudeCode.toolName` / `claude_code.tool_name`.
pub fn extract_claude_tool_name(meta: Option<&serde_json::Map<String, Value>>) -> Option<String> {
    let obj = extract_claude_code(meta)?;
    obj.get("toolName")
        .or_else(|| obj.get("tool_name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Extract a Claude parent tool use id.
pub fn extract_parent_tool_use_id(meta: Option<&serde_json::Map<String, Value>>) -> Option<String> {
    let obj = extract_claude_code(meta)?;
    obj.get("parentToolUseId")
        .or_else(|| obj.get("parent_tool_use_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Extract Claude `vertex` metadata (`projectId` / `region`).
pub fn extract_claude_vertex(meta: Option<&serde_json::Map<String, Value>>) -> Option<Value> {
    if let Some(obj) = extract_claude_code(meta) {
        if let Some(v) = obj.get("vertex").or_else(|| obj.get("Vertex")) {
            return Some(v.clone());
        }
    }
    let meta = meta?;
    meta.get("claude_vertex")
        .or_else(|| meta.get("claudeVertex"))
        .cloned()
}

/// Extract Claude `options` metadata (additionalDirectories, effort, abortController, ...).
pub fn extract_claude_options(meta: Option<&serde_json::Map<String, Value>>) -> Option<Value> {
    if let Some(obj) = extract_claude_code(meta) {
        if let Some(v) = obj.get("options").or_else(|| obj.get("Options")) {
            return Some(v.clone());
        }
    }
    let meta = meta?;
    meta.get("claude_options")
        .or_else(|| meta.get("claudeOptions"))
        .cloned()
}

/// Extract Claude non-execution kind from tool-result metadata.
pub fn extract_claude_non_execution_kind(
    meta: Option<&serde_json::Map<String, Value>>,
) -> Option<String> {
    if let Some(obj) = extract_claude_code(meta) {
        if let Some(s) = obj
            .get("nonExecutionKind")
            .or_else(|| obj.get("non_execution_kind"))
            .and_then(|v| v.as_str())
        {
            return Some(s.to_string());
        }
    }
    let meta = meta?;
    meta.get("claude_non_execution_kind")
        .or_else(|| meta.get("claudeNonExecutionKind"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Extract Claude prompt-queueing flag.
pub fn extract_claude_prompt_queueing(
    meta: Option<&serde_json::Map<String, Value>>,
) -> Option<bool> {
    if let Some(obj) = extract_claude_code(meta) {
        if let Some(b) = obj
            .get("promptQueueing")
            .or_else(|| obj.get("prompt_queueing"))
            .and_then(|v| v.as_bool())
        {
            return Some(b);
        }
    }
    let meta = meta?;
    meta.get("claude_prompt_queueing")
        .or_else(|| meta.get("claudePromptQueueing"))
        .and_then(|v| v.as_bool())
}

/// Collect Claude terminal-related metadata (`terminal_info` / `terminal_output` /
/// `terminal_exit`) into one object when present.
pub fn extract_terminal_meta(meta: Option<&serde_json::Map<String, Value>>) -> Option<Value> {
    let meta = meta?;
    let mut out = serde_json::Map::new();
    for key in [
        "terminal_info",
        "terminal_output",
        "terminal_output_delta",
        "terminal_exit",
        "terminal-auth",
    ] {
        if let Some(v) = meta.get(key) {
            out.insert(key.to_string(), v.clone());
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Object(out))
    }
}

/// Extract an ask-user-question custom answer (top-level or AIR nested).
pub fn extract_custom_answer(meta: Option<&serde_json::Map<String, Value>>) -> Option<Value> {
    let meta = meta?;

    if let Some(v) = meta.get("_askUserQuestionCustomAnswer") {
        return Some(v.clone());
    }

    if let Some(jetbrains) = meta.get("jetbrains").and_then(|v| v.as_object()) {
        if let Some(air) = jetbrains.get("air").and_then(|v| v.as_object()) {
            if let Some(v) = air
                .get("customAnswer")
                .or_else(|| air.get("_askUserQuestionCustomAnswer"))
                .or_else(|| air.get("custom_answer"))
            {
                return Some(v.clone());
            }
        }
        if let Some(v) = jetbrains
            .get("customAnswer")
            .or_else(|| jetbrains.get("_askUserQuestionCustomAnswer"))
            .or_else(|| jetbrains.get("custom_answer"))
        {
            return Some(v.clone());
        }
    }

    None
}

/// Extract a compaction trigger (`manual` / `automatic` / `idle`) when present.
pub fn extract_compaction_trigger(meta: Option<&serde_json::Map<String, Value>>) -> Option<String> {
    let v = extract_compaction(meta)?;
    v.get("trigger")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

/// Extract compaction pre-token count when present.
pub fn extract_compaction_pre_tokens(meta: Option<&serde_json::Map<String, Value>>) -> Option<u64> {
    let v = extract_compaction(meta)?;
    v.get("preTokens")
        .or_else(|| v.get("pre_tokens"))
        .and_then(|x| x.as_u64())
}

/// Extract compaction post-token count when present.
pub fn extract_compaction_post_tokens(
    meta: Option<&serde_json::Map<String, Value>>,
) -> Option<u64> {
    let v = extract_compaction(meta)?;
    v.get("postTokens")
        .or_else(|| v.get("post_tokens"))
        .and_then(|x| x.as_u64())
}

/// Extract compaction duration in milliseconds when present.
pub fn extract_compaction_duration_ms(
    meta: Option<&serde_json::Map<String, Value>>,
) -> Option<u64> {
    let v = extract_compaction(meta)?;
    v.get("durationMs")
        .or_else(|| v.get("duration_ms"))
        .and_then(|x| x.as_u64())
}

/// Extract compaction error text when present.
pub fn extract_compaction_error(meta: Option<&serde_json::Map<String, Value>>) -> Option<String> {
    let v = extract_compaction(meta)?;
    v.get("error")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

/// Extract the AIR extension object (`jetbrains.air` or top-level `air`).
pub fn extract_air(meta: Option<&serde_json::Map<String, Value>>) -> Option<Value> {
    let meta = meta?;
    meta.get("jetbrains")
        .and_then(|v| v.get("air").cloned())
        .or_else(|| meta.get("air").cloned())
}

/// Extract one field from the AIR extension object by key.
pub fn extract_air_field(
    meta: Option<&serde_json::Map<String, Value>>,
    key: &str,
) -> Option<Value> {
    let air = extract_air(meta)?;
    let obj = air.as_object()?;
    obj.get(key).cloned().or_else(|| {
        if key.contains('_') {
            let mut camel = String::new();
            let mut upper = false;
            for c in key.chars() {
                if c == '_' {
                    upper = true;
                } else if upper {
                    camel.push(c.to_ascii_uppercase());
                    upper = false;
                } else {
                    camel.push(c);
                }
            }
            obj.get(&camel).cloned()
        } else {
            None
        }
    })
}
