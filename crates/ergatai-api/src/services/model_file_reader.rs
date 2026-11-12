//! Direct file-based model enumeration for agent profiles.
//!
//! Replaces the slow SDK subprocess path (which effectively started an agent
//! process) with synchronous reads of the agent's own config files. Returns
//! `Vec<ProfileModelDetail>` so callers can persist it like the SDK result.
//!
//! SDK-based enumeration is retained as an opt-in enhancement
//! (`ERGATAI_MODEL_USE_SDK=1`) for users who need server-side model lists.

use crate::services::profile_service::ProfileModelDetail;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

/// Dispatch by agent kind.
pub fn read_models(agent_kind: &str, cwd: Option<&str>) -> Vec<ProfileModelDetail> {
    match agent_kind {
        "claude" => read_claude_models(),
        "opencode" => read_opencode_models(cwd),
        "codex" => read_codex_models(),
        _ => Vec::new(),
    }
}

// ── Claude ──────────────────────────────────────────────────────────────

pub fn read_claude_models() -> Vec<ProfileModelDetail> {
    // Base catalog mirrors frontend CLAUDE_MODELS so the selector is never
    // empty even when settings.json has no overrides.
    let mut models: Vec<ProfileModelDetail> = vec![
        ProfileModelDetail {
            id: "opus".to_string(),
            name: "Opus".to_string(),
            description: String::new(),
            provider: "Anthropic".to_string(),
        },
        ProfileModelDetail {
            id: "sonnet".to_string(),
            name: "Sonnet".to_string(),
            description: String::new(),
            provider: "Anthropic".to_string(),
        },
        ProfileModelDetail {
            id: "haiku".to_string(),
            name: "Haiku".to_string(),
            description: String::new(),
            provider: "Anthropic".to_string(),
        },
    ];

    let settings_path = match dirs::home_dir() {
        Some(h) => h.join(".claude").join("settings.json"),
        None => return models,
    };
    let content = match fs::read_to_string(&settings_path) {
        Ok(c) => c,
        Err(_) => return models,
    };
    let cfg: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return models,
    };

    let env = cfg.get("env").and_then(|v| v.as_object());

    // Configured slot overrides.
    let slots = [
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", "opus"),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", "sonnet"),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", "haiku"),
    ];
    for (env_key, slot) in slots {
        let val = env
            .and_then(|e| e.get(env_key))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                cfg.get(env_key)
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            });
        if let Some(m) = val {
            if !m.is_empty() && !models.iter().any(|x| x.id == m) {
                models.push(ProfileModelDetail {
                    id: m.clone(),
                    name: m.clone(),
                    description: format!("Configured {}", slot),
                    provider: "Configured".to_string(),
                });
            }
        }
    }

    // Default model.
    let default_model = cfg
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            env.and_then(|e| e.get("ANTHROPIC_MODEL"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });

    if let Some(dm) = default_model {
        if !dm.is_empty() {
            if let Some(idx) = models.iter().position(|x| x.id == dm) {
                if idx != 0 {
                    let it = models.remove(idx);
                    models.insert(0, it);
                }
            } else {
                models.insert(
                    0,
                    ProfileModelDetail {
                        id: dm.clone(),
                        name: dm.clone(),
                        description: "Configured model".to_string(),
                        provider: "Configured".to_string(),
                    },
                );
            }
        }
    }

    models
}

// ── OpenCode ────────────────────────────────────────────────────────────

pub fn read_opencode_models(cwd: Option<&str>) -> Vec<ProfileModelDetail> {
    let mut models: Vec<ProfileModelDetail> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("OPENCODE_CONFIG") {
        if !p.trim().is_empty() {
            candidates.push(PathBuf::from(p));
        }
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".config").join("opencode").join("opencode.json"));
        candidates.push(home.join(".config").join("opencode").join("opencode.jsonc"));
    }
    // cwd-local config as a last resort.
    if let Some(c) = cwd {
        candidates.push(PathBuf::from(c).join("opencode.json"));
    }

    let mut loaded = false;
    for cp in candidates {
        let content = match fs::read_to_string(&cp) {
            Ok(c) => c,
            Err(_) => continue,
        };
        // strip comments
        let stripped = strip_json_comments(&content);
        let cfg: Value = match serde_json::from_str(&stripped) {
            Ok(v) => v,
            Err(_) => continue,
        };
        loaded = true;

        let providers = cfg
            .get("provider")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        for (pname, pval) in providers.iter() {
            let pname_str = pval
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(pname)
                .to_string();
            if let Some(mobj) = pval.get("models").and_then(|v| v.as_object()) {
                for mkey in mobj.keys() {
                    if seen.contains(mkey) {
                        continue;
                    }
                    seen.insert(mkey.clone());
                    models.push(ProfileModelDetail {
                        id: mkey.clone(),
                        name: mkey.clone(),
                        description: String::new(),
                        provider: pname_str.clone(),
                    });
                }
            }
        }

        // default model
        let dm = cfg
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if let Some(dm) = dm {
            if !dm.is_empty() {
                let id = if dm.contains('/') {
                    dm.split('/').next_back().unwrap_or(&dm).to_string()
                } else {
                    dm.clone()
                };
                if !seen.contains(&id) {
                    models.insert(
                        0,
                        ProfileModelDetail {
                            id: id.clone(),
                            name: id.clone(),
                            description: "Configured model".to_string(),
                            provider: "Configured".to_string(),
                        },
                    );
                    seen.insert(id);
                } else {
                    if let Some(idx) = models.iter().position(|m| m.id == id) {
                        if idx != 0 {
                            let it = models.remove(idx);
                            models.insert(0, it);
                        }
                    }
                }
            }
        }

        if !models.is_empty() {
            break;
        }
    }

    if !loaded && models.is_empty() {
        // nothing found; leave empty so caller can fall back
    }
    models
}

fn strip_json_comments(s: &str) -> String {
    // Remove // line comments and /* */ block comments (naive, matches JS).
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    let n = bytes.len();
    while i < n {
        if i + 1 < n && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            while i < n && bytes[i] != b'\n' {
                i += 1;
            }
        } else if i + 1 < n && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < n && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(n);
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

// ── Codex ───────────────────────────────────────────────────────────────

pub fn read_codex_models() -> Vec<ProfileModelDetail> {
    use std::collections::HashSet;
    let mut models: Vec<ProfileModelDetail> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let add = |models: &mut Vec<ProfileModelDetail>,
               seen: &mut HashSet<String>,
               id: String,
               name: String,
               description: String,
               provider: String| {
        if id.is_empty() || seen.contains(&id) {
            return;
        }
        seen.insert(id.clone());
        models.push(ProfileModelDetail {
            id,
            name,
            description,
            provider,
        });
    };

    let codex_home = std::env::var("CODEX_HOME")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".codex"));

    // Parse config.toml
    let mut top_model: Option<String> = None;
    let mut top_provider = "Codex".to_string();
    let mut catalog_path: Option<PathBuf> = None;
    let mut profile_models: Vec<(String, String)> = Vec::new();

    if let Ok(content) = fs::read_to_string(codex_home.join("config.toml")) {
        let mut current: Option<String> = None;
        for raw in content.lines() {
            let t = raw.trim();
            if t.is_empty() || t.starts_with('#') {
                continue;
            }
            // section header
            if t.starts_with('[') && t.ends_with(']') {
                current = Some(t[1..t.len() - 1].trim().to_string());
                continue;
            }
            let eq = match t.find('=') {
                Some(i) => i,
                None => continue,
            };
            let key = t[..eq].trim();
            let mut val = t[eq + 1..].trim();
            // strip inline comment
            if let Some(h) = val.find('#') {
                val = val[..h].trim();
            }
            let val = val.trim_matches(|c| c == '"' || c == '\'');
            if val.is_empty() {
                continue;
            }
            match &current {
                None => {
                    if key == "model" {
                        top_model = Some(val.to_string());
                    } else if key == "model_provider" {
                        top_provider = val.to_string();
                    } else if key == "model_catalog_json" {
                        catalog_path = Some(PathBuf::from(val));
                    }
                }
                Some(sec) if sec.starts_with("profiles.") && key == "model" => {
                    profile_models.push((sec["profiles.".len()..].to_string(), val.to_string()));
                }
                _ => {}
            }
        }
    }

    let cp = catalog_path.unwrap_or_else(|| codex_home.join("config.models.json"));
    if let Ok(content) = fs::read_to_string(&cp) {
        if let Ok(cat) = serde_json::from_str::<Value>(&content) {
            if let Some(arr) = cat.get("models").and_then(|v| v.as_array()) {
                for m in arr {
                    let id = m
                        .get("slug")
                        .or_else(|| m.get("id"))
                        .or_else(|| m.get("model"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if id.is_empty() {
                        continue;
                    }
                    let name = m
                        .get("display_name")
                        .or_else(|| m.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    let desc = m
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    add(&mut models, &mut seen, id, name, desc, top_provider.clone());
                }
            }
        }
    }

    if let Some(tm) = &top_model {
        add(
            &mut models,
            &mut seen,
            tm.clone(),
            tm.clone(),
            "Configured model".to_string(),
            top_provider.clone(),
        );
    }
    for (prof, model) in &profile_models {
        add(
            &mut models,
            &mut seen,
            model.clone(),
            model.clone(),
            format!("Configured via profile '{}'", prof),
            top_provider.clone(),
        );
    }

    // move top model to front
    if let Some(tm) = &top_model {
        if let Some(idx) = models.iter().position(|m| m.id == *tm) {
            if idx != 0 {
                let it = models.remove(idx);
                models.insert(0, it);
            }
        }
    }

    models
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_claude_returns_base_catalog() {
        // Without a settings file (or with one present), at least 3 base models.
        let m = read_claude_models();
        assert!(m.len() >= 3);
        assert!(m.iter().any(|x| x.id == "opus"));
    }

    #[test]
    fn strip_comments_works() {
        let s = r#"{ "a": 1 // x
        /* block */ "b": 2 }"#;
        let out = strip_json_comments(s);
        assert!(!out.contains("x"));
        assert!(!out.contains("block"));
    }
}
