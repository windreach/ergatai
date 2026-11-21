use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Mutex as AsyncMutex;

/// Cache entry with creation timestamp.
struct CacheEntry {
    value: Value,
    created_at: Instant,
}

/// In-memory cache for discovery sources.
///
/// Each *source* (not component) is cached independently with its own TTL.
/// Sources are the raw data providers; final components (skills/commands/mcp/plugins)
/// are assembled by merging sources at query time.
///
/// Sources:
///   - `convention_skills` — filesystem scan of `.claude/skills`, `.codex/skills`, etc.
///   - `sdk_bundle`        — Node subprocess returning `{skills, commands, mcp}`
///   - `acp_commands`      — ACP `availableCommands` for the running agent
///   - `plugins`           — Claude marketplace directory scan
struct DiscoveryCache {
    results: HashMap<String, CacheEntry>,
    /// In-flight fetches for concurrent request deduplication.
    /// Key is source-level (same as `results` key).
    in_flight: HashMap<String, Arc<AsyncMutex<Option<Value>>>>,
}

static CACHE: Mutex<Option<DiscoveryCache>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// Per-source TTLs.
//
// Match the design in docs/agent-auxiliary-discovery-plan.md §持久化与缓存策略.
// SDK bundle is bounded by its least-fresh component (MCP status → 30s).
// ---------------------------------------------------------------------------
const CONVENTION_SKILLS_TTL: Duration = Duration::from_secs(300); // 5 minutes
const ACP_COMMANDS_TTL: Duration = Duration::from_secs(60); // 1 minute
const SDK_BUNDLE_TTL: Duration = Duration::from_secs(30); // 30 seconds
const PLUGINS_TTL: Duration = Duration::from_secs(3600); // 1 hour

/// Stale data is served up to 2× TTL; beyond that it's treated as a miss.
const REVALIDATE_WINDOW_FACTOR: u32 = 2;

/// Source identifiers used as cache key suffix.
const SRC_CONVENTION_SKILLS: &str = "convention_skills";
const SRC_SDK_BUNDLE: &str = "sdk_bundle";
const SRC_ACP_COMMANDS: &str = "acp_commands";
const SRC_PLUGINS: &str = "plugins";

fn source_ttl(source: &str) -> Duration {
    match source {
        SRC_CONVENTION_SKILLS => CONVENTION_SKILLS_TTL,
        SRC_SDK_BUNDLE => SDK_BUNDLE_TTL,
        SRC_ACP_COMMANDS => ACP_COMMANDS_TTL,
        SRC_PLUGINS => PLUGINS_TTL,
        _ => SDK_BUNDLE_TTL,
    }
}

// ---------------------------------------------------------------------------
// Cache primitives
// ---------------------------------------------------------------------------

enum CacheStatus {
    Fresh(Value),
    /// Still usable but past TTL — serve now, revalidate in background.
    Stale(Value),
    Miss,
}

/// Static sources that only depend on filesystem and can be shared across agents.
const STATIC_SOURCES: &[&str] = &[SRC_CONVENTION_SKILLS, SRC_PLUGINS];

fn is_static_source(source: &str) -> bool {
    STATIC_SOURCES.contains(&source)
}

/// Cache key generation:
/// - Static sources (convention_skills, plugins): `{source}::{cwd}` — shared across agents.
/// - Runtime sources (sdk_bundle, acp_commands): `{source}::{agent_id}::{cwd}` — per-agent.
fn cache_key(source: &str, agent_id: &str, cwd: Option<&str>, agent_kind: Option<&str>) -> String {
    let cwd_str = cwd.unwrap_or("");
    if is_static_source(source) {
        match agent_kind {
            Some(k) if !k.is_empty() => format!("{}::{}::{}", source, k, cwd_str),
            _ => format!("{}::{}", source, cwd_str),
        }
    } else {
        format!("{}::{}::{}", source, agent_id, cwd_str)
    }
}

fn with_cache<R>(f: impl FnOnce(&mut DiscoveryCache) -> R) -> R {
    let mut guard = CACHE.lock().unwrap();
    let cache = guard.get_or_insert_with(|| DiscoveryCache {
        results: HashMap::new(),
        in_flight: HashMap::new(),
    });
    f(cache)
}

fn check_cache(key: &str) -> CacheStatus {
    let ttl = key
        .split("::")
        .next()
        .map(source_ttl)
        .unwrap_or(SDK_BUNDLE_TTL);
    let guard = CACHE.lock().unwrap();
    let cache = match guard.as_ref() {
        Some(c) => c,
        None => return CacheStatus::Miss,
    };
    match cache.results.get(key) {
        Some(entry) => {
            let age = entry.created_at.elapsed();
            // ACP available commands must never be served stale: an agent can
            // publish a new command list at any time, and stale entries would
            // keep leaked/misclassified commands visible until 2x TTL.
            let revalidate_factor = if key.starts_with("acp_commands::") {
                1
            } else {
                REVALIDATE_WINDOW_FACTOR
            };
            if age < ttl {
                CacheStatus::Fresh(entry.value.clone())
            } else if age < ttl * revalidate_factor {
                CacheStatus::Stale(entry.value.clone())
            } else {
                CacheStatus::Miss
            }
        }
        None => CacheStatus::Miss,
    }
}

/// Maximum number of cached entries before evicting the oldest ones.
const CACHE_MAX_ENTRIES: usize = 1024;

fn cache_set(key: &str, value: Value) {
    with_cache(|cache| {
        cache.results.insert(
            key.to_string(),
            CacheEntry {
                value,
                created_at: Instant::now(),
            },
        );

        // Simple capacity guard: evict oldest entries when the cache grows too large.
        if cache.results.len() > CACHE_MAX_ENTRIES {
            let mut entries: Vec<(String, Instant)> = cache
                .results
                .iter()
                .map(|(k, v)| (k.clone(), v.created_at))
                .collect();
            entries.sort_by_key(|(_, t)| *t);
            let to_remove = cache.results.len() - CACHE_MAX_ENTRIES;
            for (key, _) in entries.into_iter().take(to_remove) {
                cache.results.remove(&key);
            }
        }
    });
}

/// Invalidate all cache entries for a given agent (used by `refresh=1`).
/// Handles both key formats:
/// - Static: `{source}::{cwd}` — invalidated only if cwd matches (no agent_id to check).
/// - Runtime: `{source}::{agent_id}::{cwd}` — invalidated by agent_id + cwd.
pub fn invalidate_agent(agent_id: &str, cwd: Option<&str>) {
    let invalidate_all_cwd = cwd.is_none();
    let cwd_str = cwd.unwrap_or("");
    with_cache(|cache| {
        cache.results.retain(|k, _| {
            // Try runtime format first: `{source}::{agent_id}::{cwd}`
            let mut parts = k.splitn(3, "::");
            let source = parts.next().unwrap_or("");
            let second = parts.next().unwrap_or("");
            let third = parts.next().unwrap_or("");

            if is_static_source(source) {
                // Static key may be `{source}::{cwd}` (2 parts) or
                // `{source}::{kind}::{cwd}` (3 parts, scoped by agent kind).
                if third.is_empty() {
                    second != cwd_str
                } else {
                    third != cwd_str
                }
            } else {
                // Runtime key: `{source}::{agent_id}::{cwd}` — second is agent_id, third is cwd
                if invalidate_all_cwd {
                    second != agent_id
                } else {
                    !(second == agent_id && third == cwd_str)
                }
            }
        });
        // Drop any in-flight handles for the same agent so refresh starts clean.
        cache.in_flight.retain(|k, _| {
            let mut parts = k.splitn(3, "::");
            let source = parts.next().unwrap_or("");
            let second = parts.next().unwrap_or("");
            let third = parts.next().unwrap_or("");

            if is_static_source(source) {
                if third.is_empty() {
                    second != cwd_str
                } else {
                    third != cwd_str
                }
            } else {
                if invalidate_all_cwd {
                    second != agent_id
                } else {
                    !(second == agent_id && third == cwd_str)
                }
            }
        });
    });
}

/// Get or create an in-flight dedup handle for a source.
fn get_in_flight(key: &str) -> Arc<AsyncMutex<Option<Value>>> {
    with_cache(|cache| {
        cache
            .in_flight
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(None)))
            .clone()
    })
}

fn remove_in_flight(key: &str) {
    with_cache(|cache| {
        cache.in_flight.remove(key);
    });
}

/// RAII guard for in-flight cache entries.
///
/// Ensures the in-flight key is removed when the guard is dropped,
/// regardless of whether the fetch completes normally, panics, or is cancelled.
/// This prevents memory leaks from orphaned keys accumulating over time.
struct InFlightGuard {
    key: String,
}

impl InFlightGuard {
    fn new(key: String) -> Self {
        Self { key }
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        remove_in_flight(&self.key);
    }
}

// ---------------------------------------------------------------------------
// Agent context resolution
// ---------------------------------------------------------------------------

fn resolve_agent_kind(profile: Option<&str>, command: Option<&str>) -> &'static str {
    match crate::services::agent::resolve_kind_parts(
        profile.unwrap_or(""),
        command.unwrap_or(""),
        "",
    ) {
        crate::services::agent::AgentKind::OpenCode => "opencode",
        crate::services::agent::AgentKind::Codex => "codex",
        crate::services::agent::AgentKind::Claude => "claude",
        crate::services::agent::AgentKind::Unknown => "",
    }
}

async fn resolve_context(
    agent_id: &str,
    cwd: Option<&str>,
) -> (Option<String>, String, Option<String>) {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    let agent_info = runtime.get_agent(agent_id).await;

    let resolved_cwd: Option<String> = cwd.map(|s| s.to_string()).or_else(|| {
        agent_info.as_ref().and_then(|info| {
            info.handle
                .metadata
                .get("work_dir")
                .cloned()
                .or_else(|| info.handle.workspace.metadata.get("work_dir").cloned())
        })
    });

    let mut profile_name = agent_info.as_ref().and_then(|i| i.profile.clone());

    // Suspended agents are not in the runtime registry; fall back to the persisted
    // profile mapping so discovery (and SDK command detection) still works.
    if profile_name.is_none() {
        profile_name = load_agent_profile(agent_id);
    }
    // The discovery-cache mapping may be missing for agents suspended before it
    // was persisted; the suspend store is authoritative for their profile.
    if profile_name.is_none() {
        if let Ok(suspended) = runtime.suspend_store().list_suspended() {
            if let Some(record) = suspended.into_iter().find(|r| r.id == agent_id) {
                profile_name = Some(record.profile_name);
            }
        }
    }

    // Resolve agent kind via profile registry (agent_type/command), fallback to name contains.
    // Profile registry access can touch disk/DB, so run it off the async executor.
    let mut kind = String::new();
    if let Some(pn) = profile_name.clone() {
        let resolved = tokio::task::spawn_blocking(move || {
            let mut kind = String::new();
            if let Ok(reg) = crate::services::profile_service::get_profile_registry() {
                if let Ok(profiles) = reg.list_with_status() {
                    if let Some(p) = profiles.into_iter().find(|x| x.name == pn) {
                        kind = match crate::services::agent::resolve_kind_parts(
                            &p.name,
                            &p.command,
                            &p.agent_type,
                        ) {
                            crate::services::agent::AgentKind::OpenCode => "opencode".to_string(),
                            crate::services::agent::AgentKind::Codex => "codex".to_string(),
                            crate::services::agent::AgentKind::Claude => "claude".to_string(),
                            crate::services::agent::AgentKind::Unknown => String::new(),
                        };
                    }
                }
            }
            kind
        })
        .await
        .unwrap_or_default();
        kind = resolved;
    }
    if kind.is_empty() {
        kind = resolve_agent_kind(profile_name.as_deref(), None).to_string();
    }
    (resolved_cwd, kind, profile_name)
}

// ---------------------------------------------------------------------------
// Source fetchers
// ---------------------------------------------------------------------------

async fn fetch_convention_agents(kind: &str, cwd: Option<&str>) -> Vec<Value> {
    let cwd_owned = cwd.map(PathBuf::from);
    let kind_owned = kind.to_string();
    tokio::task::spawn_blocking(move || {
        let mut out: Vec<Value> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let home = home_dir();
        let cwd_path = cwd_owned.as_deref();

        if agent_scan_kinds(&kind_owned).contains(&"codex") {
            collect_codex_agents(&home, cwd_path, &mut out, &mut seen);
        }
        out
    })
    .await
    .unwrap_or_default()
}

/// Normalize profile names / provider ids / commands to the canonical agent kind.
///
/// The UI and profile registry use aliases such as `claude-code`, `Claude Code`
/// or a full command path. Matching only the exact strings `claude`/`codex`/
/// `opencode` made discovery return almost nothing when the agent was not
/// running (static discovery passes the provider id through verbatim).
fn normalize_agent_kind(raw: &str) -> &'static str {
    match crate::services::agent::resolve_kind_parts(raw, "", "") {
        crate::services::agent::AgentKind::Claude => "claude",
        crate::services::agent::AgentKind::Codex => "codex",
        crate::services::agent::AgentKind::OpenCode => "opencode",
        crate::services::agent::AgentKind::Unknown => "",
    }
}

/// Kinds to scan for convention agents. An unknown/empty kind means the caller
/// has no running agent (new chat, quick composer, suspended agent without a
/// profile mapping), so scan every supported ecosystem instead of returning [].
///
/// Claude Code and OpenCode are intentionally excluded: their subagents are
/// invoked by the model through the Task / subagent tool and have no
/// prompt-level trigger, so exposing them in the composer would produce text
/// mentions the agent cannot resolve.
fn agent_scan_kinds(raw: &str) -> Vec<&'static str> {
    match normalize_agent_kind(raw) {
        "" | "codex" => vec!["codex"],
        _ => vec![],
    }
}

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"))
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Parse the small subset of YAML frontmatter used by agent definitions.
/// Supports quoted values and simple `description: >` / `|` blocks.
fn parse_agent_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let trimmed = content.trim_start();
    let Some(rest) = trimmed.strip_prefix("---") else {
        return (None, None);
    };
    let Some(end) = rest.find("\n---") else {
        return (None, None);
    };
    let frontmatter = &rest[..end];

    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut lines = frontmatter.lines().peekable();

    while let Some(line) = lines.next() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let key = k.trim();
        let raw_value = v.trim();
        let mut value = raw_value.trim_matches('"').trim_matches('\'').to_string();

        if key == "description" && (raw_value.starts_with('>') || raw_value.starts_with('|')) {
            let mut block: Vec<String> = Vec::new();
            while let Some(next) = lines.peek() {
                if next.starts_with(' ') || next.starts_with('\t') {
                    block.push(next.trim().to_string());
                    lines.next();
                } else {
                    break;
                }
            }
            value = block.join(" ").trim().to_string();
        }

        match key {
            "name" if !value.is_empty() => name = Some(value),
            "description" => description = Some(value),
            _ => {}
        }
    }

    (name, description)
}

fn push_agent(
    out: &mut Vec<Value>,
    seen: &mut HashSet<String>,
    name: String,
    description: String,
    source: &str,
) {
    let name = name.trim().to_string();
    if name.is_empty() || !seen.insert(name.clone()) {
        return;
    }
    out.push(json!({
        "name": name,
        "description": description,
        "source": source,
        "group": "Agents",
        "type": "agent",
        "targetTriggers": ["@"],
    }));
}

/// Recursively scan markdown agent files under `root`.
///
/// `id_from_path` controls the fallback name: OpenCode derives the agent id from
/// the path below `agents/` (nested dirs become `team/reviewer`), while Codex
/// uses the file stem.
fn scan_markdown_agents(
    root: &Path,
    base: &Path,
    source: &str,
    id_from_path: bool,
    out: &mut Vec<Value>,
    seen: &mut HashSet<String>,
    depth: usize,
) {
    if depth > 8 {
        return;
    }
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if dir_name.starts_with('.') || dir_name == "node_modules" {
                continue;
            }
            scan_markdown_agents(&path, base, source, id_from_path, out, seen, depth + 1);
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let (fm_name, fm_description) = parse_agent_frontmatter(&content);
        let fallback_name = if id_from_path {
            path.strip_prefix(base)
                .unwrap_or(&path)
                .with_extension("")
                .to_string_lossy()
                .replace('\\', "/")
        } else {
            path.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        };
        let name = fm_name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or(fallback_name);
        push_agent(out, seen, name, fm_description.unwrap_or_default(), source);
    }
}

fn collect_codex_agents(
    home: &Path,
    cwd: Option<&Path>,
    out: &mut Vec<Value>,
    seen: &mut HashSet<String>,
) {
    let codex_home = env_path("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
    let mut dirs: Vec<PathBuf> = vec![codex_home.join("agents")];
    if let Some(c) = cwd {
        let mut cur = Some(c.to_path_buf());
        while let Some(dir) = cur {
            dirs.push(dir.join(".codex").join("agents"));
            if dir.join(".git").exists() {
                break;
            }
            cur = dir.parent().map(Path::to_path_buf);
        }
    }
    let mut visited: HashSet<PathBuf> = HashSet::new();
    for dir in dirs {
        let canonical = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        if !visited.insert(canonical) {
            continue;
        }
        scan_codex_agents_dir(&dir, out, seen);
    }
}

fn scan_codex_agents_dir(dir: &Path, out: &mut Vec<Value>, seen: &mut HashSet<String>) {
    // Markdown definitions are also accepted by some Codex-compatible setups.
    scan_markdown_agents(dir, dir, "convention", false, out, seen, 0);

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("toml") {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let parsed: toml::Value = match content.parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let mut name = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut description = String::new();
        if let Some(t) = parsed.get("name").and_then(|v| v.as_str()) {
            if !t.is_empty() {
                name = t.to_string();
            }
        }
        if let Some(t) = parsed.get("description").and_then(|v| v.as_str()) {
            description = t.to_string();
        }
        push_agent(out, seen, name, description, "convention");
    }
}

async fn fetch_convention_skills(cwd: Option<&str>, agent_kind: Option<&str>) -> Value {
    let cwd_owned = cwd.map(|s| s.to_string());
    let agent_kind_owned = agent_kind.map(|s| s.to_string());
    let skills = tokio::task::spawn_blocking(move || {
        let kind = match normalize_agent_kind(agent_kind_owned.as_deref().unwrap_or("")) {
            "claude" => crate::services::agent::AgentKind::Claude,
            "codex" => crate::services::agent::AgentKind::Codex,
            "opencode" => crate::services::agent::AgentKind::OpenCode,
            _ => crate::services::agent::AgentKind::Unknown,
        };
        crate::services::agent::list_skills(kind, cwd_owned.as_deref())
    })
    .await
    .unwrap_or_default();

    let skills: Vec<Value> = skills
        .into_iter()
        .map(|s| {
            json!({
                "name": s.name,
                "description": s.description,
                "path": s.path,
                "source": s.source,
                "group": "Skills",
                "type": "skill",
                "targetTriggers": ["$"],
            })
        })
        .collect();
    json!(skills)
}

async fn fetch_acp_commands(agent_id: &str) -> Value {
    let commands: Vec<Value> =
        match crate::services::agent_service::get_agent_available_commands(agent_id).await {
            Ok(Some(cmds)) => cmds
                .into_iter()
                .map(|c| {
                    json!({
                        "name": c.name,
                        "description": c.description,
                        "argumentHint": "",
                        "aliases": [],
                        "source": "acp",
                    })
                })
                .collect(),
            _ => vec![],
        };
    json!(commands)
}

async fn fetch_sdk_bundle(kind: &str, cwd: Option<&str>) -> Value {
    let agent_kind = match kind {
        "claude" => crate::services::agent::AgentKind::Claude,
        "codex" => crate::services::agent::AgentKind::Codex,
        "opencode" => crate::services::agent::AgentKind::OpenCode,
        _ => crate::services::agent::AgentKind::Unknown,
    };
    if agent_kind == crate::services::agent::AgentKind::Unknown {
        crate::services::agent_sdk_service::discover(kind, cwd).await
    } else {
        crate::services::agent::discover(agent_kind, cwd).await
    }
}

async fn fetch_plugins() -> Value {
    let plugins = tokio::task::spawn_blocking(scan_plugins)
        .await
        .unwrap_or_default();
    json!(plugins)
}

async fn fetch_convention_mcp_items(cwd: Option<&str>) -> Vec<Value> {
    let cwd_owned = cwd.map(|s| s.to_string());
    tokio::task::spawn_blocking(move || {
        let mut items: Vec<Value> = Vec::new();
        for m in crate::services::mcp_convention::scan_claude_mcp(cwd_owned.as_deref()) {
            items.push(json!({
                "name": m.name,
                "description": format!("Claude MCP config ({})", m.source),
                "status": "configured",
                "config": m.config,
                "source": format!("convention-{}", m.source),
                "path": m.path,
                "group": "MCP",
                "type": "mcp",
                "targetTriggers": ["/"],
            }));
        }
        for m in crate::services::mcp_convention::scan_codex_mcp(cwd_owned.as_deref()) {
            items.push(json!({
                "name": m.name,
                "description": format!("Codex MCP config ({})", m.source),
                "status": "configured",
                "config": m.config,
                "source": format!("convention-{}", m.source),
                "path": m.path,
                "group": "MCP",
                "type": "mcp",
                "targetTriggers": ["/"],
            }));
        }
        for m in crate::services::mcp_convention::scan_opencode_mcp(cwd_owned.as_deref()) {
            items.push(json!({
                "name": m.name,
                "description": format!("OpenCode MCP config ({})", m.source),
                "status": "configured",
                "config": m.config,
                "source": format!("convention-{}", m.source),
                "path": m.path,
                "group": "MCP",
                "type": "mcp",
                "targetTriggers": ["/"],
            }));
        }
        // De-duplicate convention MCP entries by name across agent kinds.
        dedup_by_name(&mut items, "name");
        items
    })
    .await
    .unwrap_or_default()
}

fn merge_mcp_items(mut base: Vec<Value>, extra: Vec<Value>) -> Vec<Value> {
    base.extend(extra);
    dedup_by_name(&mut base, "name");
    base
}

/// Fetch a source by name. Pure function dispatching to the right fetcher.
async fn fetch_source(
    source: &str,
    kind: &str,
    agent_id: &str,
    cwd: Option<&str>,
    agent_kind: Option<&str>,
) -> Value {
    match source {
        SRC_CONVENTION_SKILLS => fetch_convention_skills(cwd, agent_kind).await,
        SRC_ACP_COMMANDS => fetch_acp_commands(agent_id).await,
        SRC_SDK_BUNDLE => fetch_sdk_bundle(kind, cwd).await,
        SRC_PLUGINS => {
            // Plugins source is a Claude marketplace scan; only surface it for
            // claude (or the agent-agnostic / all case).
            if let Some(k) = agent_kind {
                if k != "claude" {
                    return json!([]);
                }
            }
            fetch_plugins().await
        }
        _ => json!([]),
    }
}

/// Fetch with in-flight deduplication: if another task is already fetching
/// this key, wait for it instead of starting a duplicate fetch.
///
/// Uses RAII `InFlightGuard` to ensure cleanup even on panic/cancellation.
async fn fetch_source_dedup(
    source: &str,
    kind: &str,
    agent_id: &str,
    cwd: Option<&str>,
    agent_kind: Option<&str>,
) -> Value {
    let key = cache_key(source, agent_id, cwd, agent_kind);
    let in_flight = get_in_flight(&key);

    // Hold the per-key lock across the fetch so concurrent callers for the same
    // source/agent/cwd wait for the in-flight fetch instead of spawning duplicates.
    let _cleanup = InFlightGuard::new(key.clone());
    let mut guard = in_flight.lock().await;

    // Fast path: another request already completed.
    if let Some(result) = guard.as_ref() {
        return result.clone();
    }

    let value = fetch_source(source, kind, agent_id, cwd, agent_kind).await;

    // Store in dedup handle (so concurrent waiters observe the result) but only
    // persist successful results in the TTL cache — error results are retried
    // on the next request instead of being served stale.
    *guard = Some(value.clone());
    if value.get("error").and_then(|v| v.as_str()).is_none() {
        cache_set(&key, value.clone());
    }

    value
}

// ---------------------------------------------------------------------------
// Merge: assemble final components from source values
// ---------------------------------------------------------------------------

fn dedup_by_name(items: &mut Vec<Value>, key: &str) {
    let mut seen: HashSet<String> = HashSet::new();
    items.retain(|v| {
        let name = v
            .get(key)
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            return true;
        }
        if seen.contains(&name) {
            false
        } else {
            seen.insert(name);
            true
        }
    });
}

/// Result of classifying a single ACP available command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcpCommandKind {
    /// The command is actually a skill invocation. Carries the normalized skill name.
    Skill(String),
    /// The command is a genuine slash command.
    Command,
}

/// Abstract classifier for ACP available commands.
///
/// Different agents expose skills through ACP using different conventions, so
/// classification is delegated to an agent-specific implementation. This trait
/// is the "abstract service" that serves every agent kind; callers obtain an
/// instance via [`acp_classifier_for_kind`].
pub trait AcpCommandClassifier: Send + Sync {
    /// Classify one ACP command. `known_skills` contains skill names already
    /// discovered through the SDK/convention layers and can be used for
    /// membership-based classification.
    fn classify(&self, cmd: &Value, known_skills: &HashSet<String>) -> AcpCommandKind;
}

/// Codex exposes skills as `$name` commands.
pub struct CodexAcpClassifier;
impl AcpCommandClassifier for CodexAcpClassifier {
    fn classify(&self, cmd: &Value, known_skills: &HashSet<String>) -> AcpCommandKind {
        let name = cmd.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name.starts_with('$') {
            let skill_name = name.trim_start_matches('$').to_string();
            if !skill_name.is_empty() {
                return AcpCommandKind::Skill(skill_name);
            }
        }
        if known_skills.contains(name) {
            return AcpCommandKind::Skill(name.to_string());
        }
        AcpCommandKind::Command
    }
}

/// Claude exposes skills as slash commands. They are recognizable either by a
/// name that matches a discovered skill, or by a description that carries a
/// user/plugin marker (`(user)`, or a leading `(plugin-name)` group).
pub struct ClaudeAcpClassifier;
impl AcpCommandClassifier for ClaudeAcpClassifier {
    fn classify(&self, cmd: &Value, known_skills: &HashSet<String>) -> AcpCommandKind {
        let name = cmd.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let description = cmd
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if known_skills.contains(name) {
            return AcpCommandKind::Skill(name.to_string());
        }
        // User-invocable skills are annotated with a trailing "(user)" marker.
        if description.trim_end().ends_with("(user)") {
            return AcpCommandKind::Skill(name.to_string());
        }
        // Plugin skills are rendered as "(plugin-name) ..." descriptions.
        if description.trim_start().starts_with('(')
            && description.contains(") ")
            && !name.starts_with("mcp:")
            && name != "agents"
        {
            return AcpCommandKind::Skill(name.to_string());
        }
        AcpCommandKind::Command
    }
}

/// OpenCode exposes very few ACP commands; classify by known-skill membership.
pub struct OpenCodeAcpClassifier;
impl AcpCommandClassifier for OpenCodeAcpClassifier {
    fn classify(&self, cmd: &Value, known_skills: &HashSet<String>) -> AcpCommandKind {
        let name = cmd.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if known_skills.contains(name) {
            return AcpCommandKind::Skill(name.to_string());
        }
        AcpCommandKind::Command
    }
}

/// Fallback classifier used for unknown agent kinds.
pub struct DefaultAcpClassifier;
impl AcpCommandClassifier for DefaultAcpClassifier {
    fn classify(&self, cmd: &Value, known_skills: &HashSet<String>) -> AcpCommandKind {
        let name = cmd.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name.starts_with('$') {
            let skill_name = name.trim_start_matches('$').to_string();
            if !skill_name.is_empty() {
                return AcpCommandKind::Skill(skill_name);
            }
        }
        if known_skills.contains(name) {
            return AcpCommandKind::Skill(name.to_string());
        }
        AcpCommandKind::Command
    }
}

pub fn acp_classifier_for_kind(kind: &str) -> Box<dyn AcpCommandClassifier> {
    match kind {
        "codex" => Box::new(CodexAcpClassifier),
        "claude" => Box::new(ClaudeAcpClassifier),
        "opencode" => Box::new(OpenCodeAcpClassifier),
        _ => Box::new(DefaultAcpClassifier),
    }
}

/// Classify ACP available commands into skills and slash commands.
///
/// Uses an agent-specific [`AcpCommandClassifier`] so each agent's symbol
/// conventions are honored. `known_skills` contains skill names already
/// discovered through SDK/convention layers and is used for membership-based
/// classification.
pub fn classify_acp_commands(
    classifier: &dyn AcpCommandClassifier,
    known_skills: &HashSet<String>,
    commands: &Value,
) -> (Vec<Value>, Vec<Value>) {
    let mut skills: Vec<Value> = Vec::new();
    let mut slash_commands: Vec<Value> = Vec::new();

    for item in commands.as_array().cloned().unwrap_or_default() {
        match classifier.classify(&item, known_skills) {
            AcpCommandKind::Skill(skill_name) => {
                if skill_name.is_empty() {
                    continue;
                }
                let mut skill = item.clone();
                skill["name"] = json!(skill_name);
                skills.push(skill);
            }
            AcpCommandKind::Command => {
                slash_commands.push(item);
            }
        }
    }

    (skills, slash_commands)
}

/// Backwards-compatible entry point using the default classifier.
pub fn classify_acp_commands_default(commands: &Value) -> (Vec<Value>, Vec<Value>) {
    classify_acp_commands(&DefaultAcpClassifier, &HashSet::new(), commands)
}

fn merge_sources(
    _agent_id: &str,
    agent_kind: &str,
    convention_skills: &Value,
    sdk_bundle: &Value,
    acp_commands: &Value,
    plugins: &Value,
) -> Value {
    let mut errors: Vec<Value> = Vec::new();

    fn canonical_type(raw: Option<&str>, fallback: &str) -> &'static str {
        match raw {
            Some("skill") => "skill",
            Some("command") => "command",
            Some("mcp") => "mcp",
            Some("plugin") => "plugin",
            Some("agent") => "agent",
            _ => match fallback {
                "skill" => "skill",
                "command" => "command",
                "mcp" => "mcp",
                "plugin" => "plugin",
                "agent" => "agent",
                _ => "skill",
            },
        }
    }

    fn target_triggers_for_type(t: &str) -> Value {
        match t {
            "skill" => json!(["$"]),
            "command" => json!(["/"]),
            "mcp" => json!(["/"]),
            "plugin" => json!(["/"]),
            "agent" => json!(["@"]),
            _ => json!([]),
        }
    }

    fn group_for_type(t: &str) -> &'static str {
        match t {
            "skill" => "Skills",
            "command" => "Commands",
            "mcp" => "MCP",
            "plugin" => "Plugins",
            "agent" => "Agents",
            _ => "Items",
        }
    }

    fn normalize_discovery_item(
        item: &mut Value,
        bucket_fallback_type: &str,
        default_source: Option<&str>,
    ) {
        let t = canonical_type(
            item.get("type").and_then(|v| v.as_str()),
            bucket_fallback_type,
        );
        item["type"] = json!(t);
        // Routing is hardcoded by type (SDK/source only needs to provide type).
        item["targetTriggers"] = target_triggers_for_type(t);
        if item.get("group").is_none()
            || item
                .get("group")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .is_empty()
        {
            item["group"] = json!(group_for_type(t));
        }
        if item.get("source").is_none() {
            if let Some(src) = default_source {
                item["source"] = json!(src);
            }
        }
    }

    // Skills: SDK (agent's own, higher priority) first, then convention
    // (filesystem, stable fallback). Dedup keeps the SDK entry on name clash,
    // mirroring the model source-chain where the live/SDK source outranks the
    // static config file.
    // ACP available commands carry no type field. Different agents expose skills
    // through different conventions (Codex uses `$name`, Claude marks them in
    // the description or via names that match discovered skills, ...), so
    // classify them with an agent-specific classifier before merging.
    let mut known_skill_names: HashSet<String> = HashSet::new();
    if let Some(arr) = sdk_bundle.get("skills").and_then(|v| v.as_array()) {
        for s in arr {
            if let Some(name) = s.get("name").and_then(|v| v.as_str()) {
                if !name.is_empty() {
                    known_skill_names.insert(name.to_string());
                }
            }
        }
    }
    for s in convention_skills.as_array().cloned().unwrap_or_default() {
        if let Some(name) = s.get("name").and_then(|v| v.as_str()) {
            if !name.is_empty() {
                known_skill_names.insert(name.to_string());
            }
        }
    }

    let classifier = acp_classifier_for_kind(agent_kind);
    let (acp_skills_raw, acp_commands_raw) =
        classify_acp_commands(&*classifier, &known_skill_names, acp_commands);

    let mut skills: Vec<Value> = Vec::new();
    if let Some(arr) = sdk_bundle.get("skills").and_then(|v| v.as_array()) {
        for s in arr {
            let mut s = s.clone();
            normalize_discovery_item(&mut s, "skill", Some("agent-sdk"));
            skills.push(s);
        }
    }
    for s in convention_skills.as_array().cloned().unwrap_or_default() {
        let mut s = s.clone();
        normalize_discovery_item(&mut s, "skill", None);
        skills.push(s);
    }
    // ACP-derived skills are the lowest priority source: only fill gaps left by
    // the SDK and convention scans.
    for mut s in acp_skills_raw {
        normalize_discovery_item(&mut s, "skill", Some("acp"));
        skills.push(s);
    }
    dedup_by_name(&mut skills, "name");

    // Commands: ACP (non-skill entries) + SDK.
    let mut commands: Vec<Value> = acp_commands_raw;
    for c in &mut commands {
        normalize_discovery_item(c, "command", None);
    }
    if let Some(arr) = sdk_bundle.get("commands").and_then(|v| v.as_array()) {
        for c in arr {
            let mut c = c.clone();
            normalize_discovery_item(&mut c, "command", Some("agent-sdk"));
            commands.push(c);
        }
    }
    dedup_by_name(&mut commands, "name");

    // MCP runtime/declared list is owned by Ergatai (registry + convention),
    // not by the agent SDK. The SDK only reports the agent's own/native MCP
    // servers, which we surface separately as `agentNativeMcp`.
    let mut agent_native_mcp: Vec<Value> = sdk_bundle
        .get("mcp")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for m in &mut agent_native_mcp {
        normalize_discovery_item(m, "mcp", Some("agent-sdk"));
    }

    // Keep `mcp` empty here; it is populated from Ergatai registry + convention
    // after merge so ACP-injected/runtime MCP status is not conflated with the
    // agent's own local MCP configuration.
    let mcp: Vec<Value> = Vec::new();

    // Plugins: backend marketplace scan + SDK (Claude reloadPlugins)
    let scan_plugins: Vec<Value> = plugins.as_array().cloned().unwrap_or_default();
    // Index scan results by name for metadata enrichment of SDK-only plugins.
    let mut scan_by_name: HashMap<String, Value> = HashMap::new();
    for p in &scan_plugins {
        if let Some(name) = p.get("name").and_then(|v| v.as_str()) {
            if !name.is_empty() {
                scan_by_name.insert(name.to_string(), p.clone());
            }
        }
    }

    let mut plugins_out: Vec<Value> = scan_plugins;
    for p in &mut plugins_out {
        normalize_discovery_item(p, "plugin", None);
    }
    if let Some(arr) = sdk_bundle.get("plugins").and_then(|v| v.as_array()) {
        for p in arr {
            let mut p = p.clone();
            // Enrich SDK plugin metadata from marketplace scan when available.
            if let Some(name) = p
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
            {
                if let Some(scan) = scan_by_name.get(&name) {
                    for key in [
                        "version",
                        "description",
                        "marketplace",
                        "category",
                        "homepage",
                        "tags",
                    ] {
                        if p.get(key)
                            .map(|v| {
                                v.is_null()
                                    || (v.is_string() && v.as_str().unwrap_or("").is_empty())
                                    || (v.is_array() && v.as_array().unwrap().is_empty())
                            })
                            .unwrap_or(true)
                        {
                            if let Some(val) = scan.get(key) {
                                p[key] = val.clone();
                            }
                        }
                    }
                }
            }
            normalize_discovery_item(&mut p, "plugin", Some("agent-sdk"));
            plugins_out.push(p);
        }
    }
    dedup_by_name(&mut plugins_out, "name");
    let plugins = plugins_out;

    // Agents explicitly exposed by an agent SDK for prompt addressing.
    // Claude Code and OpenCode subagents are launched by the model through the
    // Task / subagent tool and have no prompt-level trigger, so their SDK
    // adapters do not emit them here. Anything present is surfaced under @.
    let mut agents: Vec<Value> = Vec::new();
    if let Some(arr) = sdk_bundle.get("agents").and_then(|v| v.as_array()) {
        for a in arr {
            let mut a = a.clone();
            normalize_discovery_item(&mut a, "agent", Some("agent-sdk"));
            if a.get("targetTriggers").is_none() {
                a["targetTriggers"] = json!(["@"]);
            }
            if a.get("group").is_none()
                || a.get("group")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .is_empty()
            {
                a["group"] = json!("Agents");
            }
            agents.push(a);
        }
    }
    dedup_by_name(&mut agents, "name");

    // Propagate SDK errors to the errors array
    if let Some(err) = sdk_bundle.get("error").and_then(|v| v.as_str()) {
        errors.push(json!({
            "source": "agent-sdk",
            "message": err,
        }));
    }

    json!({
        "skills": skills,
        "commands": commands,
        "mcp": mcp,
        "agentNativeMcp": agent_native_mcp,
        "plugins": plugins,
        "agents": agents,
        "errors": errors,
        "triggers": json!([]),
    })
}

// ---------------------------------------------------------------------------
// Persistent (last-known-good) cache
//
// Discovery results are persisted per (agent kind, cwd) so that a suspended or
// not-yet-registered agent can still surface the last successfully discovered
// commands/MCP/models instead of an empty list. The file is updated only when
// a "rich" result (commands or MCP present) is obtained, and served as a
// fallback when the live fetch is degraded.
// ---------------------------------------------------------------------------

fn persistent_cache_path() -> PathBuf {
    let base = std::env::var("ERGATAI_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| ergatai_runtime::dirs::user_data_dir());
    let _ = std::fs::create_dir_all(&base);
    base.join("discovery-cache.json")
}

fn canonical_keys(agent_id: &str, profile_name: Option<&str>, cwd: Option<&str>) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(p) = profile_name {
        keys.push(format!("profile::{}::{}", p, cwd.unwrap_or("")));
    }
    keys.push(format!("agent::{}::{}", agent_id, cwd.unwrap_or("")));
    keys
}

fn load_agent_profile(agent_id: &str) -> Option<String> {
    let path = persistent_cache_path();
    let content = std::fs::read_to_string(&path).ok()?;
    let parsed: Value = serde_json::from_str(&content).ok()?;
    parsed
        .get("__agent_profiles__")
        .and_then(|v| v.get(agent_id))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

const DISCOVERY_CACHE_VERSION: i64 = 2;

fn load_persistent(agent_id: &str, profile_name: Option<&str>, cwd: Option<&str>) -> Option<Value> {
    let path = persistent_cache_path();
    let content = std::fs::read_to_string(&path).ok()?;
    let parsed: Value = serde_json::from_str(&content).ok()?;

    // Ignore caches written by older schemas (e.g. before agent-kind scoping).
    if parsed.get("__cache_version__").and_then(|v| v.as_i64()) != Some(DISCOVERY_CACHE_VERSION) {
        return None;
    }

    // Try canonical keys first.
    for key in canonical_keys(agent_id, profile_name, cwd) {
        if let Some(v) = parsed.get(&key) {
            return Some(v.clone());
        }
    }
    // Fall back to persisted profile mapping for suspended agents.
    if let Some(p) = load_agent_profile(agent_id) {
        let key = format!("profile::{}::{}", p, cwd.unwrap_or(""));
        if let Some(v) = parsed.get(&key) {
            return Some(v.clone());
        }
    }
    None
}

fn save_persistent(agent_id: &str, profile_name: Option<&str>, cwd: Option<&str>, value: &Value) {
    // Only persist "rich" results that actually carry agent-provided data.
    let commands_empty = value
        .get("commands")
        .and_then(|v| v.as_array())
        .map(|a| a.is_empty())
        .unwrap_or(true);
    let mcp_empty = value
        .get("mcp")
        .and_then(|v| v.as_array())
        .map(|a| a.is_empty())
        .unwrap_or(true);
    if commands_empty && mcp_empty {
        return;
    }

    let path = persistent_cache_path();
    let mut root: serde_json::Map<String, Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str::<Value>(&c).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    root.insert(
        "__cache_version__".to_string(),
        Value::Number(DISCOVERY_CACHE_VERSION.into()),
    );

    // Persist under all canonical keys so both agent-id and profile lookups work.
    for key in canonical_keys(agent_id, profile_name, cwd) {
        root.insert(key, value.clone());
    }

    // Maintain agent_id -> profile mapping for suspended-agent fallback.
    if let Some(p) = profile_name {
        let mut mapping = root
            .get("__agent_profiles__")
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        mapping.insert(agent_id.to_string(), Value::String(p.to_string()));
        root.insert("__agent_profiles__".to_string(), Value::Object(mapping));
    }

    if let Ok(serialized) = serde_json::to_string_pretty(&Value::Object(root)) {
        let _ = std::fs::write(&path, serialized);
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// All-sources list, used for iteration during refresh and background revalidation.
const ALL_SOURCES: &[&str] = &[
    SRC_CONVENTION_SKILLS,
    SRC_SDK_BUNDLE,
    SRC_ACP_COMMANDS,
    SRC_PLUGINS,
];

/// Unified discovery: aggregates skills/commands/mcp/plugins from multiple sources
/// with per-source TTLs and stale-while-revalidate semantics.
///
/// Cache behavior:
/// - **Fresh** (age < TTL): used directly, no fetch.
/// - **Stale** (TTL ≤ age < 2×TTL): served to caller immediately; a background
///   task re-fetches the stale source and updates the cache.
/// - **Miss** (age ≥ 2×TTL or not cached): fetched synchronously before returning.
///
/// Concurrent requests for the same (source, agent_id, cwd) are deduplicated
/// via an in-flight handle.
pub async fn discover(agent_id: &str, cwd: Option<&str>, refresh: bool) -> Value {
    let started = Instant::now();
    let (resolved_cwd, kind, profile_name) = resolve_context(agent_id, cwd).await;
    let kind = kind.as_str();
    let cwd_opt = resolved_cwd.as_deref();
    // Scope static sources (convention_skills, plugins) by agent kind so that
    // Claude-only plugin skills/plugins do not leak into OpenCode/Codex.
    let agent_kind_opt: Option<&str> = if kind.is_empty() { None } else { Some(kind) };
    // refresh=1 → invalidate all cached sources for this agent.
    if refresh {
        invalidate_agent(agent_id, cwd_opt);
    }

    // Classify each source as Fresh / Stale / Miss.
    let mut fresh_values: HashMap<&str, Value> = HashMap::new();
    let mut stale_sources: Vec<&str> = Vec::new();
    let mut miss_sources: Vec<&str> = Vec::new();

    for &source in ALL_SOURCES {
        let key = cache_key(source, agent_id, cwd_opt, agent_kind_opt);
        match check_cache(&key) {
            CacheStatus::Fresh(v) => {
                fresh_values.insert(source, v);
            }
            CacheStatus::Stale(v) => {
                if source == SRC_ACP_COMMANDS {
                    // Never serve stale ACP commands; refetch so newly published
                    // command lists replace the cached one immediately.
                    miss_sources.push(source);
                } else {
                    fresh_values.insert(source, v);
                    stale_sources.push(source);
                }
            }
            CacheStatus::Miss => {
                // Skills-first: when the SDK bundle is a miss but we have a
                // persisted (last-known-good) result, serve it immediately and
                // refresh in the background instead of blocking the first render
                // on the SDK subprocess. Commands/MCP may be stale until refresh.
                if source == SRC_SDK_BUNDLE {
                    if let Some(cached) =
                        load_persistent(agent_id, profile_name.as_deref(), cwd_opt)
                    {
                        // The persistent cache stores a full discovery result, not
                        // a raw SDK bundle. Only carry over agent-provided fields
                        // (commands/models); skills/plugins/agents must be
                        // re-discovered so agent-kind scoping is respected.
                        let sdk_only = json!({
                            "commands": cached.get("commands").cloned().unwrap_or(json!([])),
                            "models": cached.get("models").cloned().unwrap_or(json!([])),
                        });
                        fresh_values.insert(source, sdk_only);
                        stale_sources.push(source);
                        continue;
                    }
                }
                miss_sources.push(source);
            }
        }
    }

    // Synchronous fetch for miss sources.
    for &source in &miss_sources {
        let value = fetch_source_dedup(source, kind, agent_id, cwd_opt, agent_kind_opt).await;
        fresh_values.insert(source, value);
    }

    // Assemble the merged result from whatever we have.
    let mut result = merge_sources(
        agent_id,
        kind,
        fresh_values
            .get(SRC_CONVENTION_SKILLS)
            .unwrap_or(&json!([])),
        fresh_values.get(SRC_SDK_BUNDLE).unwrap_or(&json!({})),
        fresh_values.get(SRC_ACP_COMMANDS).unwrap_or(&json!([])),
        fresh_values.get(SRC_PLUGINS).unwrap_or(&json!([])),
    );

    // Static (filesystem/config) subagents, independent of the running agent service.
    let static_agents = fetch_convention_agents(kind, cwd_opt).await;
    if !static_agents.is_empty() {
        let mut agents: Vec<Value> = result
            .get("agents")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for a in static_agents {
            agents.push(a);
        }
        dedup_by_name(&mut agents, "name");
        if let Some(obj) = result.as_object_mut() {
            obj.insert("agents".to_string(), json!(agents));
        }
    }

    // Populate triggers from agent-aware registry.
    if let Some(obj) = result.as_object_mut() {
        obj.insert(
            "triggers".to_string(),
            get_triggers(Some(agent_id), None).await,
        );
    }

    // Runtime/declared MCP list is owned by Ergatai: registry + convention scan.
    // The agent SDK's own MCP servers are surfaced separately as agentNativeMcp.
    let convention_mcp = fetch_convention_mcp_items(cwd_opt).await;
    let mut merged_mcp: Vec<Value> = Vec::new();

    // Ergatai registry MCP servers (user-configured, injected via ACP).
    // Status is probed by Ergatai itself (MCP initialize + tools/list), not
    // inferred from the enabled flag.
    let registry_servers = tokio::task::spawn_blocking(|| {
        crate::user_data_db::mcp_servers::list().unwrap_or_default()
    })
    .await
    .unwrap_or_default();

    // Probe all registry servers concurrently to avoid serial 5s timeouts.
    let mut probe_futures = Vec::new();
    for s in registry_servers {
        probe_futures.push(async move {
            let health = crate::services::mcp_health::check(&s).await;
            (s, health)
        });
    }
    let probe_results = futures::future::join_all(probe_futures).await;
    for (s, health) in probe_results {
        merged_mcp.push(json!({
            "name": s.name,
            "status": health.status,
            "tools": health.tools,
            "error": health.error,
            "config": {
                "type": s.server_type,
                "command": s.command,
                "args": s.args,
                "url": s.url,
            },
            "source": "registry",
            "group": "MCP",
            "type": "mcp",
            "targetTriggers": ["/"],
        }));
    }

    // Convention MCP configs (project/user .mcp.json, ~/.claude.json, codex config).
    merged_mcp = merge_mcp_items(merged_mcp, convention_mcp);
    if let Some(obj) = result.as_object_mut() {
        obj.insert("mcp".to_string(), json!(merged_mcp));
    }

    // MCP prompts are not surfaced as composer slash commands; MCP stays
    // model-driven (no @mcp / /mcp trigger in the composer).

    // Persistent cache: prefer last-known-good data when the live fetch is
    // degraded (e.g. agent suspended / not registered), so the UI keeps
    // showing the previously discovered commands/MCP instead of going empty.
    let live_commands_empty = result
        .get("commands")
        .and_then(|v| v.as_array())
        .map(|a| a.is_empty())
        .unwrap_or(true);
    let live_mcp_empty = result
        .get("mcp")
        .and_then(|v| v.as_array())
        .map(|a| a.is_empty())
        .unwrap_or(true);

    // Fill commands independently when the live fetch came back empty, so a
    // non-empty MCP list (e.g. registry servers) does not mask missing commands.
    if live_commands_empty {
        if let Some(cached) = load_persistent(agent_id, profile_name.as_deref(), cwd_opt) {
            if let Some(arr) = cached.get("commands").cloned() {
                if arr.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                    if let Some(obj) = result.as_object_mut() {
                        obj.insert("commands".to_string(), arr);
                    }
                }
            }
        }
    }

    if live_commands_empty && live_mcp_empty {
        if let Some(cached) = load_persistent(agent_id, profile_name.as_deref(), cwd_opt) {
            // Fill empty fields from the cached (last good) result.
            for field in ["mcp", "models"] {
                let cached_arr = cached.get(field).cloned();
                if let Some(arr) = cached_arr {
                    if arr.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                        result[field] = arr;
                    }
                }
            }
        }
    }

    // Persist rich results (commands present OR mcp present) for future degraded runs.
    let result_commands_empty = result
        .get("commands")
        .and_then(|v| v.as_array())
        .map(|a| a.is_empty())
        .unwrap_or(true);
    let result_mcp_empty = result
        .get("mcp")
        .and_then(|v| v.as_array())
        .map(|a| a.is_empty())
        .unwrap_or(true);
    if !(result_commands_empty && result_mcp_empty) {
        save_persistent(agent_id, profile_name.as_deref(), cwd_opt, &result);
    }

    // Background revalidation for stale sources.
    if !stale_sources.is_empty() {
        let stale = stale_sources;
        let kind_owned = kind.to_string();
        let agent_id_owned = agent_id.to_string();
        let cwd_owned = resolved_cwd.clone();
        let scoped_kind_owned: Option<String> = if kind_owned.is_empty() {
            None
        } else {
            Some(kind_owned.clone())
        };
        tokio::spawn(async move {
            for source in stale {
                let scoped_ref = scoped_kind_owned.as_deref();
                let _ = fetch_source_dedup(
                    source,
                    &kind_owned,
                    &agent_id_owned,
                    cwd_owned.as_deref(),
                    scoped_ref,
                )
                .await;
            }
        });
    }

    tracing::debug!(
        agent_id = %agent_id,
        elapsed_ms = %started.elapsed().as_millis(),
        "discovery completed"
    );
    result
}

// ---------------------------------------------------------------------------
// Static discovery (no agent required)
// ---------------------------------------------------------------------------

/// Static discovery: returns filesystem-based sources (skills, plugins, agents)
/// plus SDK-provided commands/built-in agents. Does not require an agent_id —
/// usable in new-chat / no-agent scenarios.
///
/// Cache keys for static sources use `{source}::{kind}::{cwd}` format.
pub async fn discover_static(cwd: Option<&str>, agent_kind: Option<&str>, refresh: bool) -> Value {
    let started = Instant::now();
    let cwd_opt = cwd;
    // Accept aliases such as `claude-code` / `Claude Code` and use the same
    // canonical kind for cache scoping and convention scans.
    let normalized_kind = normalize_agent_kind(agent_kind.unwrap_or(""));
    let agent_kind_opt: Option<&str> = if normalized_kind.is_empty() {
        None
    } else {
        Some(normalized_kind)
    };

    if refresh {
        // Invalidate static entries for this cwd + agent_kind.
        with_cache(|cache| {
            cache.results.retain(|k, _| {
                let parts: Vec<&str> = k.splitn(3, "::").collect();
                let source = parts.first().copied().unwrap_or("");
                if !is_static_source(source) {
                    return true; // keep runtime entries
                }
                let (entry_kind, entry_cwd) = if parts.len() == 2 {
                    (None, parts[1])
                } else if parts.len() == 3 {
                    (Some(parts[1]), parts[2])
                } else {
                    return true;
                };
                if entry_cwd != cwd_opt.unwrap_or("") {
                    return true; // keep other cwd
                }
                // target None => invalidate all agent kinds for this cwd
                if agent_kind_opt.is_none() {
                    return false;
                }
                // otherwise invalidate only matching kind
                entry_kind != agent_kind_opt
            });
            cache.in_flight.retain(|k, _| {
                let parts: Vec<&str> = k.splitn(3, "::").collect();
                let source = parts.first().copied().unwrap_or("");
                if !is_static_source(source) {
                    return true;
                }
                let (entry_kind, entry_cwd) = if parts.len() == 2 {
                    (None, parts[1])
                } else if parts.len() == 3 {
                    (Some(parts[1]), parts[2])
                } else {
                    return true;
                };
                if entry_cwd != cwd_opt.unwrap_or("") {
                    return true;
                }
                if agent_kind_opt.is_none() {
                    return false;
                }
                entry_kind != agent_kind_opt
            });
        });
    }

    let static_sources = [SRC_CONVENTION_SKILLS, SRC_PLUGINS];
    let mut fresh_values: HashMap<&str, Value> = HashMap::new();

    for &source in &static_sources {
        let key = cache_key(source, "", cwd_opt, agent_kind_opt);
        match check_cache(&key) {
            CacheStatus::Fresh(v) | CacheStatus::Stale(v) => {
                fresh_values.insert(source, v);
            }
            CacheStatus::Miss => {
                let value = fetch_source(source, "", "", cwd_opt, agent_kind_opt).await;
                if value.get("error").and_then(|v| v.as_str()).is_none() {
                    cache_set(&key, value.clone());
                }
                fresh_values.insert(source, value);
            }
        }
    }

    let skills = fresh_values
        .get(SRC_CONVENTION_SKILLS)
        .cloned()
        .unwrap_or_else(|| json!([]));
    let plugins = fresh_values
        .get(SRC_PLUGINS)
        .cloned()
        .unwrap_or_else(|| json!([]));

    // Static discovery can still surface Claude's SDK-provided slash commands
    // even without a running agent session.
    let sdk_bundle = if normalized_kind == "claude" {
        Some(crate::services::agent_sdk_service::discover("claude", cwd_opt).await)
    } else {
        None
    };

    let static_commands: Vec<Value> = sdk_bundle
        .as_ref()
        .and_then(|sdk| sdk.get("commands"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut c| {
            // normalize targetTriggers/group/source
            if c.get("type").is_none() {
                c["type"] = json!("command");
            }
            if c.get("targetTriggers").is_none() {
                c["targetTriggers"] = json!(["/"]);
            }
            if c.get("group").is_none() {
                c["group"] = json!("Commands");
            }
            if c.get("source").is_none() {
                c["source"] = json!("agent-sdk");
            }
            c
        })
        .collect();

    // Include convention + registry MCP in static discovery so @ can show MCP
    // without a running agent session (project .mcp.json, ~/.claude.json, codex config, registry).
    let mut mcp: Vec<Value> = fetch_convention_mcp_items(cwd_opt).await;
    if let Ok(registry_mcp) = tokio::task::spawn_blocking(|| -> Vec<Value> {
        crate::user_data_db::mcp_servers::list()
            .unwrap_or_default()
            .into_iter()
            .map(|s| {
                json!({
                    "name": s.name,
                    "status": if s.enabled { "pending" } else { "failed" },
                    "config": {
                        "type": s.server_type,
                        "command": s.command,
                        "args": s.args,
                        "url": s.url,
                    },
                    "source": "registry",
                    "group": "MCP",
                    "type": "mcp",
                    "targetTriggers": ["/"],
                })
            })
            .collect()
    })
    .await
    {
        mcp = merge_mcp_items(mcp, registry_mcp);
    }

    tracing::debug!(
        elapsed_ms = %started.elapsed().as_millis(),
        "static discovery completed"
    );

    let mut static_agents = fetch_convention_agents(normalized_kind, cwd_opt).await;
    dedup_by_name(&mut static_agents, "name");

    json!({
        "skills": skills,
        "commands": static_commands,
        "plugins": plugins,
        "mcp": mcp,
        "agents": static_agents,
        "triggers": get_triggers(None, cwd_opt).await,
    })
}

// ---------------------------------------------------------------------------
// Trigger registry
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct AgentTriggerContext {
    discovery_triggers_json: Option<String>,
    agent_kind: String,
}

async fn resolve_agent_trigger_context(agent_id: &str) -> Option<AgentTriggerContext> {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    let agent_info = runtime.get_agent(agent_id).await?;
    let profile_name = agent_info.profile;

    let mut discovery_triggers_json = None;
    let mut agent_kind = String::new();
    if let Some(pn) = profile_name {
        let (kind, triggers) = tokio::task::spawn_blocking(move || {
            let mut kind = String::new();
            let mut triggers = None;
            if let Ok(reg) = crate::services::profile_service::get_profile_registry() {
                if let Ok(profiles) = reg.list_with_status() {
                    if let Some(p) = profiles.into_iter().find(|x| x.name == pn) {
                        kind = match crate::services::agent::resolve_kind_parts(
                            &p.name,
                            &p.command,
                            &p.agent_type,
                        ) {
                            crate::services::agent::AgentKind::OpenCode => "opencode".to_string(),
                            crate::services::agent::AgentKind::Codex => "codex".to_string(),
                            crate::services::agent::AgentKind::Claude => "claude".to_string(),
                            crate::services::agent::AgentKind::Unknown => String::new(),
                        };
                        triggers = p.discovery_triggers_json.clone();
                    }
                }
            }
            (kind, triggers)
        })
        .await
        .unwrap_or_default();
        agent_kind = kind;
        discovery_triggers_json = triggers;
    }

    Some(AgentTriggerContext {
        discovery_triggers_json,
        agent_kind,
    })
}

fn default_trigger_types_for_kind(
    agent_kind: &str,
    is_static: bool,
) -> (Vec<&'static str>, Vec<&'static str>) {
    if is_static {
        // Static discovery only provides convention files/folders (and files handled by UI).
        // Skills/plugins are not surfaced as composer mentions.
        return (vec![], vec!["file", "folder"]);
    }

    match agent_kind {
        // Claude Code: @ 只引用文件/目录；子代理由 Task 工具调用，没有提示词入口
        "claude" => (vec!["command"], vec!["file", "folder"]),
        // Codex: @ 引用文件/agent 资源；/ 为控制指令；skill 通过 $skill-name（独立触发）
        "codex" => (vec!["command"], vec!["file", "folder", "agent"]),
        // OpenCode: @ 只引用文件/目录；子代理由 subagent 工具调用，没有提示词入口
        "opencode" => (vec!["command"], vec!["file", "folder"]),
        // Fallback: keep slash for commands, mentions for resources.
        _ => (vec!["command"], vec!["agent", "file", "folder"]),
    }
}

/// Returns the registered triggers for the editor.
///
/// When `agent_id` is provided, returns triggers with types resolved from the agent/profile
/// (or per-agent-kind defaults). Without `agent_id`, returns static defaults.
///
/// Schema: `char`, `position`, `types` — `allowSpaces`/`maxLength` removed (not needed).
pub async fn get_triggers(agent_id: Option<&str>, _cwd: Option<&str>) -> Value {
    let (slash_types, mention_types, is_static, custom_discovery_json): (
        Vec<&str>,
        Vec<&str>,
        bool,
        Option<String>,
    ) = if let Some(aid) = agent_id {
        let ctx = resolve_agent_trigger_context(aid).await;
        let kind = ctx.as_ref().map(|c| c.agent_kind.as_str()).unwrap_or("");
        let (slash, mention) = default_trigger_types_for_kind(kind, false);
        let custom = ctx.and_then(|c| c.discovery_triggers_json);
        (slash, mention, false, custom)
    } else {
        let (slash, mention) = default_trigger_types_for_kind("", true);
        (slash, mention, true, None)
    };

    let mut triggers = vec![
        serde_json::json!({
            "char": "/",
            "position": "start-of-line",
            "types": slash_types,
            "kind": "slash",
        }),
        serde_json::json!({
            "char": "@",
            "position": "standalone",
            "types": mention_types,
            "kind": "mention",
        }),
        serde_json::json!({
            "char": "$",
            "position": "standalone",
            "types": ["skill"],
            "kind": "mention",
        }),
    ];

    // Agent-specific discovery triggers (only when agent is present).
    if agent_id.is_some() {
        if let Some(custom) = custom_discovery_json {
            if let Ok(parsed) = serde_json::from_str::<Vec<serde_json::Value>>(&custom) {
                for item in parsed {
                    // Validate minimal shape: must have char.
                    if item.get("char").and_then(|v| v.as_str()).is_none() {
                        continue;
                    }
                    // Prevent overriding default chars.
                    let ch = item.get("char").and_then(|v| v.as_str()).unwrap();
                    if ch == "/" || ch == "@" || ch == "$" {
                        continue;
                    }
                    // Apply defaults when fields are omitted.
                    let mut t = item.clone();
                    if let Some(obj) = t.as_object_mut() {
                        obj.entry("kind").or_insert(serde_json::json!("mention"));
                        if !obj.contains_key("position") {
                            obj.insert("position".to_string(), serde_json::json!("standalone"));
                        }
                        if !obj.contains_key("types") {
                            // Agent-provided custom triggers: default to full mentionable/command set.
                            obj.insert(
                                "types".to_string(),
                                serde_json::json!(["command", "agent", "file", "folder"]),
                            );
                        }
                    }
                    triggers.push(t);
                }
            }
        }
    }

    let _ = is_static;
    serde_json::Value::Array(triggers)
}

// ---------------------------------------------------------------------------
// Plugins scan (Claude marketplace)
// ---------------------------------------------------------------------------

/// Public wrapper for plugins scan (used by frontend tRPC endpoint).
pub fn list_plugins() -> Vec<Value> {
    scan_plugins()
}

fn scan_plugins() -> Vec<Value> {
    let mut out = Vec::new();
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let marketplaces_dir = std::path::PathBuf::from(&home)
        .join(".claude")
        .join("plugins")
        .join("marketplaces");
    let entries = match std::fs::read_dir(&marketplaces_dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let marketplace = entry.file_name().to_string_lossy().to_string();
        let mj = entry.path().join(".claude-plugin").join("marketplace.json");
        let alt = entry.path().join("marketplace.json");
        let path = if mj.exists() {
            mj
        } else if alt.exists() {
            alt
        } else {
            continue;
        };
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let parsed: Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let plugins = parsed
            .get("plugins")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for p in plugins {
            out.push(json!({
                "name": p.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                "version": p.get("version").and_then(|v| v.as_str()).unwrap_or(""),
                "description": p.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                "path": entry.path().to_string_lossy(),
                "source": format!("marketplace:{}", p.get("name").and_then(|v| v.as_str()).unwrap_or("")),
                "marketplace": marketplace,
                "category": p.get("category").and_then(|v| v.as_str()),
                "homepage": p.get("homepage").and_then(|v| v.as_str()),
                "tags": p.get("tags").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
            }));
        }
    }

    dedup_by_name(&mut out, "name");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_key_generation() {
        // Runtime sources include agent_id
        let key = cache_key("sdk_bundle", "agent-123", Some("/path/to/work"), None);
        assert_eq!(key, "sdk_bundle::agent-123::/path/to/work");

        let key_acp = cache_key("acp_commands", "agent-123", Some("/path"), None);
        assert_eq!(key_acp, "acp_commands::agent-123::/path");

        // Static sources omit agent_id (shared across agents)
        let key_static = cache_key(
            "convention_skills",
            "agent-123",
            Some("/path/to/work"),
            None,
        );
        assert_eq!(key_static, "convention_skills::/path/to/work");

        let key_plugins = cache_key("plugins", "agent-456", Some("/path"), None);
        assert_eq!(key_plugins, "plugins::/path");

        // Static without cwd
        let key_no_cwd = cache_key("plugins", "agent-456", None, None);
        assert_eq!(key_no_cwd, "plugins::");

        // Runtime without cwd
        let key_runtime_no_cwd = cache_key("sdk_bundle", "agent-789", None, None);
        assert_eq!(key_runtime_no_cwd, "sdk_bundle::agent-789::");
    }

    #[test]
    fn test_source_ttl_mapping() {
        assert_eq!(source_ttl(SRC_CONVENTION_SKILLS), Duration::from_secs(300));
        assert_eq!(source_ttl(SRC_SDK_BUNDLE), Duration::from_secs(30));
        assert_eq!(source_ttl(SRC_ACP_COMMANDS), Duration::from_secs(60));
        assert_eq!(source_ttl(SRC_PLUGINS), Duration::from_secs(3600));
        // Unknown source falls back to SDK_BUNDLE_TTL
        assert_eq!(source_ttl("unknown"), Duration::from_secs(30));
    }

    #[test]
    fn test_resolve_agent_kind() {
        assert_eq!(resolve_agent_kind(Some("opencode"), None), "opencode");
        assert_eq!(resolve_agent_kind(None, Some("/usr/bin/codex")), "codex");
        assert_eq!(resolve_agent_kind(Some("Claude Code"), None), "claude");
        assert_eq!(resolve_agent_kind(None, None), "");
        assert_eq!(resolve_agent_kind(Some("foo"), Some("bar")), "");
    }

    #[test]
    fn test_is_static_source() {
        assert!(is_static_source(SRC_CONVENTION_SKILLS));
        assert!(is_static_source(SRC_PLUGINS));
        assert!(!is_static_source(SRC_SDK_BUNDLE));
        assert!(!is_static_source(SRC_ACP_COMMANDS));
    }

    #[test]
    fn test_dedup_by_name() {
        let mut items = vec![
            json!({"name": "skill-a", "description": "first"}),
            json!({"name": "skill-b", "description": "second"}),
            json!({"name": "skill-a", "description": "duplicate"}),
            json!({"name": "", "description": "empty name kept"}),
        ];

        dedup_by_name(&mut items, "name");

        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["name"], "skill-a");
        assert_eq!(items[0]["description"], "first"); // First occurrence kept
        assert_eq!(items[1]["name"], "skill-b");
        assert_eq!(items[2]["name"], ""); // Empty names are kept
    }

    #[test]
    fn test_merge_sources_error_propagation() {
        let sdk_with_error = json!({
            "skills": [{"name": "test-skill", "source": "agent-sdk"}],
            "commands": [],
            "mcp": [],
            "error": "SDK connection failed"
        });

        let result = merge_sources(
            "test-agent",
            "claude",
            &json!([]),
            &sdk_with_error,
            &json!([]),
            &json!([]),
        );

        assert!(result.get("errors").is_some());
        let errors = result["errors"].as_array().unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0]["source"], "agent-sdk");
        assert_eq!(errors[0]["message"], "SDK connection failed");
    }

    #[test]
    fn test_merge_sources_no_error() {
        let sdk_success = json!({
            "skills": [{"name": "test-skill"}],
            "commands": [],
            "mcp": [],
        });

        let result = merge_sources(
            "test-agent",
            "claude",
            &json!([]),
            &sdk_success,
            &json!([]),
            &json!([]),
        );

        assert!(result.get("errors").is_some());
        let errors = result["errors"].as_array().unwrap();
        assert_eq!(errors.len(), 0); // No errors when SDK succeeds
    }

    #[test]
    fn test_merge_sources_dedup() {
        let convention = json!([
            {"name": "shared-skill", "source": "convention"},
            {"name": "unique-conv", "source": "convention"}
        ]);
        let sdk = json!({
            "skills": [
                {"name": "shared-skill", "source": "agent-sdk"}, // Duplicate
                {"name": "unique-sdk", "source": "agent-sdk"}
            ]
        });

        let result = merge_sources(
            "test-agent",
            "claude",
            &convention,
            &sdk,
            &json!([]),
            &json!([]),
        );
        let skills = result["skills"].as_array().unwrap();

        // Should have 3 unique skills (shared-skill deduped)
        assert_eq!(skills.len(), 3);
        let names: Vec<&str> = skills.iter().filter_map(|s| s["name"].as_str()).collect();
        assert!(names.contains(&"shared-skill"));
        assert!(names.contains(&"unique-conv"));
        assert!(names.contains(&"unique-sdk"));
    }

    #[tokio::test]
    async fn test_cache_status_fresh() {
        // Set up cache with a fresh entry
        let key = "sdk_bundle::test-agent::";
        cache_set(key, json!({"test": "data"}));

        let status = check_cache(key);
        assert!(matches!(status, CacheStatus::Fresh(_)));
    }

    #[tokio::test]
    async fn test_invalidate_agent() {
        // Set up cache entries — static sources use new key format (no agent_id)
        cache_set("sdk_bundle::agent-1::/path1", json!({"a": 1}));
        cache_set("sdk_bundle::agent-2::/path2", json!({"b": 2}));
        cache_set("plugins::/path1", json!({"c": 3})); // static: shared across agents

        // Invalidate agent-1 at /path1
        invalidate_agent("agent-1", Some("/path1"));

        // agent-1 runtime entries should be gone
        assert!(matches!(
            check_cache("sdk_bundle::agent-1::/path1"),
            CacheStatus::Miss
        ));

        // agent-2 runtime entries should still be there
        assert!(matches!(
            check_cache("sdk_bundle::agent-2::/path2"),
            CacheStatus::Fresh(_)
        ));

        // Static entry at /path1 is invalidated (cwd match)
        assert!(matches!(check_cache("plugins::/path1"), CacheStatus::Miss));
    }

    #[tokio::test]
    async fn test_static_cache_shared_across_agents() {
        // Two agents at the same cwd should share static cache entries
        let key_a = cache_key("convention_skills", "agent-a", Some("/workspace"), None);
        let key_b = cache_key("convention_skills", "agent-b", Some("/workspace"), None);
        assert_eq!(key_a, key_b); // Both produce "convention_skills::/workspace"

        cache_set(&key_a, json!([{"name": "shared-skill"}]));
        assert!(matches!(check_cache(&key_b), CacheStatus::Fresh(_)));
    }

    #[tokio::test]
    async fn test_get_triggers_skill_not_in_slash_or_mention() {
        // Static (no agent): slash types empty, mention types exclude "skill".
        let static_triggers = get_triggers(None, None).await;
        let arr = static_triggers.as_array().expect("triggers array");
        for t in arr {
            let ch = t.get("char").and_then(|v| v.as_str()).unwrap_or("");
            let types: Vec<&str> = t
                .get("types")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
                .unwrap_or_default();
            if ch == "/" || ch == "@" {
                assert!(
                    !types.contains(&"skill"),
                    "{} trigger must not include skill (routes to $)",
                    ch
                );
            }
        }

        // Note: agent-aware path requires initialized AppContext (not available in
        // unit tests); covered by integration tests instead. The static path plus
        // default_trigger_types_for_kind already encodes the "skill -> $" rule.
    }

    #[test]
    fn test_normalize_agent_kind_accepts_aliases() {
        // Static discovery used to receive the UI provider id (`claude-code`)
        // and match it against only the literal `claude`, returning no agents.
        assert_eq!(normalize_agent_kind("claude-code"), "claude");
        assert_eq!(normalize_agent_kind("Claude Code"), "claude");
        assert_eq!(normalize_agent_kind("/usr/local/bin/claude"), "claude");
        assert_eq!(normalize_agent_kind("codex-cli"), "codex");
        assert_eq!(normalize_agent_kind("opencode acp"), "opencode");
        assert_eq!(normalize_agent_kind("custom-agent"), "");

        assert!(agent_scan_kinds("claude-code").is_empty());
        // OpenCode subagents are subagent-tool driven, not @-addressed.
        assert!(agent_scan_kinds("opencode").is_empty());
        assert_eq!(agent_scan_kinds(""), vec!["codex"]);
    }

    #[test]
    fn test_parse_agent_frontmatter_block_description() {
        let content = "---\nname: reviewer\ndescription: >\n  Reviews changes\n  for regressions\n---\nbody\n";
        let (name, description) = parse_agent_frontmatter(content);
        assert_eq!(name.as_deref(), Some("reviewer"));
        assert_eq!(
            description.as_deref(),
            Some("Reviews changes for regressions")
        );
    }

    #[test]
    fn test_scan_markdown_agents_nested_paths() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("agents");
        std::fs::create_dir_all(root.join("team")).unwrap();
        std::fs::write(
            root.join("reviewer.md"),
            "---\ndescription: Reviews code\n---\nbody",
        )
        .unwrap();
        std::fs::write(
            root.join("team").join("helper.md"),
            "---\ndescription: Helps the team\n---\nbody",
        )
        .unwrap();
        std::fs::write(
            root.join("team").join("planner.md"),
            "---\nname: planner-x\ndescription: Plans work\n---\nbody",
        )
        .unwrap();

        let mut out = Vec::new();
        let mut seen = HashSet::new();
        scan_markdown_agents(&root, &root, "convention", true, &mut out, &mut seen, 0);

        let names: Vec<&str> = out
            .iter()
            .filter_map(|v| v.get("name").and_then(|n| n.as_str()))
            .collect();
        assert!(names.contains(&"reviewer"));
        assert!(names.contains(&"team/helper"));
        assert!(names.contains(&"planner-x"));
    }

    #[test]
    fn test_classify_acp_commands_splits_skills_and_commands() {
        let input = serde_json::json!([
            { "name": "$arkcli-agent", "description": "skill desc" },
            { "name": "arkcli-agent", "description": "command desc" },
            { "name": "$byted-web-search", "description": "search skill" },
            { "name": "skills", "description": "list skills" }
        ]);

        let (skills, commands) = classify_acp_commands_default(&input);

        let skill_names: Vec<&str> = skills
            .iter()
            .filter_map(|v| v.get("name").and_then(|n| n.as_str()))
            .collect();
        let command_names: Vec<&str> = commands
            .iter()
            .filter_map(|v| v.get("name").and_then(|n| n.as_str()))
            .collect();

        assert_eq!(skill_names, vec!["arkcli-agent", "byted-web-search"]);
        assert_eq!(command_names, vec!["arkcli-agent", "skills"]);
    }
}
