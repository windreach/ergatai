//! Cgroups v2 resource limit controller.
//!
//! Enforces CPU and memory limits for agent workspaces using Linux cgroups v2.
//! Gracefully degrades on systems without cgroups v2 support (non-Linux,
//! insufficient permissions, or cgroups v1).
//!
//! # Hierarchy
//!
//! ```text
//! /sys/fs/cgroup/ergatai/           ← root (created once, shared)
//! └── workspace-{id}/               ← per-workspace cgroup
//!     ├── cgroup.procs              ← PIDs of agents in this workspace
//!     ├── cpu.max                   ← CPU limit (microseconds per period)
//!     ├── memory.max                ← Memory limit (bytes)
//!     └── cgroup.subtree_control    ← enabled controllers
//! ```

use std::path::{Path, PathBuf};

use tracing::{debug, info, warn};

/// Controls cgroup v2 resource limits for a workspace.
///
/// On creation, sets CPU and memory limits in a per-workspace cgroup directory.
/// After an agent is spawned, call `add_process(pid)` to move it into the cgroup.
/// When the workspace is destroyed, call `cleanup()` to remove the cgroup directory.
#[derive(Debug)]
pub struct CgroupController {
    /// Path to the workspace's cgroup directory.
    cgroup_path: PathBuf,
    /// Whether the cgroup was successfully created and is active.
    active: bool,
}

impl CgroupController {
    /// Create a new cgroup controller for a workspace.
    ///
    /// Returns a controller with `active = false` if cgroups v2 is unavailable.
    /// The caller should check `is_active()` before relying on limits.
    ///
    /// # Arguments
    /// * `workspace_id` - Unique workspace identifier (used in cgroup path)
    /// * `cpu_cores` - CPU limit in cores (e.g., 2.5 = 2.5 cores). None = no limit.
    /// * `memory_mb` - Memory limit in megabytes. None = no limit.
    pub fn create(
        workspace_id: &str,
        cpu_cores: Option<f64>,
        memory_mb: Option<u64>,
    ) -> Self {
        // H-3: Validate workspace_id to prevent path traversal.
        // Reject empty, path separators, parent references.
        if workspace_id.is_empty()
            || workspace_id.contains('/')
            || workspace_id.contains('\\')
            || workspace_id.contains("..")
        {
            warn!(
                workspace_id = %workspace_id,
                "Invalid workspace_id for cgroup — resource limits disabled"
            );
            return Self {
                cgroup_path: PathBuf::new(),
                active: false,
            };
        }

        // H-4: If no limits are requested, skip all filesystem operations.
        // This avoids failing in non-root environments where sysfs is read-only.
        if cpu_cores.is_none() && memory_mb.is_none() {
            return Self {
                cgroup_path: PathBuf::new(),
                active: false,
            };
        }

        // Check if cgroups v2 is available
        let cgroup_root = Path::new("/sys/fs/cgroup");
        if !Self::cgroups_v2_available() {
            info!(
                workspace_id = %workspace_id,
                "Cgroups v2 not available — resource limits disabled"
            );
            return Self {
                cgroup_path: PathBuf::new(),
                active: false,
            };
        }

        let workspace_path = cgroup_root
            .join("ergatai")
            .join(format!("workspace-{}", workspace_id));

        // Create the cgroup directory
        if let Err(e) = std::fs::create_dir_all(&workspace_path) {
            warn!(
                workspace_id = %workspace_id,
                error = %e,
                "Failed to create cgroup directory — resource limits disabled"
            );
            return Self {
                cgroup_path: workspace_path,
                active: false,
            };
        }

        // Enable controllers in the parent (ergatai/) so this workspace cgroup
        // can use them. Write "+cpu +memory" to subtree_control.
        let parent_path = cgroup_root.join("ergatai");
        let _ = std::fs::create_dir_all(&parent_path);
        if let Err(e) = std::fs::write(parent_path.join("cgroup.subtree_control"), "+cpu +memory") {
            debug!(
                error = %e,
                "Could not enable cpu+memory controllers in parent cgroup (may already be enabled)"
            );
        }

        let mut active = true;

        // Set CPU limit: cpu.max format is "$MAX $PERIOD" in microseconds.
        // Period is typically 100_000 (100ms). Max is cores * period.
        if let Some(cores) = cpu_cores {
            let period_us: u64 = 100_000;
            let max_us = (cores * period_us as f64) as u64;
            let value = format!("{} {}", max_us, period_us);
            if let Err(e) = std::fs::write(workspace_path.join("cpu.max"), &value) {
                warn!(
                    workspace_id = %workspace_id,
                    cpu_max = %value,
                    error = %e,
                    "Failed to set CPU limit"
                );
                active = false;
            } else {
                info!(
                    workspace_id = %workspace_id,
                    cpu_cores = cores,
                    cpu_max = %value,
                    "Set CPU limit in cgroup"
                );
            }
        }

        // Set memory limit: memory.max is in bytes.
        if let Some(mb) = memory_mb {
            let bytes = mb * 1024 * 1024;
            let value = bytes.to_string();
            if let Err(e) = std::fs::write(workspace_path.join("memory.max"), &value) {
                warn!(
                    workspace_id = %workspace_id,
                    memory_mb = mb,
                    memory_bytes = bytes,
                    error = %e,
                    "Failed to set memory limit"
                );
                active = false;
            } else {
                info!(
                    workspace_id = %workspace_id,
                    memory_mb = mb,
                    memory_bytes = bytes,
                    "Set memory limit in cgroup"
                );
            }
        }

        Self {
            cgroup_path: workspace_path,
            active,
        }
    }

    /// Check if cgroups v2 is available on this system.
    ///
    /// Returns true if `/sys/fs/cgroup/cgroup.controllers` exists (the v2 signature).
    pub fn cgroups_v2_available() -> bool {
        cfg!(target_os = "linux")
            && Path::new("/sys/fs/cgroup/cgroup.controllers").exists()
    }

    /// Whether this controller successfully created a cgroup with limits.
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Path to the workspace's cgroup directory.
    pub fn path(&self) -> &Path {
        &self.cgroup_path
    }

    /// Add a process (by PID) to this cgroup.
    ///
    /// Must be called after spawning the agent process. Writes the PID to
    /// `cgroup.procs`, which moves the process into the cgroup.
    ///
    /// # Arguments
    /// * `pid` - Process ID to add (as returned by forkpty/exec)
    pub fn add_process(&self, pid: i32) -> Result<(), std::io::Error> {
        if !self.active {
            return Ok(()); // Silently skip if cgroup is not active
        }

        let procs_file = self.cgroup_path.join("cgroup.procs");
        std::fs::write(&procs_file, pid.to_string())?;
        debug!(
            cgroup = %self.cgroup_path.display(),
            pid = pid,
            "Added process to cgroup"
        );
        Ok(())
    }

    /// Remove the cgroup directory and release resources.
    ///
    /// The cgroup must be empty (no processes) before it can be removed.
    /// If processes are still in the cgroup, the kernel will refuse removal
    /// and this method will log a warning and return without error.
    pub fn cleanup(&self) {
        if !self.active {
            return;
        }

        // Try to remove the cgroup directory.
        // This fails with EBUSY if there are still processes in the cgroup.
        match std::fs::remove_dir(&self.cgroup_path) {
            Ok(()) => {
                info!(
                    cgroup = %self.cgroup_path.display(),
                    "Removed cgroup directory"
                );
            }
            Err(e) => {
                // EBUSY means processes still in cgroup — that's expected if agents
                // haven't exited yet. The kernel will clean up when the cgroup is empty.
                debug!(
                    cgroup = %self.cgroup_path.display(),
                    error = %e,
                    "Could not remove cgroup directory (may still contain processes)"
                );
            }
        }
    }
}

impl Drop for CgroupController {
    fn drop(&mut self) {
        self.cleanup();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cgroups_v2_availability_check() {
        // Just verify it doesn't panic — the actual result depends on the system.
        let _available = CgroupController::cgroups_v2_available();
    }

    #[test]
    fn test_create_without_limits_returns_inactive() {
        // No limits = no cgroup operations needed. Controller is inactive.
        let controller = CgroupController::create("test-workspace", None, None);
        assert!(!controller.is_active());
        assert!(controller.cgroup_path.as_os_str().is_empty());
    }

    #[test]
    fn test_create_rejects_path_traversal() {
        // Path separators and parent references are rejected.
        let controller = CgroupController::create("../etc", None, Some(512));
        assert!(!controller.is_active());

        let controller = CgroupController::create("foo/bar", None, Some(512));
        assert!(!controller.is_active());

        let controller = CgroupController::create("", None, Some(512));
        assert!(!controller.is_active());
    }

    #[test]
    fn test_add_process_when_inactive_is_noop() {
        let controller = CgroupController {
            cgroup_path: PathBuf::new(),
            active: false,
        };
        // Should not error even when inactive
        assert!(controller.add_process(12345).is_ok());
    }

    #[test]
    fn test_cleanup_when_inactive_is_noop() {
        let controller = CgroupController {
            cgroup_path: PathBuf::new(),
            active: false,
        };
        // Should not panic
        controller.cleanup();
    }
}
