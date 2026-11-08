use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: String,
}

fn parse_frontmatter(content: &str) -> Option<(String, String)> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return None;
    }
    let rest = &trimmed[3..];
    let end = rest.find("\n---")?;
    let frontmatter = &rest[..end];
    let mut name = None;
    let mut description = None;
    for line in frontmatter.lines() {
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim();
            let val = v.trim().trim_matches('"').trim_matches('\'').to_string();
            match key {
                "name" => name = Some(val),
                "description" => description = Some(val),
                _ => {}
            }
        }
    }
    Some((name?, description.unwrap_or_default()))
}

fn scan_dir(dir: &Path, source: &str, out: &mut Vec<SkillInfo>) {
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
        if let Some((name, description)) = parse_frontmatter(&content) {
            out.push(SkillInfo {
                name,
                description,
                path: path.to_string_lossy().to_string(),
                source: source.to_string(),
            });
        }
    }
}

fn scan_marketplaces(home: &Path, out: &mut Vec<SkillInfo>) {
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

pub fn list_skills(cwd: Option<&str>) -> Vec<SkillInfo> {
    let mut out = Vec::new();
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"));

    // Claude
    scan_dir(&home.join(".claude").join("skills"), "user", &mut out);
    if let Some(cwd) = cwd {
        scan_dir(&Path::new(cwd).join(".claude").join("skills"), "project", &mut out);
    }

    // Codex
    scan_dir(&home.join(".codex").join("skills"), "user", &mut out);
    // Codex system skills (nested under .system)
    scan_dir(&home.join(".codex").join("skills").join(".system"), "user", &mut out);
    if let Some(cwd) = cwd {
        scan_dir(&Path::new(cwd).join(".codex").join("skills"), "project", &mut out);
    }

    // OpenCode
    scan_dir(&home.join(".config").join("opencode").join("skills"), "user", &mut out);
    if let Some(cwd) = cwd {
        scan_dir(&Path::new(cwd).join(".opencode").join("skills"), "project", &mut out);
    }
    // OpenCode does not define a stable filesystem skills directory.
    // Keep discovery limited to official convention paths above.

    // Claude plugins
    scan_marketplaces(&home, &mut out);

    out
}
