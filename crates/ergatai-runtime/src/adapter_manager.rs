//! Managed A/B ("dual-path") adapter lifecycle.
//!
//! Two adapter installs always coexist while the app runs:
//!
//! ```text
//! <adapters_base>/managed/
//!   releases/<id>/    immutable, verified installs (current + previous)
//!   staging/          in-progress install (also serves as the update lock)
//!   current           plain-text pointer to the active release id
//! ```
//!
//! Policy (per product decision):
//! - Startup resolves the existing `current` release and points profiles at it.
//! - During runtime a background task checks npm for updates, installs a new
//!   release in `staging`, verifies the installed artifacts, and only then
//!   flips the pointer and switches the managed profile rows.
//! - Running agents continue using the previous release; only newly spawned
//!   agents use the new version.
//!
//! Disabled entirely with `ERGATAI_ADAPTERS_AUTO_UPDATE=0`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tracing::{debug, info, warn};

/// A managed adapter: npm package name and the built entrypoint (verified before activation).
pub struct ManagedAdapter {
    /// `agent_registrations.id` switched to this adapter on activation.
    pub profile_id: &'static str,
    /// NPM package name (e.g., "@anthropic-ai/claude-code").
    pub npm_package: &'static str,
    /// Entry point relative to `node_modules/<package>` (e.g., "dist/acp-agent.js").
    pub dist_relative: &'static str,
}

/// Adapters under A/B management, with their npm packages.
pub const MANAGED_ADAPTERS: &[ManagedAdapter] = &[
    ManagedAdapter {
        profile_id: "claude-code",
        npm_package: "@zed-industries/claude-code-acp",
        dist_relative: "dist/acp-agent.js",
    },
    ManagedAdapter {
        profile_id: "codex",
        npm_package: "@agentclientprotocol/codex-acp",
        dist_relative: "dist/index.js",
    },
];

const RELEASES_DIR: &str = "releases";
const CURRENT_POINTER: &str = "current";
const STAGING_DIR: &str = "staging";
const MANIFEST_FILE: &str = "manifest.json";

/// Staging older than this is reclaimed (crashed updater), even though the
/// directory exists.
const STAGING_TTL: Duration = Duration::from_secs(60 * 60);

/// Delay before the first update check so startup/network settle first.
const INITIAL_CHECK_DELAY: Duration = Duration::from_secs(5);

const LS_REMOTE_TIMEOUT: Duration = Duration::from_secs(30);
const NPM_INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ReleaseManifest {
    /// Upstream HEAD sha per adapter repo dir at build time.
    adapters: BTreeMap<String, String>,
}

/// Directory holding the managed releases, for a given adapters base.
pub fn resolve_managed_base(adapters_base: &Path) -> PathBuf {
    adapters_base.join("managed")
}

/// Spawn the background manager for one-time update check on startup.
/// No-op when disabled via `ERGATAI_ADAPTERS_AUTO_UPDATE=0` or when called
/// outside a tokio runtime.
pub fn spawn_adapter_manager(profile_registry_db: String, adapters_base: PathBuf) {
    let disabled = std::env::var("ERGATAI_ADAPTERS_AUTO_UPDATE")
        .map(|value| value == "0" || value.eq_ignore_ascii_case("false"))
        .unwrap_or(false);
    if disabled {
        info!("Managed adapter updates disabled (ERGATAI_ADAPTERS_AUTO_UPDATE=0)");
        return;
    }
    if tokio::runtime::Handle::try_current().is_err() {
        debug!("No tokio runtime; managed adapter manager not started");
        return;
    }

    let managed = resolve_managed_base(&adapters_base);
    info!(
        base = %managed.display(),
        "Managed adapter manager started (one-time startup check; background build if update available)"
    );
    tokio::spawn(async move {
        run_startup_check(profile_registry_db, managed).await;
    });
}

async fn run_startup_check(db_path: String, managed: PathBuf) {
    // Startup duties: retire releases from previous session, then point
    // managed profile rows at the current release.
    if let Err(error) = retire_old_releases(&managed) {
        warn!(error = %error, "Adapter release cleanup failed (non-fatal)");
    }
    if let Some(release_dir) = current_release_dir(&managed) {
        if let Err(error) = refresh_profile_rows(Path::new(&db_path), &release_dir) {
            warn!(error = %error, "Failed to refresh managed adapter profile rows (non-fatal)");
        }
    }

    // Wait briefly for startup/network to settle, then check for updates once.
    tokio::time::sleep(INITIAL_CHECK_DELAY).await;

    // One-time update check: build new version in background if available.
    // No periodic polling — next check happens on next app startup.
    if let Err(error) = update_cycle(Path::new(&db_path), &managed).await {
        debug!(error = %error, "Adapter update cycle did not activate a new release");
    }
}

/// One check-and-maybe-update round. All failures return `Err` and leave
/// the current release untouched.
async fn update_cycle(db_path: &Path, managed: &Path) -> Result<(), String> {
    let staging = managed.join(STAGING_DIR);
    acquire_staging(&staging)?;
    let result = build_and_activate(db_path, managed, &staging).await;
    // Release the lock either way; a failed build must not block future cycles.
    let _ = std::fs::remove_dir_all(&staging);
    result
}

async fn build_and_activate(db_path: &Path, managed: &Path, staging: &Path) -> Result<(), String> {
    let current = current_release_dir(managed);
    let current_manifest = current
        .as_ref()
        .and_then(|dir| read_manifest(dir).ok())
        .unwrap_or_default();

    // Check npm registry for latest versions
    let mut upstream = BTreeMap::new();
    for adapter in MANAGED_ADAPTERS {
        let version = npm_latest_version(adapter.npm_package)
            .await
            .map_err(|error| format!("npm view {} failed: {}", adapter.npm_package, error))?;
        upstream.insert(adapter.npm_package.to_string(), version);
    }

    if current.is_some() && current_manifest.adapters == upstream {
        debug!("Managed adapters are up-to-date");
        return Ok(());
    }
    info!("Managed adapter update available; installing new release in staging");

    // Install every managed adapter into staging
    std::fs::create_dir_all(staging)
        .map_err(|error| format!("Failed to create staging dir: {}", error))?;

    let mut built = ReleaseManifest::default();
    for adapter in MANAGED_ADAPTERS {
        npm_install_package(staging, adapter.npm_package).await?;
        verify_adapter(staging, adapter).await?;
        built.adapters.insert(
            adapter.npm_package.to_string(),
            upstream[adapter.npm_package].clone(),
        );
    }
    write_manifest(staging, &built)?;

    // Promote staging to an immutable release, then flip the pointer.
    let release_id = format_release_id(&built);
    let releases_dir = managed.join(RELEASES_DIR);
    std::fs::create_dir_all(&releases_dir)
        .map_err(|error| format!("Failed to create releases dir: {}", error))?;
    let release_dir = releases_dir.join(&release_id);
    std::fs::rename(staging, &release_dir)
        .map_err(|error| format!("Failed to promote staging to release: {}", error))?;

    write_current_pointer(managed, &release_id)?;
    refresh_profile_rows(db_path, &release_dir)?;
    info!(
        release = %release_id,
        "Activated managed adapter release; subsequent agent spawns use the new version"
    );
    Ok(())
}

// ── profile rows ─────────────────────────────────────────────────────

/// Point managed profile rows at the given release. Rows with custom
/// (user-modified) commands are left untouched; missing rows are created so
/// fresh installs work out of the box.
pub fn refresh_profile_rows(db_path: &Path, release_dir: &Path) -> Result<(), String> {
    let conn = Connection::open(db_path)
        .map_err(|error| format!("Failed to open profile registry database: {}", error))?;

    for adapter in MANAGED_ADAPTERS {
        let dist = release_dir
            .join("node_modules")
            .join(adapter.npm_package)
            .join(adapter.dist_relative);
        if !dist.is_file() {
            debug!(
                profile = adapter.profile_id,
                path = %dist.display(),
                "Managed adapter dist missing in release; skipping profile refresh"
            );
            continue;
        }
        let command = format!("node {}", dist.display());
        let existing: Option<String> = conn
            .query_row(
                "SELECT command FROM agent_registrations WHERE id = ?1",
                params![adapter.profile_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Failed to read profile row: {}", error))?;

        match existing {
            Some(current_command) if command_matches_managed_pattern(&current_command) => {
                conn.execute(
                    "UPDATE agent_registrations SET command = ?1 WHERE id = ?2",
                    params![command, adapter.profile_id],
                )
                .map_err(|error| format!("Failed to update profile row: {}", error))?;
                info!(
                    profile = adapter.profile_id,
                    command = %command,
                    "Switched profile to managed adapter release"
                );
            }
            Some(custom_command) => {
                debug!(
                    profile = adapter.profile_id,
                    command = %custom_command,
                    "Leaving custom profile command untouched"
                );
            }
            None => {
                conn.execute(
                    "INSERT OR IGNORE INTO agent_registrations \
                     (id, name, command, agent_type, package_name, avatar_url, created_at) \
                     VALUES (?1, ?1, ?2, 'acp', NULL, NULL, ?3)",
                    params![adapter.profile_id, command, Utc::now().to_rfc3339()],
                )
                .map_err(|error| format!("Failed to insert profile row: {}", error))?;
                info!(
                    profile = adapter.profile_id,
                    "Registered managed adapter profile"
                );
            }
        }
    }
    Ok(())
}

/// Commands the manager may take over: the historical `npx -y
/// @agentclientprotocol/...` defaults, `node` paths into the managed
/// releases directory. Anything else is treated as user-customized and
/// never overwritten.
fn command_matches_managed_pattern(command: &str) -> bool {
    command.contains("npx -y @")
        || command.contains("/managed/releases/")
        || (command.starts_with("node ") && command.contains("/adapters/"))
}

// ── release store ────────────────────────────────────────────────────

fn read_current_pointer(managed: &Path) -> Option<String> {
    std::fs::read_to_string(managed.join(CURRENT_POINTER))
        .ok()
        .map(|contents| contents.trim().to_string())
        .filter(|contents| !contents.is_empty())
}

fn current_release_dir(managed: &Path) -> Option<PathBuf> {
    let release_id = read_current_pointer(managed)?;
    let dir = managed.join(RELEASES_DIR).join(&release_id);
    dir.is_dir().then_some(dir)
}

fn write_current_pointer(managed: &Path, release_id: &str) -> Result<(), String> {
    std::fs::create_dir_all(managed)
        .map_err(|error| format!("Failed to create managed dir: {}", error))?;
    let tmp = managed.join(format!(".current.{}.tmp", std::process::id()));
    std::fs::write(&tmp, release_id)
        .map_err(|error| format!("Failed to write pointer file: {}", error))?;
    std::fs::rename(&tmp, managed.join(CURRENT_POINTER))
        .map_err(|error| format!("Failed to flip current pointer: {}", error))
}

fn read_manifest(release_dir: &Path) -> Result<ReleaseManifest, String> {
    let raw = std::fs::read_to_string(release_dir.join(MANIFEST_FILE))
        .map_err(|error| format!("Failed to read release manifest: {}", error))?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("Failed to parse release manifest: {}", error))
}

fn write_manifest(dir: &Path, manifest: &ReleaseManifest) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("Failed to serialize manifest: {}", error))?;
    std::fs::write(dir.join(MANIFEST_FILE), raw)
        .map_err(|error| format!("Failed to write manifest: {}", error))
}

fn format_release_id(manifest: &ReleaseManifest) -> String {
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S");
    let combined: String = manifest.adapters.values().cloned().collect();
    let short: String = combined
        .chars()
        .filter(|character| character.is_ascii_hexdigit())
        .take(7)
        .collect();
    format!("{}-{}", timestamp, short)
}

/// Delete every release except the current one. Runs at startup: the
/// previous release (kept after an in-session switch) is retired only at
/// the NEXT desktop startup, never at switch time.
fn retire_old_releases(managed: &Path) -> Result<(), String> {
    let releases_dir = managed.join(RELEASES_DIR);
    let Ok(entries) = std::fs::read_dir(&releases_dir) else {
        return Ok(());
    };
    let current = read_current_pointer(managed);
    // If there's no current pointer, don't remove anything — we don't know
    // which release is active, so removing any could break a running agent.
    let Some(current) = current else {
        debug!("No current release pointer; skipping retirement");
        return Ok(());
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if current == name || !entry.path().is_dir() {
            continue;
        }
        match std::fs::remove_dir_all(entry.path()) {
            Ok(()) => info!(
                release = %name,
                "Retired previous adapter release (kept until this startup, per A/B policy)"
            ),
            Err(error) => {
                warn!(release = %name, error = %error, "Failed to remove retired adapter release")
            }
        }
    }
    Ok(())
}

fn acquire_staging(staging: &Path) -> Result<(), String> {
    match std::fs::create_dir(staging) {
        Ok(()) => Ok(()),
        Err(_) if staging_is_stale(staging) => {
            warn!("Reclaiming stale adapter staging directory");
            let _ = std::fs::remove_dir_all(staging);
            std::fs::create_dir(staging)
                .map_err(|error| format!("Failed to reclaim staging: {}", error))
        }
        Err(_) => Err("another process is building adapters; skipping this cycle".to_string()),
    }
}

fn staging_is_stale(staging: &Path) -> bool {
    let age = std::fs::metadata(staging)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok());
    matches!(age, Some(age) if age > STAGING_TTL)
}

// ── verification ─────────────────────────────────────────────────────

/// Gate a staging install before it can go live: the dist artifact must
/// exist, be non-empty, and pass `node --check` (a broken install must never
/// replace a working release).
async fn verify_adapter(release_dir: &Path, adapter: &ManagedAdapter) -> Result<(), String> {
    let dist = release_dir
        .join("node_modules")
        .join(adapter.npm_package)
        .join(adapter.dist_relative);
    let metadata = std::fs::metadata(&dist).map_err(|error| {
        format!(
            "Built artifact missing for {} ({}): {}",
            adapter.npm_package,
            dist.display(),
            error
        )
    })?;
    if metadata.len() == 0 {
        return Err(format!(
            "Built artifact is empty for {}",
            adapter.npm_package
        ));
    }

    // Wrap synchronous node --check in spawn_blocking to avoid blocking the async runtime
    let dist_path = dist.to_string_lossy().to_string();
    let package_name = adapter.npm_package.to_string();
    let success = tokio::task::spawn_blocking(move || {
        std::process::Command::new("node")
            .args(["--check", &dist_path])
            .output()
            .map(|output| {
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let tail: String = stderr
                        .chars()
                        .skip(stderr.len().saturating_sub(300))
                        .collect();
                    tracing::warn!(
                        package = %package_name,
                        stderr = %tail,
                        "node --check failed for installed adapter artifact"
                    );
                    false
                } else {
                    true
                }
            })
            .unwrap_or_else(|error| {
                tracing::warn!(error = %error, "Failed to run node --check");
                false
            })
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {}", e))?;

    if !success {
        return Err(format!("node --check failed for {}", adapter.npm_package));
    }
    Ok(())
}

// ── subprocess helpers ───────────────────────────────────────────────

async fn npm_latest_version(package: &str) -> Result<String, String> {
    let mut cmd = Command::new("npm");
    cmd.args(["view", package, "version"]);
    let output = run_command(cmd, LS_REMOTE_TIMEOUT).await?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn npm_install_package(dest: &Path, package: &str) -> Result<(), String> {
    let mut cmd = Command::new("npm");
    cmd.args([
        "install",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        package,
    ])
    .current_dir(dest);
    run_command(cmd, NPM_INSTALL_TIMEOUT).await.map(|_| ())
}

async fn run_command(
    mut command: Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let description = format!("{:?}", command.as_std());
    let output = tokio::time::timeout(timeout, command.kill_on_drop(true).output())
        .await
        .map_err(|_| format!("{} timed out after {:?}", description, timeout))?
        .map_err(|error| format!("{} failed to run: {}", description, error))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr
            .chars()
            .skip(stderr.len().saturating_sub(300))
            .collect();
        return Err(format!("{} failed: {}", description, tail));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fake_release(managed: &Path, release_id: &str, adapters: &[&str]) -> PathBuf {
        let release_dir = managed.join(RELEASES_DIR).join(release_id);
        for adapter_name in adapters {
            // Find the matching managed adapter by profile_id
            let adapter = MANAGED_ADAPTERS
                .iter()
                .find(|a| a.profile_id == *adapter_name);

            if let Some(adapter) = adapter {
                // Create the file at the path that refresh_profile_rows expects
                let dist_path = release_dir
                    .join("node_modules")
                    .join(adapter.npm_package)
                    .join(adapter.dist_relative);
                if let Some(parent) = dist_path.parent() {
                    std::fs::create_dir_all(parent).unwrap();
                }
                std::fs::write(dist_path, "module.exports = 1;\n").unwrap();
            }
        }
        release_dir
    }

    #[test]
    fn current_pointer_roundtrip() {
        let temp = TempDir::new().unwrap();
        let managed = temp.path().join("managed");
        assert!(current_release_dir(&managed).is_none());

        let release_dir = fake_release(&managed, "20261002-100000-deadbeef", &["codex"]);
        write_current_pointer(&managed, "20261002-100000-deadbeef").unwrap();
        assert_eq!(
            current_release_dir(&managed).as_deref(),
            Some(release_dir.as_path())
        );

        // Unknown release id resolves to nothing.
        write_current_pointer(&managed, "does-not-exist").unwrap();
        assert!(current_release_dir(&managed).is_none());
    }

    #[test]
    fn retire_old_releases_keeps_only_current() {
        let temp = TempDir::new().unwrap();
        let managed = temp.path().join("managed");
        fake_release(&managed, "release-a", &["codex"]);
        fake_release(&managed, "release-b", &["codex"]);
        write_current_pointer(&managed, "release-b").unwrap();

        retire_old_releases(&managed).unwrap();

        let releases_dir = managed.join(RELEASES_DIR);
        let remaining: Vec<String> = std::fs::read_dir(&releases_dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(remaining, vec!["release-b".to_string()]);
    }

    #[test]
    fn retire_old_releases_without_current_removes_nothing() {
        let temp = TempDir::new().unwrap();
        let managed = temp.path().join("managed");
        fake_release(&managed, "release-a", &["codex"]);

        retire_old_releases(&managed).unwrap();

        assert!(managed.join(RELEASES_DIR).join("release-a").is_dir());
    }

    #[test]
    fn command_pattern_guard_matches_only_managed_defaults() {
        assert!(command_matches_managed_pattern(
            "npx -y @agentclientprotocol/claude-agent-acp@latest"
        ));
        assert!(command_matches_managed_pattern(
            "node /home/user/ergatai/adapters/claude-agent-acp/dist/acp-agent.js"
        ));
        assert!(command_matches_managed_pattern(
            "node /home/user/ergatai/adapters/managed/releases/r1/codex-acp/dist/index.js"
        ));
        assert!(!command_matches_managed_pattern("gemini --acp"));
        assert!(!command_matches_managed_pattern(
            "node /opt/my-custom-agent/run.js"
        ));
    }

    #[tokio::test]
    async fn verify_adapter_accepts_valid_and_rejects_broken_builds() {
        let node_available = std::process::Command::new("node")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
        if !node_available {
            eprintln!("node not available; skipping verify_adapter test");
            return;
        }

        let temp = TempDir::new().unwrap();
        let adapter = ManagedAdapter {
            profile_id: "test",
            npm_package: "test-package",
            dist_relative: "dist/index.js",
        };
        let release_dir = temp.path();
        let dist_dir = release_dir
            .join("node_modules")
            .join(adapter.npm_package)
            .join("dist");
        std::fs::create_dir_all(&dist_dir).unwrap();

        // Missing artifact.
        assert!(verify_adapter(release_dir, &adapter).await.is_err());

        // Valid artifact.
        std::fs::write(dist_dir.join("index.js"), "module.exports = 1;\n").unwrap();
        assert!(verify_adapter(release_dir, &adapter).await.is_ok());

        // Syntax-broken artifact.
        std::fs::write(dist_dir.join("index.js"), "this is {{{ not js").unwrap();
        assert!(verify_adapter(release_dir, &adapter).await.is_err());
    }

    #[test]
    fn refresh_profile_rows_updates_managed_and_respects_custom_commands() {
        let temp = TempDir::new().unwrap();
        let db_path = temp.path().join("profiles.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE agent_registrations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                command TEXT NOT NULL,
                agent_type TEXT NOT NULL,
                package_name TEXT,
                avatar_url TEXT,
                created_at TEXT NOT NULL
            );",
        )
        .unwrap();
        // Historical npx default — must be switched.
        conn.execute(
            "INSERT INTO agent_registrations (id, name, command, agent_type, created_at)
             VALUES ('claude-code', 'claude-code', 'npx -y @agentclientprotocol/claude-agent-acp@latest', 'acp', 'x')",
            [],
        )
        .unwrap();
        // Custom user command — must be left untouched.
        conn.execute(
            "INSERT INTO agent_registrations (id, name, command, agent_type, created_at)
             VALUES ('codex', 'codex', 'node /opt/my-custom-codex/run.js', 'acp', 'x')",
            [],
        )
        .unwrap();
        drop(conn);

        let managed = temp.path().join("managed");
        let release_dir = fake_release(&managed, "r1", &["claude-code", "codex"]);
        // Only the claude dist exists at a real path; codex too (both created).
        refresh_profile_rows(&db_path, &release_dir).unwrap();

        let conn = Connection::open(&db_path).unwrap();
        let claude_command: String = conn
            .query_row(
                "SELECT command FROM agent_registrations WHERE id = 'claude-code'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            claude_command.starts_with("node "),
            "switched: {}",
            claude_command
        );
        assert!(claude_command.contains(
            "managed/releases/r1/node_modules/@zed-industries/claude-code-acp/dist/acp-agent.js"
        ));

        let codex_command: String = conn
            .query_row(
                "SELECT command FROM agent_registrations WHERE id = 'codex'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(codex_command, "node /opt/my-custom-codex/run.js");

        // Row inserted when missing entirely.
        let gemini_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_registrations WHERE id = 'gemini'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(gemini_count, 0); // gemini is not managed; nothing inserted
    }

    #[test]
    fn refresh_profile_rows_inserts_missing_managed_profile() {
        let temp = TempDir::new().unwrap();
        let db_path = temp.path().join("profiles.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE agent_registrations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                command TEXT NOT NULL,
                agent_type TEXT NOT NULL,
                package_name TEXT,
                avatar_url TEXT,
                created_at TEXT NOT NULL
            );",
        )
        .unwrap();
        drop(conn);

        let managed = temp.path().join("managed");
        let release_dir = fake_release(&managed, "r1", &["claude-code", "codex"]);

        refresh_profile_rows(&db_path, &release_dir).unwrap();

        let conn = Connection::open(&db_path).unwrap();
        for profile_id in ["claude-code", "codex"] {
            let command: String = conn
                .query_row(
                    "SELECT command FROM agent_registrations WHERE id = ?1",
                    params![profile_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(command.starts_with("node "), "{}: {}", profile_id, command);
        }
    }
}
