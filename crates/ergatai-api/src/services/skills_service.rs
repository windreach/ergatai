use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_invocable: Option<bool>,
    #[serde(default)]
    pub user_invocation_only: bool,
}

fn parse_frontmatter(content: &str) -> Option<(String, String, bool, Option<bool>)> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return None;
    }
    let rest = &trimmed[3..];
    let end = rest.find("\n---")?;
    let frontmatter = &rest[..end];
    let mut name = None;
    let mut description = None;
    let mut user_invocation_only = false;
    let mut user_invocable = None;
    for line in frontmatter.lines() {
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim();
            let raw = v.trim();
            let val = raw.trim_matches('"').trim_matches('\'').to_string();
            match key {
                "name" => name = Some(val),
                "description" => description = Some(val),
                "disable-model-invocation" => {
                    if matches!(
                        raw.to_ascii_lowercase().as_str(),
                        "true" | "yes" | "on" | "1"
                    ) {
                        user_invocation_only = true;
                    }
                }
                "user-invocable" => {
                    let b = match raw.to_ascii_lowercase().as_str() {
                        "true" | "yes" | "on" | "1" => Some(true),
                        "false" | "no" | "off" | "0" => Some(false),
                        _ => None,
                    };
                    if b.is_some() {
                        user_invocable = b;
                    }
                }
                _ => {}
            }
        }
    }
    Some((
        name?,
        description.unwrap_or_default(),
        user_invocation_only,
        user_invocable,
    ))
}

pub fn scan_dir(dir: &Path, source: &str, out: &mut Vec<SkillInfo>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_file = path.join("SKILL.md");
        if !skill_file.exists() {
            continue;
        }
        let content = match fs::read_to_string(&skill_file) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if let Some((name, description, user_invocation_only, user_invocable)) =
            parse_frontmatter(&content)
        {
            out.push(SkillInfo {
                name,
                description,
                path: path.to_string_lossy().to_string(),
                source: source.to_string(),
                enabled: true,
                user_invocable,
                user_invocation_only,
            });
        }
    }
}

pub fn scan_marketplaces(home: &Path, out: &mut Vec<SkillInfo>) {
    let marketplaces = home.join(".claude").join("plugins").join("marketplaces");
    let entries = match fs::read_dir(&marketplaces) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_dir(&path.join("skills"), "plugin", out);
        }
    }
}

pub fn list_skills(cwd: Option<&str>, agent_kind: Option<&str>) -> Vec<SkillInfo> {
    let mut out = Vec::new();
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"));

    // When agent_kind is None (or unknown), keep the legacy behaviour: scan all.
    let scan_claude = agent_kind.map(|k| k == "claude").unwrap_or(true);
    let scan_codex = agent_kind.map(|k| k == "codex").unwrap_or(true);
    let scan_opencode = agent_kind.map(|k| k == "opencode").unwrap_or(true);

    // Claude
    if scan_claude {
        scan_dir(&home.join(".claude").join("skills"), "user", &mut out);
        if let Some(cwd) = cwd {
            scan_dir(
                &Path::new(cwd).join(".claude").join("skills"),
                "project",
                &mut out,
            );
        }
        // Claude plugins / marketplaces
        scan_marketplaces(&home, &mut out);
    }

    // Codex
    if scan_codex {
        scan_dir(&home.join(".codex").join("skills"), "user", &mut out);
        // Codex system skills (nested under .system)
        scan_dir(
            &home.join(".codex").join("skills").join(".system"),
            "user",
            &mut out,
        );
        if let Some(cwd) = cwd {
            scan_dir(
                &Path::new(cwd).join(".codex").join("skills"),
                "project",
                &mut out,
            );
        }
    }

    // OpenCode
    // OpenCode reads skills from its own directories plus Claude-compatible
    // and agent-ecosystem-compatible locations (see official docs).
    if scan_opencode {
        // User-level (global) skill directories.
        scan_dir(
            &home.join(".config").join("opencode").join("skills"),
            "user",
            &mut out,
        );
        scan_dir(&home.join(".claude").join("skills"), "user", &mut out);
        scan_dir(&home.join(".agents").join("skills"), "user", &mut out);
        // Project-level skill directories.
        if let Some(cwd) = cwd {
            scan_dir(
                &Path::new(cwd).join(".opencode").join("skills"),
                "project",
                &mut out,
            );
            scan_dir(
                &Path::new(cwd).join(".claude").join("skills"),
                "project",
                &mut out,
            );
            scan_dir(
                &Path::new(cwd).join(".agents").join("skills"),
                "project",
                &mut out,
            );
        }
    }

    out
}

#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
struct SkillOverride {
    enabled: bool,
    user_invocation_only: bool,
}

#[derive(Debug, Default, serde::Deserialize)]
struct PluginManifest {
    name: Option<String>,
    skills: Option<SkillField>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
enum SkillField {
    One(String),
    Many(Vec<String>),
}

fn parse_skill_override(value: &str) -> Option<SkillOverride> {
    match value.trim() {
        "off" => Some(SkillOverride {
            enabled: false,
            user_invocation_only: false,
        }),
        "user-invocable-only" => Some(SkillOverride {
            enabled: true,
            user_invocation_only: true,
        }),
        "on" | "name-only" => Some(SkillOverride {
            enabled: true,
            user_invocation_only: false,
        }),
        _ => None,
    }
}

fn resolve_config_dir(home: &Path, cwd: Option<&Path>) -> PathBuf {
    if let Ok(v) = std::env::var("CLAUDE_CONFIG_DIR") {
        let v = v.trim();
        if !v.is_empty() {
            if let Some(c) = cwd {
                return c.join(v);
            }
            return PathBuf::from(v);
        }
    }
    home.join(".claude")
}

fn read_claude_settings(
    config_dir: &Path,
    cwd: Option<&Path>,
) -> (HashMap<String, bool>, HashMap<String, SkillOverride>, bool) {
    let mut paths = vec![config_dir.join("settings.json")];
    if let Some(c) = cwd {
        paths.push(c.join(".claude").join("settings.json"));
        paths.push(c.join(".claude").join("settings.local.json"));
    }

    let mut enabled_plugins = HashMap::new();
    let mut skill_overrides = HashMap::new();
    let mut synced_hidden = false;

    for settings_path in paths {
        let raw = match fs::read_to_string(&settings_path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let v: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(overrides) = v.get("skillOverrides").and_then(|x| x.as_object()) {
            for (name, value) in overrides {
                if let Some(s) = value.as_str() {
                    if let Some(ov) = parse_skill_override(s) {
                        skill_overrides.insert(name.clone(), ov);
                    }
                }
            }
        }

        if let Some(plugins) = v.get("enabledPlugins").and_then(|x| x.as_object()) {
            for (key, value) in plugins {
                match value {
                    Value::Bool(b) => {
                        enabled_plugins.insert(key.clone(), *b);
                    }
                    _ => {
                        enabled_plugins.remove(key);
                    }
                }
            }
        }

        if v.get("syncClaudeAiPlugins") == Some(&Value::Bool(false)) {
            synced_hidden = true;
        }
    }

    (enabled_plugins, skill_overrides, synced_hidden)
}

fn parse_skill_meta(content: &str) -> (Option<String>, Option<String>, bool, Option<bool>) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (None, None, false, None);
    }
    let rest = &trimmed[3..];
    let Some(end) = rest.find("\n---") else {
        return (None, None, false, None);
    };
    let frontmatter = &rest[..end];

    let mut name = None;
    let mut description = None;
    let mut user_invocation_only = false;
    let mut user_invocable = None;

    for line in frontmatter.lines() {
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim();
            let raw = v.trim();
            let val = raw.trim_matches('"').trim_matches('\'').to_string();
            match key {
                "name" if !val.is_empty() => name = Some(val),
                "description" => description = Some(val),
                "disable-model-invocation" => {
                    if matches!(
                        raw.to_ascii_lowercase().as_str(),
                        "true" | "yes" | "on" | "1"
                    ) {
                        user_invocation_only = true;
                    }
                }
                "user-invocable" => {
                    let b = match raw.to_ascii_lowercase().as_str() {
                        "true" | "yes" | "on" | "1" => Some(true),
                        "false" | "no" | "off" | "0" => Some(false),
                        _ => None,
                    };
                    if b.is_some() {
                        user_invocable = b;
                    }
                }
                _ => {}
            }
        }
    }

    (name, description, user_invocation_only, user_invocable)
}

fn scan_plugin_skill_root(
    root: &Path,
    scope: &str,
    prefix: &str,
    single: bool,
    out: &mut Vec<SkillInfo>,
) {
    let entries: Vec<String> = if single {
        vec![root
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()]
    } else {
        match fs::read_dir(root) {
            Ok(rd) => rd
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect(),
            Err(_) => return,
        }
    };

    for entry in entries {
        let skill_path = if single {
            root.join("SKILL.md")
        } else {
            root.join(&entry).join("SKILL.md")
        };
        if !skill_path.is_file() {
            continue;
        }
        let content = match fs::read_to_string(&skill_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let (fm_name, fm_description, fm_user_invocation_only, fm_user_invocable) =
            parse_skill_meta(&content);

        let dir_name = if single {
            root.file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            entry.trim().to_string()
        };
        if dir_name.is_empty() {
            continue;
        }

        let declared_name = if single { fm_name } else { None };
        let unprefixed = declared_name
            .as_deref()
            .and_then(|n| n.strip_prefix(&format!("{}:", prefix)))
            .map(str::to_string)
            .or(declared_name);
        let base = unprefixed.unwrap_or_else(|| dir_name.clone());
        let sanitized: String = base
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        let name = format!("{}:{}", prefix, sanitized);

        out.push(SkillInfo {
            name,
            description: fm_description.filter(|s| !s.is_empty()).unwrap_or_default(),
            path: skill_path.to_string_lossy().to_string(),
            source: "plugin".to_string(),
            enabled: true,
            user_invocable: fm_user_invocable,
            user_invocation_only: fm_user_invocation_only,
        });
    }
    let _ = scope;
}

pub fn scan_claude_plugin_skills(home: &Path, cwd: Option<&str>, out: &mut Vec<SkillInfo>) {
    let cwd_path = cwd.map(PathBuf::from);
    let config_dir = resolve_config_dir(home, cwd_path.as_deref());
    let (enabled_plugins, _skill_overrides, _synced_hidden) =
        read_claude_settings(&config_dir, cwd_path.as_deref());

    let plugins_dir = if let Ok(v) = std::env::var("CLAUDE_CODE_PLUGIN_CACHE_DIR") {
        let v = v.trim();
        if v.is_empty() {
            config_dir.join("plugins")
        } else {
            PathBuf::from(v)
        }
    } else {
        config_dir.join("plugins")
    };

    let installed_path = plugins_dir.join("installed_plugins.json");
    if let Ok(raw) = fs::read_to_string(&installed_path) {
        if let Ok(installed) = serde_json::from_str::<Value>(&raw) {
            if let Some(plugins) = installed.get("plugins").and_then(|x| x.as_object()) {
                let mut keys: Vec<String> = plugins.keys().cloned().collect();
                keys.sort();

                for key in keys {
                    if enabled_plugins.get(&key) != Some(&true) {
                        continue;
                    }

                    let entries = plugins
                        .get(&key)
                        .and_then(|x| x.as_array())
                        .cloned()
                        .unwrap_or_default();

                    let mut applicable = Vec::new();
                    for entry in &entries {
                        let scope = entry.get("scope").and_then(|x| x.as_str()).unwrap_or("");
                        let project_path = entry.get("projectPath").and_then(|x| x.as_str());
                        let ok = match scope {
                            "user" | "managed" => true,
                            _ => {
                                if let (Some(pp), Some(cw)) = (project_path, cwd_path.as_ref()) {
                                    let pp =
                                        fs::canonicalize(pp).unwrap_or_else(|_| PathBuf::from(pp));
                                    let cw = fs::canonicalize(cw).unwrap_or_else(|_| cw.clone());
                                    pp == cw
                                } else {
                                    false
                                }
                            }
                        };
                        if ok {
                            applicable.push(entry);
                        }
                    }

                    let install = applicable
                        .iter()
                        .find(|entry| {
                            let ip = entry
                                .get("installPath")
                                .and_then(|x| x.as_str())
                                .unwrap_or("");
                            let p = PathBuf::from(ip);
                            let p = if p.is_absolute() {
                                p
                            } else {
                                cwd_path
                                    .clone()
                                    .unwrap_or_else(|| PathBuf::from("."))
                                    .join(p)
                            };
                            p.exists()
                        })
                        .copied()
                        .or_else(|| applicable.first().copied());

                    let Some(install) = install else {
                        continue;
                    };

                    let scope = match install.get("scope").and_then(|x| x.as_str()).unwrap_or("") {
                        "user" | "managed" => "user",
                        _ => "project",
                    };

                    let install_path_raw = install
                        .get("installPath")
                        .and_then(|x| x.as_str())
                        .unwrap_or("");
                    let install_path = {
                        let p = PathBuf::from(install_path_raw);
                        if p.is_absolute() {
                            p
                        } else {
                            cwd_path
                                .clone()
                                .unwrap_or_else(|| PathBuf::from("."))
                                .join(p)
                        }
                    };
                    if !install_path.exists() {
                        continue;
                    }

                    let manifest_path = install_path.join(".claude-plugin").join("plugin.json");
                    let manifest: Option<PluginManifest> = fs::read_to_string(&manifest_path)
                        .ok()
                        .and_then(|raw| serde_json::from_str(&raw).ok());

                    let prefix = manifest
                        .as_ref()
                        .and_then(|m| m.name.clone())
                        .unwrap_or_else(|| key.split('@').next().unwrap_or(&key).to_string());

                    let mut roots = Vec::new();
                    let default_dir = install_path.join("skills");
                    if default_dir.is_dir() {
                        roots.push(default_dir);
                    }

                    let declared = manifest.as_ref().and_then(|m| m.skills.as_ref());
                    if declared.is_none()
                        && !install_path.join("skills").is_dir()
                        && install_path.join("SKILL.md").is_file()
                    {
                        roots.push(install_path.clone());
                    }

                    let declared_list = match declared {
                        Some(SkillField::One(s)) => vec![s.clone()],
                        Some(SkillField::Many(v)) => v.clone(),
                        None => vec![],
                    };
                    for rel in declared_list {
                        let dir = install_path.join(&rel);
                        if dir.starts_with(&install_path) && dir.is_dir() {
                            roots.push(dir);
                        }
                    }

                    for root in roots {
                        let single =
                            root.join("SKILL.md").is_file() && root != install_path.join("skills");
                        scan_plugin_skill_root(&root, scope, &prefix, single, out);
                    }
                }
            }
        }
    }

    scan_marketplaces(home, out);
}

pub fn apply_claude_skill_overrides(home: &Path, cwd: Option<&str>, out: &mut [SkillInfo]) {
    let cwd_path = cwd.map(PathBuf::from);
    let config_dir = resolve_config_dir(home, cwd_path.as_deref());
    let (_enabled_plugins, overrides, _synced_hidden) =
        read_claude_settings(&config_dir, cwd_path.as_deref());

    for skill in out.iter_mut() {
        // Plugin skills are namespaced as `plugin:skill`; overrides only target
        // top-level Claude skills.
        if skill.name.contains(':') {
            continue;
        }
        if let Some(ov) = overrides.get(&skill.name) {
            skill.enabled = ov.enabled;
            if ov.user_invocation_only {
                skill.user_invocation_only = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_parse_frontmatter_valid() {
        let content = "---\nname: my-skill\ndescription: does things\n---\n# body";
        let (name, desc, _, _) = parse_frontmatter(content).unwrap();
        assert_eq!(name, "my-skill");
        assert_eq!(desc, "does things");
    }

    #[test]
    fn test_parse_frontmatter_missing_name() {
        let content = "---\ndescription: x\n---\n";
        assert!(parse_frontmatter(content).is_none());
    }

    #[test]
    fn test_parse_frontmatter_no_frontmatter() {
        assert!(parse_frontmatter("# hello").is_none());
    }

    #[test]
    fn test_list_skills_with_temp_home() {
        let tmp = TempDir::new().unwrap();
        let skill_dir = tmp.path().join(".claude").join("skills").join("s1");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: s1\ndescription: d1\n---\n",
        )
        .unwrap();

        // Point HOME at temp dir
        let prev = std::env::var("HOME").ok();
        std::env::set_var("HOME", tmp.path());
        let skills = list_skills(None, None);
        if let Some(p) = prev {
            std::env::set_var("HOME", p);
        }

        assert!(skills.iter().any(|s| s.name == "s1"));
    }
}
