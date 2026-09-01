//! Agent Profile - Agent type definitions and discovery
//!
//! Defines AgentProfile structure for categorizing agents by their capabilities,
//! tool policies, and resource constraints. Profiles are discovered from the
//! `.ergatai/profiles/` directory.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use ergatai_error::{ErgataiError, ErgataiResult};

/// Agent profile definition
///
/// Defines the characteristics and constraints for a category of agents.
/// Profiles are loaded from YAML files in `.ergatai/profiles/`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentProfile {
    /// Profile name (unique identifier, e.g., "general-purpose", "explore", "plan")
    pub name: String,

    /// Human-readable description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Capabilities this profile provides (e.g., ["code-generation", "review", "testing"])
    #[serde(default)]
    pub capabilities: Vec<String>,

    /// Tool policy (allowed/denied tools)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_policy: Option<ToolPolicy>,

    /// Model override (specific model to use for this profile)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_override: Option<String>,

    /// Maximum concurrent instances of this profile
    #[serde(default = "default_max_concurrency")]
    pub max_concurrency: usize,

    /// Additional metadata
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub metadata: HashMap<String, serde_json::Value>,
}

/// Tool access policy for an agent profile
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolPolicy {
    /// Allowed tools (whitelist)
    #[serde(default)]
    pub allowed: Vec<String>,

    /// Denied tools (blacklist)
    #[serde(default)]
    pub denied: Vec<String>,
}

/// Default max concurrency (unlimited)
fn default_max_concurrency() -> usize {
    usize::MAX
}

impl AgentProfile {
    /// Create a new agent profile with the given name
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: None,
            capabilities: Vec::new(),
            tool_policy: None,
            model_override: None,
            max_concurrency: default_max_concurrency(),
            metadata: HashMap::new(),
        }
    }

    /// Check if this profile allows the given tool
    pub fn allows_tool(&self, tool_name: &str) -> bool {
        match &self.tool_policy {
            None => true, // No policy means all tools allowed
            Some(policy) => {
                // Check explicit denial first
                if policy.denied.iter().any(|t| t == tool_name) {
                    return false;
                }
                // If allowed list is empty, all tools not denied are allowed
                if policy.allowed.is_empty() {
                    return true;
                }
                // Otherwise, check if tool is in allowed list
                policy.allowed.iter().any(|t| t == tool_name)
            }
        }
    }

    /// Check if this profile has the given capability
    pub fn has_capability(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|c| c == capability)
    }
}

impl ToolPolicy {
    /// Create a new tool policy
    pub fn new() -> Self {
        Self {
            allowed: Vec::new(),
            denied: Vec::new(),
        }
    }

    /// Add a tool to the allowed list
    pub fn allow(mut self, tool: impl Into<String>) -> Self {
        self.allowed.push(tool.into());
        self
    }

    /// Add a tool to the denied list
    pub fn deny(mut self, tool: impl Into<String>) -> Self {
        self.denied.push(tool.into());
        self
    }
}

impl Default for ToolPolicy {
    fn default() -> Self {
        Self::new()
    }
}

/// Discover agent profiles from the project's `.ergatai/profiles/` directory
///
/// Scans for YAML files (`.yaml` or `.yml`) in the profiles directory and
/// deserializes them into AgentProfile instances.
///
/// # Arguments
/// * `project_root` - Root directory of the project
///
/// # Returns
/// Vector of discovered AgentProfile instances
///
/// # Example
/// ```ignore
/// use ergatai_runtime::agent_profile::discover_profiles;
/// use std::path::Path;
///
/// let profiles = discover_profiles(Path::new("/path/to/project"))?;
/// for profile in profiles {
///     println!("Profile: {}", profile.name);
/// }
/// ```
pub fn discover_profiles(project_root: &Path) -> ErgataiResult<Vec<AgentProfile>> {
    let profiles_dir = project_root.join(".ergatai").join("profiles");

    if !profiles_dir.exists() {
        debug!("Profiles directory not found: {:?}", profiles_dir);
        return Ok(Vec::new());
    }

    if !profiles_dir.is_dir() {
        warn!(
            "Profiles path exists but is not a directory: {:?}",
            profiles_dir
        );
        return Ok(Vec::new());
    }

    let mut profiles = Vec::new();
    let mut seen_names = std::collections::HashSet::new();

    for entry in std::fs::read_dir(&profiles_dir)? {
        let entry = entry?;
        let path = entry.path();

        // Skip non-files
        if !path.is_file() {
            continue;
        }

        // Only process .yaml and .yml files
        let extension = path.extension().and_then(|e| e.to_str());
        if !matches!(extension, Some("yaml") | Some("yml")) {
            continue;
        }

        // Read and parse the profile
        let content = std::fs::read_to_string(&path).map_err(|e| {
            ErgataiError::InvalidArgument(format!("Failed to read profile file {:?}: {}", path, e))
        })?;

        let profile: AgentProfile = serde_yaml::from_str(&content).map_err(|e| {
            ErgataiError::InvalidArgument(format!("Failed to parse profile file {:?}: {}", path, e))
        })?;

        // Check for duplicate names
        if !seen_names.insert(profile.name.clone()) {
            return Err(ErgataiError::InvalidArgument(format!(
                "Duplicate profile name '{}' found in {:?}",
                profile.name, path
            )));
        }

        debug!("Discovered agent profile: {}", profile.name);
        profiles.push(profile);
    }

    Ok(profiles)
}

/// Load a specific profile by name from the profiles directory
///
/// # Arguments
/// * `project_root` - Root directory of the project
/// * `profile_name` - Name of the profile to load
///
/// # Returns
/// The AgentProfile if found, None otherwise
pub fn load_profile(
    project_root: &Path,
    profile_name: &str,
) -> ErgataiResult<Option<AgentProfile>> {
    let profiles = discover_profiles(project_root)?;
    Ok(profiles.into_iter().find(|p| p.name == profile_name))
}

/// Get the path to a profile file
///
/// # Arguments
/// * `project_root` - Root directory of the project
/// * `profile_name` - Name of the profile
///
/// # Returns
/// Path to the profile file (may not exist)
///
/// # Security
/// Validates that profile_name doesn't contain path separators or ".." to prevent
/// path traversal attacks.
pub fn get_profile_path(project_root: &Path, profile_name: &str) -> PathBuf {
    // Validate profile_name to prevent path traversal
    if profile_name.contains('/') || profile_name.contains('\\') || profile_name.contains("..") {
        // Return a path that won't exist rather than panicking
        // This is safer than allowing arbitrary path construction
        return project_root
            .join(".ergatai")
            .join("profiles")
            .join("INVALID_PROFILE_NAME.yaml");
    }

    project_root
        .join(".ergatai")
        .join("profiles")
        .join(format!("{}.yaml", profile_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_profile_creation() {
        let profile = AgentProfile::new("test-profile");
        assert_eq!(profile.name, "test-profile");
        assert!(profile.description.is_none());
        assert!(profile.capabilities.is_empty());
        assert!(profile.tool_policy.is_none());
    }

    #[test]
    fn test_tool_policy_no_policy() {
        let profile = AgentProfile::new("test");
        assert!(profile.allows_tool("any-tool"));
    }

    #[test]
    fn test_tool_policy_denied() {
        let profile = AgentProfile {
            name: "test".to_string(),
            description: None,
            capabilities: vec![],
            tool_policy: Some(ToolPolicy {
                allowed: vec![],
                denied: vec!["dangerous-tool".to_string()],
            }),
            model_override: None,
            max_concurrency: default_max_concurrency(),
            metadata: HashMap::new(),
        };

        assert!(!profile.allows_tool("dangerous-tool"));
        assert!(profile.allows_tool("safe-tool"));
    }

    #[test]
    fn test_tool_policy_allowed() {
        let profile = AgentProfile {
            name: "test".to_string(),
            description: None,
            capabilities: vec![],
            tool_policy: Some(ToolPolicy {
                allowed: vec!["tool-a".to_string(), "tool-b".to_string()],
                denied: vec![],
            }),
            model_override: None,
            max_concurrency: default_max_concurrency(),
            metadata: HashMap::new(),
        };

        assert!(profile.allows_tool("tool-a"));
        assert!(profile.allows_tool("tool-b"));
        assert!(!profile.allows_tool("tool-c"));
    }

    #[test]
    fn test_tool_policy_allowed_and_denied() {
        let profile = AgentProfile {
            name: "test".to_string(),
            description: None,
            capabilities: vec![],
            tool_policy: Some(ToolPolicy {
                allowed: vec!["tool-a".to_string(), "tool-b".to_string()],
                denied: vec!["tool-b".to_string()], // Deny takes precedence
            }),
            model_override: None,
            max_concurrency: default_max_concurrency(),
            metadata: HashMap::new(),
        };

        assert!(profile.allows_tool("tool-a"));
        assert!(!profile.allows_tool("tool-b")); // Denied even though in allowed
        assert!(!profile.allows_tool("tool-c")); // Not in allowed list
    }

    #[test]
    fn test_has_capability() {
        let profile = AgentProfile {
            name: "test".to_string(),
            description: None,
            capabilities: vec!["code-generation".to_string(), "review".to_string()],
            tool_policy: None,
            model_override: None,
            max_concurrency: default_max_concurrency(),
            metadata: HashMap::new(),
        };

        assert!(profile.has_capability("code-generation"));
        assert!(profile.has_capability("review"));
        assert!(!profile.has_capability("testing"));
    }

    #[test]
    fn test_tool_policy_builder() {
        let policy = ToolPolicy::new()
            .allow("tool-a")
            .allow("tool-b")
            .deny("dangerous-tool");

        assert_eq!(policy.allowed, vec!["tool-a", "tool-b"]);
        assert_eq!(policy.denied, vec!["dangerous-tool"]);
    }

    #[test]
    fn test_profile_yaml_deserialization() {
        let yaml = r#"
name: general-purpose
description: General purpose coding agent
capabilities:
  - code-generation
  - review
  - testing
tool_policy:
  allowed:
    - read
    - write
    - bash
  denied:
    - dangerous-tool
max_concurrency: 5
"#;

        let profile: AgentProfile = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(profile.name, "general-purpose");
        assert_eq!(
            profile.description,
            Some("General purpose coding agent".to_string())
        );
        assert_eq!(
            profile.capabilities,
            vec!["code-generation", "review", "testing"]
        );
        assert_eq!(
            profile.tool_policy.as_ref().unwrap().allowed,
            vec!["read", "write", "bash"]
        );
        assert_eq!(
            profile.tool_policy.as_ref().unwrap().denied,
            vec!["dangerous-tool"]
        );
        assert_eq!(profile.max_concurrency, 5);
    }
}
