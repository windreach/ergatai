use crate::services::profile_service::{ProfileModelDetail, ProfileModelSource};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

use super::source::SourceReading;

/// OpenCode server (`/api/model`). This is the authoritative full catalogue when
/// the OpenCode background service is available.
pub async fn read_sdk(cwd: Option<&str>) -> SourceReading {
    let sdk = crate::services::agent_sdk_service::discover("opencode", cwd).await;
    if let Some(error) = sdk.get("error").and_then(Value::as_str) {
        return SourceReading::unavailable(ProfileModelSource::AgentSdk, error);
    }

    let default_model = sdk
        .get("default_model")
        .and_then(Value::as_str)
        .map(str::to_string);

    let details: Vec<ProfileModelDetail> = sdk
        .get("models")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let raw_id = m
                        .get("id")
                        .or_else(|| m.get("value"))
                        .or_else(|| m.get("name"))
                        .or_else(|| m.get("model"))
                        .and_then(Value::as_str)?
                        .trim();
                    if raw_id.is_empty() {
                        return None;
                    }
                    let provider = m
                        .get("provider")
                        .or_else(|| m.get("providerID"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    // ACP/config IDs are provider-qualified. Normalize the SDK
                    // list so the same model never appears twice and switching
                    // sends the value the agent actually accepts.
                    let id = if provider.is_empty() || raw_id.contains('/') {
                        raw_id.to_string()
                    } else {
                        format!("{provider}/{raw_id}")
                    };
                    let name = m
                        .get("name")
                        .or_else(|| m.get("displayName"))
                        .and_then(Value::as_str)
                        .unwrap_or(raw_id)
                        .to_string();
                    let description = m
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    Some(ProfileModelDetail {
                        id,
                        name,
                        description,
                        provider,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    if details.is_empty() {
        SourceReading::unavailable(
            ProfileModelSource::AgentSdk,
            "OpenCode server returned no models",
        )
    } else {
        SourceReading::success(ProfileModelSource::AgentSdk, details, None, default_model)
    }
}

/// Static models.dev catalogue cached by OpenCode. Used when the server is not
/// running. Only providers that are configured/authenticated are included so
/// the selector does not fill with unusable models.
pub fn read_models_dev_cache(cwd: Option<&str>) -> SourceReading {
    let Some(cache_path) = opencode_cache_path() else {
        return SourceReading::unavailable(
            ProfileModelSource::ModelsDevCache,
            "models.dev cache path unavailable",
        );
    };
    let Ok(raw) = fs::read_to_string(&cache_path) else {
        return SourceReading::unavailable(
            ProfileModelSource::ModelsDevCache,
            format!("cannot read {}", cache_path.display()),
        );
    };
    let Ok(catalog) = serde_json::from_str::<Value>(&raw) else {
        return SourceReading::unavailable(
            ProfileModelSource::ModelsDevCache,
            "models.dev cache is not valid JSON",
        );
    };
    let Some(providers) = catalog.as_object() else {
        return SourceReading::unavailable(
            ProfileModelSource::ModelsDevCache,
            "models.dev cache has unexpected shape",
        );
    };

    let connected = connected_provider_ids(providers, cwd);
    if connected.is_empty() {
        return SourceReading::unavailable(
            ProfileModelSource::ModelsDevCache,
            "no configured/authenticated providers in models.dev cache",
        );
    }

    let overrides = configured_model_overrides(cwd);
    let opencode_authed =
        env_is_set("OPENCODE_API_KEY") || auth_provider_ids().contains("opencode");

    let mut details = Vec::new();
    for (provider_id, provider) in providers {
        if !connected.contains(provider_id) {
            continue;
        }
        let provider_name = provider
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(provider_id)
            .to_string();
        let Some(models) = provider.get("models").and_then(Value::as_object) else {
            continue;
        };
        for (model_id, model) in models {
            // An explicit `provider.*.models` map in opencode.json(c) is an
            // override, not an addition: respect the user's chosen subset.
            if let Some(allowed) = overrides.get(provider_id) {
                if !allowed.contains(model_id) {
                    continue;
                }
            }
            // Without an OpenCode credential, only free Zen models are usable.
            if (provider_id == "opencode" || provider_id == "opencode-go")
                && !opencode_authed
                && !model_id.ends_with("-free")
                && model
                    .get("cost")
                    .and_then(|cost| cost.get("input"))
                    .and_then(Value::as_f64)
                    .unwrap_or(1.0)
                    > 0.0
            {
                continue;
            }
            let id = if model_id.contains('/') {
                model_id.clone()
            } else {
                format!("{provider_id}/{model_id}")
            };
            let name = model
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(model_id)
                .to_string();
            let description = model
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            details.push(ProfileModelDetail {
                id,
                name,
                description,
                provider: provider_name.clone(),
            });
        }
    }

    if details.is_empty() {
        SourceReading::unavailable(
            ProfileModelSource::ModelsDevCache,
            "models.dev cache has no models for connected providers",
        )
    } else {
        SourceReading::success(ProfileModelSource::ModelsDevCache, details, None, None)
    }
}

fn opencode_cache_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(dir) = dirs::cache_dir() {
        candidates.push(dir.join("opencode").join("models.json"));
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".cache").join("opencode").join("models.json"));
    }
    candidates
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .or_else(|| candidates.into_iter().next())
}

fn connected_provider_ids(
    providers: &serde_json::Map<String, Value>,
    cwd: Option<&str>,
) -> HashSet<String> {
    let mut connected = configured_provider_ids(cwd);

    for (provider_id, provider) in providers {
        let env_names = provider
            .get("env")
            .and_then(Value::as_array)
            .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>())
            .unwrap_or_default();
        if env_names.iter().any(|name| env_is_set(name)) {
            connected.insert(provider_id.clone());
        }
    }

    connected
}

fn configured_provider_ids(cwd: Option<&str>) -> HashSet<String> {
    let mut connected = HashSet::new();

    // Providers explicitly configured in opencode.json(c).
    for candidate in opencode_config_candidates(cwd) {
        let Ok(content) = fs::read_to_string(&candidate) else {
            continue;
        };
        let stripped = crate::services::model_file_reader::strip_json_comments(&content);
        let Ok(cfg) = serde_json::from_str::<Value>(&stripped) else {
            continue;
        };
        if let Some(providers) = cfg.get("provider").and_then(Value::as_object) {
            connected.extend(providers.keys().cloned());
        }
        if let Some(model) = cfg.get("model").and_then(Value::as_str) {
            if let Some((provider, _)) = model.split_once('/') {
                connected.insert(provider.to_string());
            }
        }
    }

    // Providers with credentials in OpenCode's auth store.
    connected.extend(auth_provider_ids());

    connected
}

fn auth_provider_ids() -> HashSet<String> {
    let auth_path = crate::services::native_agent_config::home_path(&[
        ".local",
        "share",
        "opencode",
        "auth.json",
    ]);
    let Ok(content) = fs::read_to_string(auth_path) else {
        return HashSet::new();
    };
    let Ok(auth) = serde_json::from_str::<Value>(&content) else {
        return HashSet::new();
    };
    auth.as_object()
        .map(|entries| entries.keys().cloned().collect())
        .unwrap_or_default()
}

/// Explicit model subsets declared in `provider.<id>.models`. Missing entries
/// mean "no override" (all catalogue models are allowed).
fn configured_model_overrides(cwd: Option<&str>) -> HashMap<String, HashSet<String>> {
    let mut overrides = HashMap::new();
    for candidate in opencode_config_candidates(cwd) {
        let Ok(content) = fs::read_to_string(&candidate) else {
            continue;
        };
        let stripped = crate::services::model_file_reader::strip_json_comments(&content);
        let Ok(cfg) = serde_json::from_str::<Value>(&stripped) else {
            continue;
        };
        let Some(providers) = cfg.get("provider").and_then(Value::as_object) else {
            continue;
        };
        for (provider_id, provider) in providers {
            let Some(models) = provider.get("models").and_then(Value::as_object) else {
                continue;
            };
            overrides.insert(provider_id.clone(), models.keys().cloned().collect());
        }
    }
    overrides
}

fn opencode_config_candidates(cwd: Option<&str>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("OPENCODE_CONFIG") {
        if !path.trim().is_empty() {
            candidates.push(PathBuf::from(path));
        }
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".config").join("opencode").join("opencode.json"));
        candidates.push(home.join(".config").join("opencode").join("opencode.jsonc"));
    }
    if let Some(cwd) = cwd {
        candidates.push(PathBuf::from(cwd).join("opencode.json"));
    }
    candidates
}

fn env_is_set(name: &str) -> bool {
    std::env::var(name)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

// Runtime model switching is performed in-process by the ACP agent.
// SDK-based runtime switching has been removed.

pub async fn discover(cwd: Option<&str>) -> serde_json::Value {
    crate::services::agent_sdk_service::discover("opencode", cwd).await
}

pub fn native_api_key() -> anyhow::Result<Option<String>> {
    use crate::services::native_agent_config;
    if let Some(path) = native_agent_config::opencode_config_path() {
        if let Ok(value) = native_agent_config::read_opencode_config(&path) {
            let provider_id = value
                .get("model")
                .and_then(|v| v.as_str())
                .and_then(|model| model.split('/').next())
                .map(str::to_string);
            let mut key = provider_id
                .as_deref()
                .and_then(|id| {
                    value
                        .get("provider")
                        .and_then(|v| v.get(id))
                        .and_then(|v| v.get("options"))
                        .and_then(|v| v.get("apiKey"))
                        .and_then(|v| v.as_str())
                })
                .map(str::to_string);
            if key.is_none() {
                if let Some(providers) = value.get("provider").and_then(|v| v.as_object()) {
                    for (_, provider) in providers {
                        if let Some(found) = provider
                            .get("options")
                            .and_then(|v| v.get("apiKey"))
                            .and_then(|v| v.as_str())
                        {
                            if !found.trim().is_empty() {
                                key = Some(found.to_string());
                                break;
                            }
                        }
                    }
                }
            }
            if let Some(key) = key {
                if !key.trim().is_empty() {
                    return Ok(Some(key));
                }
            }
        }
    }
    let auth_path = native_agent_config::home_path(&[".local", "share", "opencode", "auth.json"]);
    if auth_path.is_file() {
        let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(auth_path)?)?;
        if let Some(entry) = value.as_object() {
            if let Some((_, entry)) = entry.iter().next() {
                if let Some(key) = entry.get("api_key").and_then(|v| v.as_str()) {
                    return Ok(Some(key.to_string()));
                }
            }
        }
    }
    Ok(None)
}

pub fn detect_native_config(
) -> anyhow::Result<Option<crate::services::native_agent_config::NativeAgentConfig>> {
    use crate::services::native_agent_config;
    let path = match native_agent_config::opencode_config_path() {
        Some(path) => path,
        None => return Ok(None),
    };
    let value = native_agent_config::read_opencode_config(&path)?;

    let default_model = value
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let provider_id = default_model
        .as_deref()
        .and_then(|model| model.split('/').next())
        .map(str::to_string);
    let options = provider_id.as_deref().and_then(|id| {
        value
            .get("provider")
            .and_then(|v| v.get(id))
            .and_then(|v| v.get("options"))
    });
    let options = options.or_else(|| {
        value
            .get("provider")
            .and_then(|v| v.as_object())
            .and_then(|obj| obj.values().next())
            .and_then(|v| v.get("options"))
    });
    let base_url = options
        .and_then(|v| v.get("baseURL"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let has_api_key = options
        .and_then(|v| v.get("apiKey"))
        .and_then(|v| v.as_str())
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
        || native_agent_config::home_path(&[".local", "share", "opencode", "auth.json"]).is_file();

    Ok(Some(
        crate::services::native_agent_config::NativeAgentConfig {
            agent_id: "opencode".to_string(),
            protocol: "opencode".to_string(),
            source_path: path.to_string_lossy().to_string(),
            base_url: native_agent_config::trim_non_empty(base_url),
            default_model: native_agent_config::trim_non_empty(default_model),
            has_api_key,
        },
    ))
}

/// Agent-specific skill mention conversion rules.
/// OpenCode: skill mentions become `@name` mentions, which OpenCode resolves
/// to the matching skill (and loads it) in both CLI and ACP modes.
pub fn convert_skill_mentions(message: &str) -> String {
    use regex::Regex;
    let mut result = message.to_string();
    for trig in ["@", "$", "#"] {
        if let Ok(re) = Regex::new(&format!(r"{}\[(skill):([^\]]+)\]", regex::escape(trig))) {
            result = re
                .replace_all(&result, |caps: &regex::Captures| {
                    format!("@{}", caps.get(2).unwrap().as_str())
                })
                .to_string();
        }
    }
    result
}

/// Placeholder prompt text that OpenCode's `/init` expands to. The real text
/// will be supplied later; keep this constant as the single swap point.
pub const OPENCODE_INIT_PROMPT: &str = r###"Create or update  AGENTS.md  for this repository.

The goal is a compact instruction file that helps future OpenCode sessions avoid mistakes and ramp up quickly. Every line should answer: "Would an agent likely miss this without help?" If not, leave it out.

User-provided focus or constraints (honor these):

How to investigate

Read the highest-value sources first:

-  README* , root manifests, workspace config, lockfiles
- build, test, lint, formatter, typecheck, and codegen config
- CI workflows and pre-commit / task runner config
- existing instruction files ( AGENTS.md ,  CLAUDE.md ,  .cursor/rules/ ,  .cursorrules ,  .github/copilot-instructions.md )
- repo-local OpenCode config such as  opencode.json 

If architecture is still unclear after reading config and docs, inspect a small number of representative code files to find the real entrypoints, package boundaries, and execution flow. Prefer reading the files that explain how the system is wired together over random leaf files.

Prefer executable sources of truth over prose. If docs conflict with config or scripts, trust the executable source and only keep what you can verify.

What to extract

Look for the highest-signal facts for an agent working in this repo:

- exact developer commands, especially non-obvious ones
- how to run a single test, a single package, or a focused verification step
- required command order when it matters, such as  lint -> typecheck -> test 
- monorepo or multi-package boundaries, ownership of major directories, and the real app/library entrypoints
- framework or toolchain quirks: generated code, migrations, codegen, build artifacts, special env loading, dev servers, infra deploy flow
- testing quirks: fixtures, integration test prerequisites, snapshot workflows, required services, flaky or expensive suites
- important constraints from existing instruction files worth preserving

Good  AGENTS.md  content is usually hard-earned context that took reading multiple files to infer.

Questions

Only ask the user questions if the repo cannot answer something important. Use the  question  tool for one short batch at most.

Good questions:

- undocumented team conventions
- branch / PR / release expectations
- missing setup or test prerequisites that are known but not written down

Do not ask about anything the repo already makes clear.

Writing rules

Include only high-signal, repo-specific guidance such as:

- exact commands and shortcuts the agent would otherwise guess wrong
- architecture notes that are not obvious from filenames
- conventions that differ from language or framework defaults
- setup requirements, environment quirks, and operational gotchas
- references to existing instruction sources that matter

Exclude:

- generic software advice
- long tutorials or exhaustive file trees
- obvious language conventions
- speculative claims or anything you could not verify
- content better stored in another file referenced via  opencode.json   instructions 

When in doubt, omit.

Prefer short sections and bullets. If the repo is simple, keep the file simple. If the repo is large, summarize the few structural facts that actually change how an agent should work.

If  AGENTS.md  already exists at  /root/ergatai , improve it in place rather than rewriting blindly. Preserve verified useful guidance, delete fluff or stale claims, and reconcile it with the current codebase."###;

/// Placeholder prompt text that OpenCode's `/review` expands to. The real text
/// will be supplied later; keep this constant as the single swap point.
pub const OPENCODE_REVIEW_PROMPT: &str = r####"You are a code reviewer. Your job is to review code changes and provide actionable feedback.

---

Input:

---

## Determining What to Review

Based on the input provided, determine which type of review to perform:

1. **No arguments (default)**: Review all uncommitted changes
   - Run: `git diff` for unstaged changes
   - Run: `git diff --cached` for staged changes
   - Run: `git status --short` to identify untracked (net new) files

2. **Commit hash** (40-char SHA or short hash): Review that specific commit
   - Run: `git show <hash>`

3. **Branch name**: Compare current branch to the specified branch
   - Run: `git diff <branch>...HEAD`

4. **PR URL or number** (contains "github.com" or "pull" or looks like a PR number): Review the pull request
   - Run: `gh pr view <pr>` to get PR context
   - Run: `gh pr diff <pr>` to get the diff

Use best judgement when processing input.

---

## Gathering Context

**Diffs alone are not enough.** After getting the diff, read the entire file(s) being modified to understand the full context. Code that looks wrong in isolation may be correct given surrounding logic—and vice versa.

- Use the diff to identify which files changed
- Use `git status --short` to identify untracked files, then read their full contents
- Read the full file to understand existing patterns, control flow, and error handling
- Check for existing style guide or conventions files (CONVENTIONS.md, AGENTS.md, .editorconfig, etc.)

---

## What to Look For

**Bugs** - Your primary focus.
- Logic errors, off-by-one mistakes, incorrect conditionals
- If-else guards: missing guards, incorrect branching, unreachable code paths
- Edge cases: null/empty/undefined inputs, error conditions, race conditions
- Security issues: injection, auth bypass, data exposure
- Broken error handling that swallows failures, throws unexpectedly or returns error types that are not caught.

**Structure** - Does the code fit the codebase?
- Does it follow existing patterns and conventions?
- Are there established abstractions it should use but doesn't?
- Excessive nesting that could be flattened with early returns or extraction

**Performance** - Only flag if obviously problematic.
- O(n²) on unbounded data, N+1 queries, blocking I/O on hot paths

**Behavior Changes** - If a behavioral change is introduced, raise it (especially if it's possibly unintentional).

---

## Before You Flag Something

**Be certain.** If you're going to call something a bug, you need to be confident it actually is one.

- Only review the changes - do not review pre-existing code that wasn't modified
- Don't flag something as a bug if you're unsure - investigate first
- Don't invent hypothetical problems - if an edge case matters, explain the realistic scenario where it breaks
- If you need more context to be sure, use the tools below to get it

**Don't be a zealot about style.** When checking code against conventions:
- Verify the code is *actually* in violation. Don't complain about else statements if early returns are already being used correctly.
- Some "violations" are acceptable when they're the simplest option. A `let` statement is fine if the alternative is convoluted.
- Excessive nesting is a legitimate concern regardless of other style choices.

---

## Tools

Use these to inform your review:
- **Explore agent** - Find how existing code handles similar problems. Check patterns, conventions, and prior art before claiming something doesn't fit.
- **Available documentation and code-search tools** - Verify correct usage of libraries/APIs before flagging something as wrong.
- **Web Search** - Research best practices if you're unsure about a pattern.

If you're uncertain about something and can't verify it with these tools, say "I'm not sure about X" rather than flagging it as a definite issue.

---

## Output

1. If there is a bug, be direct and clear about why it is a bug.
2. Clearly communicate severity of issues. Do not overstate severity.
3. Critiques should clearly and explicitly communicate the scenarios, environments, or inputs that are necessary for the bug to arise. The comment should immediately indicate that the issue's severity depends on these factors.
4. Your tone should be matter-of-fact and not accusatory or overly positive. It should read as a helpful AI assistant suggestion without sounding too much like a human reviewer.
5. Write so the reader can quickly understand the issue without reading too closely.
6. AVOID flattery, do not give any comments that are not helpful to the reader.
"####;

/// Intercept OpenCode's `/init` slash command.
///
/// OpenCode ships no native `/init`, so Ergatai implements it here by
/// replacing a bare `/init` message with `OPENCODE_INIT_PROMPT`. Returns
/// `Some(replacement)` when the message is (after stripping an optional
/// working-directory note) exactly `/init`; otherwise `None`.
pub fn intercept_init(message: &str) -> Option<String> {
    // Split off an optional working-directory note prefix of the form
    // "[Working directory: ...]\nUse relative paths within this directory for all file operations.\n\n".
    let (prefix, core) = if let Some(idx) = message.find("\n\n") {
        let head = &message[..idx];
        if head.starts_with("[Working directory:") {
            (&message[..idx + 2], &message[idx + 2..])
        } else {
            ("", message)
        }
    } else {
        ("", message)
    };

    if core.trim() != "/init" {
        return None;
    }

    if prefix.is_empty() {
        Some(OPENCODE_INIT_PROMPT.to_string())
    } else {
        Some(format!("{}{}", prefix, OPENCODE_INIT_PROMPT))
    }
}

/// Intercept OpenCode's `/review` slash command.
///
/// Native `/review` returns empty in this environment, so Ergatai implements it
/// here by replacing a bare `/review` message with `OPENCODE_REVIEW_PROMPT`.
/// Returns `Some(replacement)` when the message is (after stripping an optional
/// working-directory note) exactly `/review`; otherwise `None`.
pub fn intercept_review(message: &str) -> Option<String> {
    let (prefix, core) = if let Some(idx) = message.find("\n\n") {
        let head = &message[..idx];
        if head.starts_with("[Working directory:") {
            (&message[..idx + 2], &message[idx + 2..])
        } else {
            ("", message)
        }
    } else {
        ("", message)
    };

    if core.trim() != "/review" {
        return None;
    }

    if prefix.is_empty() {
        Some(OPENCODE_REVIEW_PROMPT.to_string())
    } else {
        Some(format!("{}{}", prefix, OPENCODE_REVIEW_PROMPT))
    }
}

pub fn list_skills(cwd: Option<&str>) -> Vec<crate::services::skills_service::SkillInfo> {
    use std::path::Path;
    let mut out = Vec::new();
    let home = std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("/"));
    let config_base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    // OpenCode reads skills from its own directories plus Claude-compatible
    // and agent-ecosystem-compatible locations.
    crate::services::skills_service::scan_dir(
        &config_base.join("opencode").join("skills"),
        "user",
        &mut out,
    );
    crate::services::skills_service::scan_dir(
        &home.join(".claude").join("skills"),
        "user",
        &mut out,
    );
    crate::services::skills_service::scan_dir(
        &home.join(".agents").join("skills"),
        "user",
        &mut out,
    );
    if let Some(cwd) = cwd {
        crate::services::skills_service::scan_dir(
            &Path::new(cwd).join(".opencode").join("skills"),
            "project",
            &mut out,
        );
        crate::services::skills_service::scan_dir(
            &Path::new(cwd).join(".claude").join("skills"),
            "project",
            &mut out,
        );
        crate::services::skills_service::scan_dir(
            &Path::new(cwd).join(".agents").join("skills"),
            "project",
            &mut out,
        );
    }

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    out.retain(|s| s.name.is_empty() || seen.insert(s.name.clone()));
    out
}

pub async fn inject_mcp(
    cwd: Option<&str>,
    session_id: Option<&str>,
    servers_json: &str,
) -> serde_json::Value {
    crate::services::agent_sdk_service::inject_mcp("opencode", cwd, session_id, servers_json).await
}

/// Resolve the provider for a model that only appears in the config's
/// `model` field. OpenCode model IDs are normally `provider/model`.
fn resolve_model_provider(model_id: &str, providers: &serde_json::Map<String, Value>) -> String {
    if let Some((provider_id, _)) = model_id.split_once('/') {
        return providers
            .get(provider_id)
            .and_then(|provider| provider.get("name"))
            .and_then(|name| name.as_str())
            .filter(|name| !name.is_empty())
            .unwrap_or(provider_id)
            .to_string();
    }

    for (provider_id, provider) in providers {
        let contains_model = provider
            .get("models")
            .and_then(|models| models.as_object())
            .map(|models| models.contains_key(model_id))
            .unwrap_or(false);
        if contains_model {
            return provider
                .get("name")
                .and_then(|name| name.as_str())
                .unwrap_or(provider_id.as_str())
                .to_string();
        }
    }

    // A single configured provider can safely be inferred for a bare model ID.
    if providers.len() == 1 {
        if let Some((provider_id, provider)) = providers.iter().next() {
            return provider
                .get("name")
                .and_then(|name| name.as_str())
                .unwrap_or(provider_id.as_str())
                .to_string();
        }
    }

    String::new()
}

pub fn read_models(cwd: Option<&str>) -> Vec<crate::services::profile_service::ProfileModelDetail> {
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
        let stripped = crate::services::model_file_reader::strip_json_comments(&content);
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
                    // Keep the provider-qualified ID so it matches the IDs reported
                    // by OpenCode ACP config options (e.g. `opencode-go/foo`).
                    let full_id = format!("{}/{}", pname, mkey);
                    if seen.contains(&full_id) {
                        continue;
                    }
                    seen.insert(full_id.clone());
                    models.push(crate::services::profile_service::ProfileModelDetail {
                        id: full_id,
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
                // Keep the full provider-qualified default model ID so it matches
                // ACP config option values.
                let id = dm.clone();
                if !seen.contains(&id) {
                    let name = id
                        .split_once('/')
                        .map(|(_, model)| model)
                        .unwrap_or(&id)
                        .to_string();
                    let provider = resolve_model_provider(&id, &providers);
                    models.insert(
                        0,
                        crate::services::profile_service::ProfileModelDetail {
                            id: id.clone(),
                            name,
                            description: "Configured model".to_string(),
                            provider,
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
