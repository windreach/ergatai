//! MCP 约定配置扫描：Claude 的 `.mcp.json` / `~/.claude.json` 与 Codex 的
//! `config.toml` 中的 `mcp_servers`。
//!
//! 本模块提供只读扫描能力，**当前尚未接入 MCP 注册表 / discovery**，仅建立
//! 能力供后续规划使用。TODO: 与 Ergatai 自有 MCP 注册表合并视图。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConventionMcp {
    pub name: String,
    pub config: Value,
    pub source: String,
    pub path: String,
}

/// 扫描 Claude Code MCP 配置（~/.claude.json 与项目 .mcp.json）。
pub fn scan_claude_mcp(cwd: Option<&str>) -> Vec<ConventionMcp> {
    let mut out = Vec::new();
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"));

    // User-level: ~/.claude.json
    let user_path = home.join(".claude.json");
    if user_path.is_file() {
        if let Ok(raw) = fs::read_to_string(&user_path) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                if let Some(servers) = v.get("mcpServers").and_then(|x| x.as_object()) {
                    for (name, cfg) in servers {
                        out.push(ConventionMcp {
                            name: name.clone(),
                            config: cfg.clone(),
                            source: "user".to_string(),
                            path: user_path.to_string_lossy().to_string(),
                        });
                    }
                }
            }
        }
    }

    // Project-level: <cwd>/.mcp.json
    if let Some(c) = cwd {
        let proj_path = Path::new(c).join(".mcp.json");
        if proj_path.is_file() {
            if let Ok(raw) = fs::read_to_string(&proj_path) {
                if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                    if let Some(servers) = v.get("mcpServers").and_then(|x| x.as_object()) {
                        for (name, cfg) in servers {
                            out.push(ConventionMcp {
                                name: name.clone(),
                                config: cfg.clone(),
                                source: "project".to_string(),
                                path: proj_path.to_string_lossy().to_string(),
                            });
                        }
                    }
                }
            }
        }
    }

    out
}

/// 扫描 Codex MCP 配置（config.toml 的 mcp_servers 表）。
pub fn scan_codex_mcp(cwd: Option<&str>) -> Vec<ConventionMcp> {
    let mut out = Vec::new();
    let codex_home = std::env::var("CODEX_HOME")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var("HOME")
                .map(|h| PathBuf::from(h).join(".codex"))
                .unwrap_or_else(|_| PathBuf::from("/").join(".codex"))
        });

    let mut paths = vec![codex_home.join("config.toml")];
    if let Some(c) = cwd {
        let p = PathBuf::from(c).join(".codex").join("config.toml");
        if p != paths[0] {
            paths.push(p);
        }
    }
    for cfg_path in paths {
        if !cfg_path.is_file() {
            continue;
        }
        let source = if cfg_path.starts_with(&codex_home) {
            "user".to_string()
        } else {
            "project".to_string()
        };
        if let Ok(raw) = fs::read_to_string(&cfg_path) {
            if let Ok(v) = raw.parse::<toml::Value>() {
                if let Some(servers) = v.get("mcp_servers").and_then(|x| x.as_table()) {
                    for (name, cfg) in servers {
                        // Convert toml value to json value best-effort via serde.
                        let json_cfg = serde_json::to_value(cfg).unwrap_or(Value::Null);
                        out.push(ConventionMcp {
                            name: name.clone(),
                            config: json_cfg,
                            source: source.clone(),
                            path: cfg_path.to_string_lossy().to_string(),
                        });
                    }
                }
            }
        }
    }

    out
}

/// 扫描 OpenCode MCP 配置（opencode.json / opencode.jsonc，顶层 `mcp` 字段）。
pub fn scan_opencode_mcp(cwd: Option<&str>) -> Vec<ConventionMcp> {
    let mut out = Vec::new();
    let mut candidates: Vec<(PathBuf, String)> = Vec::new();

    if let Ok(p) = std::env::var("OPENCODE_CONFIG") {
        let t = p.trim();
        if !t.is_empty() {
            candidates.push((PathBuf::from(t), "user".to_string()));
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        let base = PathBuf::from(home).join(".config").join("opencode");
        candidates.push((base.join("opencode.json"), "user".to_string()));
        candidates.push((base.join("opencode.jsonc"), "user".to_string()));
    }

    if let Some(c) = cwd {
        let root = Path::new(c);
        candidates.push((root.join("opencode.json"), "project".to_string()));
        candidates.push((root.join("opencode.jsonc"), "project".to_string()));
        candidates.push((
            root.join(".opencode").join("opencode.json"),
            "project".to_string(),
        ));
        candidates.push((
            root.join(".opencode").join("opencode.jsonc"),
            "project".to_string(),
        ));
    }

    let mut seen_paths = std::collections::HashSet::new();
    for (cfg_path, source) in candidates {
        let key = cfg_path.to_string_lossy().to_string();
        if !seen_paths.insert(key.clone()) {
            continue;
        }
        if !cfg_path.is_file() {
            continue;
        }
        let raw = match fs::read_to_string(&cfg_path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let stripped = crate::services::model_file_reader::strip_json_comments(&raw);
        let v: Value = match serde_json::from_str(&stripped) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(servers) = v.get("mcp").and_then(|x| x.as_object()) {
            for (name, cfg) in servers {
                out.push(ConventionMcp {
                    name: name.clone(),
                    config: cfg.clone(),
                    source: source.clone(),
                    path: key.clone(),
                });
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn scan_claude_mcp_reads_user_file() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        fs::write(
            home.join(".claude.json"),
            r#"{ "mcpServers": { "foo": { "command": "echo" } } }"#,
        )
        .unwrap();
        // Override HOME
        let prev = std::env::var("HOME").ok();
        std::env::set_var("HOME", home);
        let res = scan_claude_mcp(None);
        if let Some(p) = prev {
            std::env::set_var("HOME", p);
        }
        assert!(res.iter().any(|m| m.name == "foo"));
    }

    #[test]
    fn scan_codex_mcp_reads_config() {
        let tmp = TempDir::new().unwrap();
        let codex_dir = tmp.path().join(".codex");
        fs::create_dir_all(&codex_dir).unwrap();
        fs::write(
            codex_dir.join("config.toml"),
            "[mcp_servers.bar]\ncommand = \"echo\"\n",
        )
        .unwrap();
        std::env::set_var("CODEX_HOME", codex_dir.to_str().unwrap());
        let res = scan_codex_mcp(None);
        std::env::remove_var("CODEX_HOME");
        assert!(res.iter().any(|m| m.name == "bar"));
    }
}
