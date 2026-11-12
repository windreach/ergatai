//! Provider connection metadata and secret resolution.
//!
//! Non-secret routing metadata lives in SQLite. API keys live in the OS
//! credential store and are referenced by `auth_ref`, so provider configuration
// can be shared across agent profiles without duplicating secrets.

use anyhow::{anyhow, Result};
use keyring::Entry;
use std::collections::HashMap;

use crate::user_data_db::provider_connections::{
    self, ProviderConnection, ProviderConnectionUpsert,
};

const KEYRING_SERVICE: &str = "ergatai";

fn validate_protocol(protocol: &str) -> Result<()> {
    match protocol {
        "anthropic" | "openai_compatible" | "opencode" => Ok(()),
        other => Err(anyhow!("Unsupported provider protocol: {}", other)),
    }
}

fn entry(connection: &ProviderConnection) -> Result<Entry> {
    let auth_ref = connection
        .auth_ref
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("Provider connection has no auth reference"))?;
    Entry::new(KEYRING_SERVICE, auth_ref)
        .map_err(|error| anyhow!("Failed to open credential entry: {}", error))
}

pub fn set_secret(connection: &ProviderConnection, api_key: &str) -> Result<()> {
    if api_key.trim().is_empty() {
        return Err(anyhow!("API key cannot be empty"));
    }
    entry(connection)?
        .set_password(api_key.trim())
        .map_err(|error| anyhow!("Failed to store API key in OS credential store: {}", error))
}

pub fn get_secret(connection: &ProviderConnection) -> Result<Option<String>> {
    let Some(_) = connection
        .auth_ref
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(None);
    };
    match entry(connection)?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(anyhow!(
            "Failed to read API key from OS credential store: {}",
            error
        )),
    }
}

pub fn delete_secret(connection: &ProviderConnection) -> Result<()> {
    match entry(connection)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(anyhow!(
            "Failed to delete API key from OS credential store: {}",
            error
        )),
    }
}

pub fn list() -> Result<Vec<ProviderConnection>> {
    provider_connections::list()
        .map_err(|error| anyhow!("Failed to list provider connections: {}", error))
}

pub fn get(id: &str) -> Result<ProviderConnection> {
    provider_connections::get(id)
        .map_err(|error| anyhow!("Failed to load provider connection: {}", error))?
        .ok_or_else(|| anyhow!("Provider connection not found: {}", id))
}

/// Resolve an explicit connection, falling back to the agent's marked default.
///
/// `agent_id` is the owning agent profile name (e.g. "claude-code"). When
/// provided, an explicit id pointing at a connection owned by a different
/// agent is rejected, and the implicit default is scoped to the agent's own
/// connections. Connections bound to other agents are never shared.
pub fn resolve(id: Option<&str>, agent_id: Option<&str>) -> Result<Option<ProviderConnection>> {
    if let Some(id) = id.filter(|id| !id.trim().is_empty()) {
        let connection = get(id.trim())?;
        if let Some(agent_id) = agent_id.filter(|agent| !agent.trim().is_empty()) {
            if !connection.agent_id.is_empty() && connection.agent_id != agent_id {
                return Err(anyhow!(
                    "Provider connection '{}' belongs to agent '{}', not '{}'",
                    connection.name,
                    connection.agent_id,
                    agent_id
                ));
            }
        }
        return Ok(Some(connection));
    }

    let agent_filter = agent_id.filter(|agent| !agent.trim().is_empty());
    let mut candidates: Vec<ProviderConnection> = list()?
        .into_iter()
        .filter(|connection| match agent_filter {
            Some(agent_id) => connection.agent_id == agent_id,
            None => true,
        })
        .collect();
    candidates.sort_by_key(|b| std::cmp::Reverse(b.is_default));
    Ok(candidates.into_iter().next())
}

pub fn upsert(
    input: ProviderConnectionUpsert,
    api_key: Option<&str>,
) -> Result<ProviderConnection> {
    validate_protocol(&input.protocol)?;
    let saved = provider_connections::upsert(input)
        .map_err(|error| anyhow!("Failed to save provider connection: {}", error))?;
    if let Some(api_key) = api_key.filter(|value| !value.trim().is_empty()) {
        set_secret(&saved, api_key)?;
    }
    Ok(saved)
}

pub fn delete(id: &str) -> Result<bool> {
    let connection = provider_connections::get(id)
        .map_err(|error| anyhow!("Failed to load provider connection: {}", error))?;
    let deleted = provider_connections::delete(id)
        .map_err(|error| anyhow!("Failed to delete provider connection: {}", error))?;
    if deleted {
        if let Some(connection) = connection {
            delete_secret(&connection)?;
        }
    }
    Ok(deleted)
}

pub fn set_default(id: &str) -> Result<ProviderConnection> {
    let existing = get(id)?;
    provider_connections::upsert(ProviderConnectionUpsert {
        id: Some(existing.id.clone()),
        name: existing.name.clone(),
        agent_id: existing.agent_id.clone(),
        protocol: existing.protocol.clone(),
        base_url: existing.base_url.clone(),
        default_model: existing.default_model.clone(),
        is_default: true,
    })
    .map_err(|error| anyhow!("Failed to set default provider connection: {}", error))
}

/// Build the provider-specific environment for a newly spawned agent. Values
// are used only in-memory and never persisted into workspace state.
pub fn env_for_connection(connection: &ProviderConnection) -> Result<HashMap<String, String>> {
    let mut env = HashMap::new();
    if let Some(base_url) = connection
        .base_url
        .as_deref()
        .filter(|v| !v.trim().is_empty())
    {
        match connection.protocol.as_str() {
            "anthropic" => {
                env.insert(
                    "ANTHROPIC_BASE_URL".to_string(),
                    base_url.trim().to_string(),
                );
            }
            "openai_compatible" => {
                env.insert("OPENAI_BASE_URL".to_string(), base_url.trim().to_string());
                env.insert("LLM_BASE_URL".to_string(), base_url.trim().to_string());
            }
            "opencode" => {
                env.insert("OPENCODE_BASE_URL".to_string(), base_url.trim().to_string());
                env.insert("OPENCODE_URL".to_string(), base_url.trim().to_string());
            }
            _ => {
                return Err(anyhow!(
                    "Unsupported provider protocol: {}",
                    connection.protocol
                ))
            }
        }
    }

    if let Some(api_key) = get_secret(connection)? {
        match connection.protocol.as_str() {
            "anthropic" => {
                env.insert("ANTHROPIC_API_KEY".to_string(), api_key.clone());
                env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), api_key.clone());
            }
            "openai_compatible" => {
                env.insert("OPENAI_API_KEY".to_string(), api_key.clone());
                env.insert("LLM_API_KEY".to_string(), api_key.clone());
            }
            "opencode" => {
                env.insert("OPENCODE_API_KEY".to_string(), api_key.clone());
            }
            _ => {
                return Err(anyhow!(
                    "Unsupported provider protocol: {}",
                    connection.protocol
                ))
            }
        }
    }

    if let Some(model) = connection
        .default_model
        .as_deref()
        .filter(|v| !v.trim().is_empty())
    {
        match connection.protocol.as_str() {
            "anthropic" => {
                env.insert("ANTHROPIC_MODEL".to_string(), model.trim().to_string());
            }
            "openai_compatible" => {
                env.insert("OPENAI_MODEL".to_string(), model.trim().to_string());
            }
            _ => {}
        }
    }

    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::user_data_db::provider_connections::ProviderConnection;

    fn test_connection(protocol: &str) -> ProviderConnection {
        ProviderConnection {
            id: format!("conn-{}", protocol),
            name: protocol.to_string(),
            agent_id: "claude-code".to_string(),
            protocol: protocol.to_string(),
            base_url: Some("https://provider.example.com".to_string()),
            auth_ref: None,
            default_model: Some("test-model".to_string()),
            is_default: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn builds_provider_env_for_anthropic() {
        let env = env_for_connection(&test_connection("anthropic")).unwrap();
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL").map(String::as_str),
            Some("https://provider.example.com")
        );
        assert_eq!(
            env.get("ANTHROPIC_MODEL").map(String::as_str),
            Some("test-model")
        );
        assert!(!env.contains_key("OPENAI_API_KEY"));
    }

    #[test]
    fn builds_provider_env_for_openai_compatible() {
        let env = env_for_connection(&test_connection("openai_compatible")).unwrap();
        assert_eq!(
            env.get("OPENAI_BASE_URL").map(String::as_str),
            Some("https://provider.example.com")
        );
        assert_eq!(
            env.get("LLM_BASE_URL").map(String::as_str),
            Some("https://provider.example.com")
        );
        assert_eq!(
            env.get("OPENAI_MODEL").map(String::as_str),
            Some("test-model")
        );
    }

    #[test]
    fn builds_provider_env_for_opencode() {
        let env = env_for_connection(&test_connection("opencode")).unwrap();
        assert_eq!(
            env.get("OPENCODE_URL").map(String::as_str),
            Some("https://provider.example.com")
        );
        assert!(!env.contains_key("ANTHROPIC_API_KEY"));
    }
}
