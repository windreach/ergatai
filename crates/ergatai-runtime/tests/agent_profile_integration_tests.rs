//! Integration tests for Agent Profile discovery

use std::fs;
use tempfile::TempDir;

use ergatai_runtime::{discover_profiles, load_profile, AgentProfile};

#[test]
fn test_discover_profiles_empty_directory() {
    let temp_dir = TempDir::new().unwrap();
    let profiles_dir = temp_dir.path().join(".ergatai").join("profiles");
    fs::create_dir_all(&profiles_dir).unwrap();

    let profiles = discover_profiles(temp_dir.path()).unwrap();
    assert!(profiles.is_empty());
}

#[test]
fn test_discover_profiles_no_directory() {
    let temp_dir = TempDir::new().unwrap();
    let profiles = discover_profiles(temp_dir.path()).unwrap();
    assert!(profiles.is_empty());
}

#[test]
fn test_discover_profiles_single_profile() {
    let temp_dir = TempDir::new().unwrap();
    let profiles_dir = temp_dir.path().join(".ergatai").join("profiles");
    fs::create_dir_all(&profiles_dir).unwrap();

    let profile_yaml = r#"
name: general-purpose
description: General purpose coding agent
capabilities:
  - code-generation
  - review
max_concurrency: 5
"#;

    fs::write(profiles_dir.join("general-purpose.yaml"), profile_yaml).unwrap();

    let profiles = discover_profiles(temp_dir.path()).unwrap();
    assert_eq!(profiles.len(), 1);

    let profile = &profiles[0];
    assert_eq!(profile.name, "general-purpose");
    assert_eq!(
        profile.description,
        Some("General purpose coding agent".to_string())
    );
    assert_eq!(profile.capabilities, vec!["code-generation", "review"]);
    assert_eq!(profile.max_concurrency, 5);
}

#[test]
fn test_discover_profiles_multiple_profiles() {
    let temp_dir = TempDir::new().unwrap();
    let profiles_dir = temp_dir.path().join(".ergatai").join("profiles");
    fs::create_dir_all(&profiles_dir).unwrap();

    let profile1_yaml = r#"
name: explore
description: Exploration agent
capabilities:
  - search
  - analysis
"#;

    let profile2_yaml = r#"
name: plan
description: Planning agent
capabilities:
  - planning
  - architecture
"#;

    fs::write(profiles_dir.join("explore.yaml"), profile1_yaml).unwrap();
    fs::write(profiles_dir.join("plan.yml"), profile2_yaml).unwrap();

    let profiles = discover_profiles(temp_dir.path()).unwrap();
    assert_eq!(profiles.len(), 2);

    let names: Vec<&str> = profiles.iter().map(|p| p.name.as_str()).collect();
    assert!(names.contains(&"explore"));
    assert!(names.contains(&"plan"));
}

#[test]
fn test_discover_profiles_with_tool_policy() {
    let temp_dir = TempDir::new().unwrap();
    let profiles_dir = temp_dir.path().join(".ergatai").join("profiles");
    fs::create_dir_all(&profiles_dir).unwrap();

    let profile_yaml = r#"
name: restricted-agent
tool_policy:
  allowed:
    - read
    - write
  denied:
    - bash
    - dangerous-tool
"#;

    fs::write(profiles_dir.join("restricted.yaml"), profile_yaml).unwrap();

    let profiles = discover_profiles(temp_dir.path()).unwrap();
    assert_eq!(profiles.len(), 1);

    let profile = &profiles[0];
    assert_eq!(profile.name, "restricted-agent");
    assert!(profile.tool_policy.is_some());

    let policy = profile.tool_policy.as_ref().unwrap();
    assert_eq!(policy.allowed, vec!["read", "write"]);
    assert_eq!(policy.denied, vec!["bash", "dangerous-tool"]);

    // Test tool policy enforcement
    assert!(profile.allows_tool("read"));
    assert!(profile.allows_tool("write"));
    assert!(!profile.allows_tool("bash"));
    assert!(!profile.allows_tool("dangerous-tool"));
    assert!(!profile.allows_tool("unknown-tool")); // Not in allowed list
}

#[test]
fn test_discover_profiles_ignores_non_yaml_files() {
    let temp_dir = TempDir::new().unwrap();
    let profiles_dir = temp_dir.path().join(".ergatai").join("profiles");
    fs::create_dir_all(&profiles_dir).unwrap();

    let profile_yaml = r#"
name: valid-profile
"#;

    fs::write(profiles_dir.join("valid.yaml"), profile_yaml).unwrap();
    fs::write(profiles_dir.join("readme.txt"), "This is not a profile").unwrap();
    fs::write(profiles_dir.join("config.json"), "{}").unwrap();

    let profiles = discover_profiles(temp_dir.path()).unwrap();
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].name, "valid-profile");
}

#[test]
fn test_discover_profiles_duplicate_names_error() {
    let temp_dir = TempDir::new().unwrap();
    let profiles_dir = temp_dir.path().join(".ergatai").join("profiles");
    fs::create_dir_all(&profiles_dir).unwrap();

    let profile1_yaml = r#"
name: duplicate-name
"#;

    let profile2_yaml = r#"
name: duplicate-name
description: Different description
"#;

    fs::write(profiles_dir.join("profile1.yaml"), profile1_yaml).unwrap();
    fs::write(profiles_dir.join("profile2.yaml"), profile2_yaml).unwrap();

    let result = discover_profiles(temp_dir.path());
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.to_string().contains("Duplicate profile name"));
}

#[test]
fn test_load_profile_existing() {
    let temp_dir = TempDir::new().unwrap();
    let profiles_dir = temp_dir.path().join(".ergatai").join("profiles");
    fs::create_dir_all(&profiles_dir).unwrap();

    let profile_yaml = r#"
name: test-profile
description: Test profile
capabilities:
  - testing
"#;

    fs::write(profiles_dir.join("test-profile.yaml"), profile_yaml).unwrap();

    let profile = load_profile(temp_dir.path(), "test-profile").unwrap();
    assert!(profile.is_some());

    let profile = profile.unwrap();
    assert_eq!(profile.name, "test-profile");
    assert_eq!(profile.description, Some("Test profile".to_string()));
    assert_eq!(profile.capabilities, vec!["testing"]);
}

#[test]
fn test_load_profile_nonexistent() {
    let temp_dir = TempDir::new().unwrap();
    let profiles_dir = temp_dir.path().join(".ergatai").join("profiles");
    fs::create_dir_all(&profiles_dir).unwrap();

    let profile = load_profile(temp_dir.path(), "nonexistent").unwrap();
    assert!(profile.is_none());
}

#[test]
fn test_profile_capabilities() {
    let profile = AgentProfile {
        name: "test".to_string(),
        description: None,
        capabilities: vec![
            "code-generation".to_string(),
            "review".to_string(),
            "testing".to_string(),
        ],
        tool_policy: None,
        model_override: None,
        max_concurrency: usize::MAX,
        metadata: std::collections::HashMap::new(),
    };

    assert!(profile.has_capability("code-generation"));
    assert!(profile.has_capability("review"));
    assert!(profile.has_capability("testing"));
    assert!(!profile.has_capability("architecture"));
}
