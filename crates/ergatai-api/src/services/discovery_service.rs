use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
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
            if age < ttl {
                CacheStatus::Fresh(entry.value.clone())
            } else if age < ttl * REVALIDATE_WINDOW_FACTOR {
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
fn invalidate_agent(agent_id: &str, cwd: Option<&str>) {
    let cwd_str = cwd.unwrap_or("");
    with_cache(|cache| {
        cache.results.retain(|k, _| {
            // Try runtime format first: `{source}::{agent_id}::{cwd}`
            let mut parts = k.splitn(3, "::");
            let source = parts.next().unwrap_or("");
            let second = parts.next().unwrap_or("");
            let third = parts.next().unwrap_or("");

            if is_static_source(source) {
                // Static key: `{source}::{cwd}` — second is cwd
                second != cwd_str
            } else {
                // Runtime key: `{source}::{agent_id}::{cwd}` — second is agent_id, third is cwd
                !(second == agent_id && third == cwd_str)
            }
        });
        // Drop any in-flight handles for the same agent so refresh starts clean.
        cache.in_flight.retain(|k, _| {
            let mut parts = k.splitn(3, "::");
            let source = parts.next().unwrap_or("");
            let second = parts.next().unwrap_or("");
            let third = parts.next().unwrap_or("");

            if is_static_source(source) {
                second != cwd_str
            } else {
                !(second == agent_id && third == cwd_str)
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
    let hay = format!("{} {}", profile.unwrap_or(""), command.unwrap_or("")).to_lowercase();
    if hay.contains("opencode") {
        "opencode"
    } else if hay.contains("codex") {
        "codex"
    } else if hay.contains("claude") {
        "claude"
    } else {
        ""
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

    let profile_name = agent_info.as_ref().and_then(|i| i.profile.clone());

    // Resolve agent kind via profile registry (agent_type/command), fallback to name contains.
    // Profile registry access can touch disk/DB, so run it off the async executor.
    let mut kind = String::new();
    if let Some(pn) = profile_name.clone() {
        let resolved = tokio::task::spawn_blocking(move || {
            let mut kind = String::new();
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

async fn fetch_convention_skills(cwd: Option<&str>, agent_kind: Option<&str>) -> Value {
    let cwd_owned = cwd.map(|s| s.to_string());
    let agent_kind_owned = agent_kind.map(|s| s.to_string());
    let skills = tokio::task::spawn_blocking(move || {
        crate::services::skills_service::list_skills(
            cwd_owned.as_deref(),
            agent_kind_owned.as_deref(),
        )
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
                        "group": "Commands",
                    })
                })
                .collect(),
            _ => vec![],
        };
    json!(commands)
}

async fn fetch_sdk_bundle(kind: &str, cwd: Option<&str>) -> Value {
    crate::services::agent_sdk_service::discover(kind, cwd).await
}

async fn fetch_plugins() -> Value {
    let plugins = tokio::task::spawn_blocking(scan_plugins)
        .await
        .unwrap_or_default();
    json!(plugins)
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

fn merge_sources(
    _agent_id: &str,
    convention_skills: &Value,
    sdk_bundle: &Value,
    acp_commands: &Value,
    plugins: &Value,
) -> Value {
    let mut errors: Vec<Value> = Vec::new();

    // Skills: convention + SDK
    let mut skills: Vec<Value> = convention_skills.as_array().cloned().unwrap_or_default();
    for s in &mut skills {
        if s.get("group").is_none() {
            s["group"] = json!("Skills");
        }
    }
    if let Some(arr) = sdk_bundle.get("skills").and_then(|v| v.as_array()) {
        for s in arr {
            let mut s = s.clone();
            if s.get("source").is_none() {
                s["source"] = json!("agent-sdk");
            }
            if s.get("group").is_none() {
                s["group"] = json!("Skills");
            }
            skills.push(s);
        }
    }
    dedup_by_name(&mut skills, "name");

    // Commands: ACP + SDK
    let mut commands: Vec<Value> = acp_commands.as_array().cloned().unwrap_or_default();
    for c in &mut commands {
        if c.get("group").is_none() {
            c["group"] = json!("Commands");
        }
    }
    if let Some(arr) = sdk_bundle.get("commands").and_then(|v| v.as_array()) {
        for c in arr {
            let mut c = c.clone();
            if c.get("source").is_none() {
                c["source"] = json!("agent-sdk");
            }
            if c.get("group").is_none() {
                c["group"] = json!("Commands");
            }
            commands.push(c);
        }
    }
    dedup_by_name(&mut commands, "name");

    // MCP: from SDK only
    let mut mcp: Vec<Value> = sdk_bundle
        .get("mcp")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for m in &mut mcp {
        if m.get("group").is_none() {
            m["group"] = json!("MCP");
        }
    }
    // MCP fallback from registry also gets category
    // (handled at merge end? set here for registry items in discovery.rs)

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

    let mut scan_plugins = scan_plugins;
    for p in &mut scan_plugins {
        if p.get("group").is_none() {
            p["group"] = json!("Plugins");
        }
    }
    let mut plugins: Vec<Value> = scan_plugins;
    if let Some(arr) = sdk_bundle.get("plugins").and_then(|v| v.as_array()) {
        for p in arr {
            let mut p = p.clone();
            if p.get("source").is_none() {
                p["source"] = json!("agent-sdk");
            }
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
            if p.get("group").is_none() {
                p["group"] = json!("Plugins");
            }
            plugins.push(p);
        }
    }
    dedup_by_name(&mut plugins, "name");

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
        "plugins": plugins,
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
        .unwrap_or_else(|_| {
            // Fall back to user data dir if available, else temp.
            std::env::var("HOME")
                .map(|h| PathBuf::from(h).join(".ergatai"))
                .unwrap_or_else(|_| std::env::temp_dir().join("ergatai"))
        });
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

fn load_persistent(agent_id: &str, profile_name: Option<&str>, cwd: Option<&str>) -> Option<Value> {
    let path = persistent_cache_path();
    let content = std::fs::read_to_string(&path).ok()?;
    let parsed: Value = serde_json::from_str(&content).ok()?;

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

    // refresh=1 → invalidate all cached sources for this agent.
    if refresh {
        invalidate_agent(agent_id, cwd_opt);
    }

    // Classify each source as Fresh / Stale / Miss.
    let mut fresh_values: HashMap<&str, Value> = HashMap::new();
    let mut stale_sources: Vec<&str> = Vec::new();
    let mut miss_sources: Vec<&str> = Vec::new();

    for &source in ALL_SOURCES {
        let key = cache_key(source, agent_id, cwd_opt, None);
        match check_cache(&key) {
            CacheStatus::Fresh(v) => {
                fresh_values.insert(source, v);
            }
            CacheStatus::Stale(v) => {
                fresh_values.insert(source, v);
                stale_sources.push(source);
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
                        fresh_values.insert(source, cached);
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
        let value = fetch_source_dedup(source, kind, agent_id, cwd_opt, None).await;
        fresh_values.insert(source, value);
    }

    // Assemble the merged result from whatever we have.
    let mut result = merge_sources(
        agent_id,
        fresh_values
            .get(SRC_CONVENTION_SKILLS)
            .unwrap_or(&json!([])),
        fresh_values.get(SRC_SDK_BUNDLE).unwrap_or(&json!({})),
        fresh_values.get(SRC_ACP_COMMANDS).unwrap_or(&json!([])),
        fresh_values.get(SRC_PLUGINS).unwrap_or(&json!([])),
    );

    // Populate triggers from agent-aware registry.
    if let Some(obj) = result.as_object_mut() {
        obj.insert(
            "triggers".to_string(),
            get_triggers(Some(agent_id), None).await,
        );
    }

    // MCP fallback: if SDK did not provide runtime MCP status, fall back to
    // Ergatai's own MCP server registry so the UI still has a usable list.
    let mcp_empty = result
        .get("mcp")
        .and_then(|v| v.as_array())
        .map(|a| a.is_empty())
        .unwrap_or(true);
    if mcp_empty {
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
                    })
                })
                .collect()
        })
        .await
        {
            if !registry_mcp.is_empty() {
                result["mcp"] = json!(registry_mcp);
            }
        }
    }

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

    if live_commands_empty && live_mcp_empty {
        if let Some(cached) = load_persistent(agent_id, profile_name.as_deref(), cwd_opt) {
            // Fill empty fields from the cached (last good) result.
            for field in ["commands", "mcp", "models"] {
                let cached_arr = cached.get(field).cloned();
                if let Some(arr) = cached_arr {
                    if arr.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                        result[field] = arr;
                    }
                }
            }
        }
    } else {
        // Rich result: persist for future degraded runs.
        save_persistent(agent_id, profile_name.as_deref(), cwd_opt, &result);
    }

    // Background revalidation for stale sources.
    if !stale_sources.is_empty() {
        let stale = stale_sources;
        let kind_owned = kind.to_string();
        let agent_id_owned = agent_id.to_string();
        let cwd_owned = resolved_cwd.clone();
        tokio::spawn(async move {
            for source in stale {
                let _ = fetch_source_dedup(
                    source,
                    &kind_owned,
                    &agent_id_owned,
                    cwd_owned.as_deref(),
                    None,
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

/// Static discovery: returns only filesystem-based sources (convention_skills + plugins).
/// Does not require an agent_id — usable in new-chat / no-agent scenarios.
///
/// Cache keys for static sources use `{source}::{cwd}` format, shared across agents.
pub async fn discover_static(cwd: Option<&str>, agent_kind: Option<&str>, refresh: bool) -> Value {
    let started = Instant::now();
    let cwd_opt = cwd;
    let agent_kind_opt = agent_kind;

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

    tracing::debug!(
        elapsed_ms = %started.elapsed().as_millis(),
        "static discovery completed"
    );

    json!({
        "skills": skills,
        "plugins": plugins,
        "triggers": get_triggers(None, cwd_opt).await,
    })
}

// ---------------------------------------------------------------------------
// Trigger registry
// ---------------------------------------------------------------------------

async fn resolve_agent_discovery_triggers(agent_id: &str) -> Option<String> {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    let agent_info = runtime.get_agent(agent_id).await?;
    let profile_name = agent_info.profile?;

    if let Ok(reg) = crate::services::profile_service::get_profile_registry() {
        if let Ok(Some(profile)) = reg.get_by_name(&profile_name).await {
            return profile.discovery_triggers_json;
        }
    }
    None
}

/// Returns the registered triggers for the editor.
///
/// When `agent_id` is provided, returns triggers with full types
/// (skill, command, mcp, plugin, agent, file, folder).
/// Without `agent_id`, returns static triggers (skill, plugin only).
///
/// Schema: `char`, `position`, `types` — `allowSpaces`/`maxLength` removed (not needed).
pub async fn get_triggers(agent_id: Option<&str>, _cwd: Option<&str>) -> Value {
    // Default triggers (always present).
    let full_types = vec![
        "skill", "command", "mcp", "plugin", "agent", "file", "folder",
    ];
    let static_types = vec!["skill", "plugin"];

    let (base_types, is_static) = if agent_id.is_some() {
        (full_types.clone(), false)
    } else {
        (static_types.clone(), true)
    };

    let mut triggers = vec![
        serde_json::json!({
            "char": "/",
            "position": "start-of-line",
            "types": base_types,
            "kind": "slash",
        }),
        serde_json::json!({
            "char": "@",
            "position": "standalone",
            "types": base_types,
            "kind": "mention",
        }),
    ];

    // Agent-specific discovery triggers (only when agent is present).
    if let Some(aid) = agent_id {
        let discovery_json = resolve_agent_discovery_triggers(aid).await;
        if let Some(custom) = discovery_json {
            if let Ok(parsed) = serde_json::from_str::<Vec<serde_json::Value>>(&custom) {
                for item in parsed {
                    // Validate minimal shape: must have char.
                    if item.get("char").and_then(|v| v.as_str()).is_none() {
                        continue;
                    }
                    // Prevent overriding default chars.
                    let ch = item.get("char").and_then(|v| v.as_str()).unwrap();
                    if ch == "/" || ch == "@" {
                        continue;
                    }
                    // Apply static type filtering when no agent? Already agent present here.
                    let mut t = item.clone();
                    if let Some(obj) = t.as_object_mut() {
                        obj.entry("kind").or_insert(serde_json::json!("mention"));
                        if !obj.contains_key("position") {
                            obj.insert("position".to_string(), serde_json::json!("standalone"));
                        }
                        if !obj.contains_key("types") {
                            obj.insert("types".to_string(), serde_json::json!(base_types));
                        }
                    }
                    triggers.push(t);
                }
            }
        }
    }

    // Static type filtering for no-agent case already applied via base_types.
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

        let result = merge_sources("test-agent", &convention, &sdk, &json!([]), &json!([]));
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
}
