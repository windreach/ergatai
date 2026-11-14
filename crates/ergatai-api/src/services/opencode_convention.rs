//! OpenCode 约定文件扫描：agents/*.md 与 commands/*.md
//!
//! OpenCode 会读取以下约定文件（参见官方文档）：
//!   - `.opencode/agents/*.md` / `~/.config/opencode/agents/*.md`
//!   - `.opencode/commands/*.md` / `~/.config/opencode/commands/*.md`
//!
//! 本模块提供只读扫描能力，**当前尚未接入 discovery 端点**（命令/代理仍由
//! ACP `availableCommands` 与 Agent SDK 提供）。保留为未来规划的兜底数据源，
//! 调用方需自行决定何时启用。TODO: 接入 `/api/v1/agents/:id/discovery` 的
//! convention_agents / convention_commands 分支。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct ConventionAgent {
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConventionCommand {
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: String,
}

fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (None, None);
    }
    let rest = &trimmed[3..];
    let end = match rest.find("\n---") {
        Some(i) => i,
        None => return (None, None),
    };
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
    (name, description)
}

fn scan_md_dir(
    dir: &Path,
    source: &str,
    out_agents: &mut Vec<ConventionAgent>,
    out_commands: &mut Vec<ConventionCommand>,
    is_command: bool,
) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let (fm_name, fm_desc) = parse_frontmatter(&content);
        let fallback = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let name = fm_name.unwrap_or(fallback);
        if name.is_empty() {
            continue;
        }
        let description = fm_desc.unwrap_or_default();
        if is_command {
            out_commands.push(ConventionCommand {
                name,
                description,
                path: path.to_string_lossy().to_string(),
                source: source.to_string(),
            });
        } else {
            out_agents.push(ConventionAgent {
                name,
                description,
                path: path.to_string_lossy().to_string(),
                source: source.to_string(),
            });
        }
    }
}

/// 扫描 OpenCode 约定 agents（当前未接入 discovery，仅建立能力）。
pub fn scan_opencode_agents(cwd: Option<&str>) -> Vec<ConventionAgent> {
    let mut out = Vec::new();
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"));
    let mut dummy_cmds: Vec<ConventionCommand> = Vec::new();
    scan_md_dir(
        &home.join(".config").join("opencode").join("agents"),
        "user",
        &mut out,
        &mut dummy_cmds,
        false,
    );
    if let Some(cwd) = cwd {
        scan_md_dir(
            &Path::new(cwd).join(".opencode").join("agents"),
            "project",
            &mut out,
            &mut dummy_cmds,
            false,
        );
    }
    let _ = dummy_cmds;
    out
}

/// 扫描 OpenCode 约定 commands（当前未接入 discovery，仅建立能力）。
pub fn scan_opencode_commands(cwd: Option<&str>) -> Vec<ConventionCommand> {
    let mut out = Vec::new();
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"));
    let mut dummy_agents: Vec<ConventionAgent> = Vec::new();
    scan_md_dir(
        &home.join(".config").join("opencode").join("commands"),
        "user",
        &mut dummy_agents,
        &mut out,
        true,
    );
    if let Some(cwd) = cwd {
        scan_md_dir(
            &Path::new(cwd).join(".opencode").join("commands"),
            "project",
            &mut dummy_agents,
            &mut out,
            true,
        );
    }
    let _ = dummy_agents;
    out
}

/// 扫描 Claude Code 约定 agents（.claude/agents/*.md），当前未接入 discovery。
pub fn scan_claude_agents(cwd: Option<&str>) -> Vec<ConventionAgent> {
    let mut out = Vec::new();
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"));
    let mut dummy_cmds: Vec<ConventionCommand> = Vec::new();
    scan_md_dir(
        &home.join(".claude").join("agents"),
        "user",
        &mut out,
        &mut dummy_cmds,
        false,
    );
    if let Some(cwd) = cwd {
        scan_md_dir(
            &Path::new(cwd).join(".claude").join("agents"),
            "project",
            &mut out,
            &mut dummy_cmds,
            false,
        );
    }
    let _ = dummy_cmds;
    out
}

/// 扫描 Claude Code 约定 commands（.claude/commands/*.md），当前未接入 discovery。
pub fn scan_claude_commands(cwd: Option<&str>) -> Vec<ConventionCommand> {
    let mut out = Vec::new();
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"));
    let mut dummy_agents: Vec<ConventionAgent> = Vec::new();
    scan_md_dir(
        &home.join(".claude").join("commands"),
        "user",
        &mut dummy_agents,
        &mut out,
        true,
    );
    if let Some(cwd) = cwd {
        scan_md_dir(
            &Path::new(cwd).join(".claude").join("commands"),
            "project",
            &mut dummy_agents,
            &mut out,
            true,
        );
    }
    let _ = dummy_agents;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn scan_agents_reads_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join(".opencode").join("agents");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("helper.md"),
            "---\nname: helper\ndescription: helps\n---\n# body",
        )
        .unwrap();

        let res = scan_opencode_agents(Some(tmp.path().to_str().unwrap()));
        assert!(res.iter().any(|a| a.name == "helper"));
    }

    #[test]
    fn scan_commands_fallback_name() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join(".opencode").join("commands");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("deploy.md"), "# deploy command").unwrap();

        let res = scan_opencode_commands(Some(tmp.path().to_str().unwrap()));
        assert!(res.iter().any(|c| c.name == "deploy"));
    }
}
