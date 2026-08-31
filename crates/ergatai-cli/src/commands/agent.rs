use crate::client::http::ErgataiClient;
use crate::output::formatter;
use crate::AgentAction;
use anyhow::Result;

pub async fn handle(action: AgentAction, api_url: &str, token: Option<&str>) -> Result<()> {
    let client = ErgataiClient::new(api_url, token);

    match action {
        AgentAction::List => {
            let agents = client.list_agents().await?;
            formatter::format_agents_table(&agents);
        }
        AgentAction::Spawn {
            workspace,
            command,
            instruction,
        } => {
            let response = client
                .spawn_agent(&workspace, &command, None, instruction.as_deref())
                .await?;
            println!("Spawned agent: {}", response.agent_id);
        }
        AgentAction::SpawnFrom {
            profile,
            workspace,
            instruction,
        } => {
            // Fetch the profile to get the command
            let profiles = client.list_profiles().await?;
            let profile_data = profiles
                .profiles
                .iter()
                .find(|p| p.name == profile)
                .ok_or_else(|| anyhow::anyhow!("Profile '{}' not found", profile))?;

            let workspace_id = workspace.unwrap_or_else(|| profile.clone());
            let response = client
                .spawn_agent(
                    &workspace_id,
                    &profile_data.command,
                    None,
                    instruction.as_deref(),
                )
                .await?;
            println!(
                "Spawned agent '{}' from profile '{}'",
                response.agent_id, profile
            );
        }
        AgentAction::Kill { id } => {
            client.kill_agent(&id).await?;
            println!("Stopped agent: {}", id);
        }
        AgentAction::Message { id, message } => {
            client.send_message(&id, &message).await?;
            println!("Message sent to agent: {}", id);
        }
        AgentAction::Register {
            name,
            command,
            agent_type,
        } => {
            // Interactive mode if any argument is missing
            let (name, command, agent_type) = if name.is_none() || command.is_none() {
                println!("📝 Register a new agent profile");
                println!("   (Press Enter to use defaults, Ctrl+C to cancel)\n");

                let name = match name {
                    Some(n) => n,
                    None => super::prompt::prompt_required("Profile name"),
                };

                let command = match command {
                    Some(c) => c,
                    None => super::prompt::prompt_required("Command to start agent"),
                };

                let agent_type = match agent_type {
                    Some(t) => t,
                    None => super::prompt::prompt_with_default("Agent type", "acp"),
                };

                (name, command, agent_type)
            } else {
                (name.unwrap(), command.unwrap(), agent_type.unwrap_or_else(|| "acp".to_string()))
            };

            client.register_profile(&name, &command, &agent_type).await?;
            println!("\n✅ Registered agent profile: {}", name);
        }
        AgentAction::Profiles => {
            let profiles = client.list_profiles().await?;
            if profiles.profiles.is_empty() {
                println!("No agent profiles registered");
            } else {
                println!("{:<20} {:<30} {:<10} {}", "NAME", "COMMAND", "TYPE", "CREATED");
                println!("{}", "-".repeat(80));
                for p in profiles.profiles {
                    println!(
                        "{:<20} {:<30} {:<10} {}",
                        p.name, p.command, p.agent_type, p.created_at
                    );
                }
            }
        }
        AgentAction::DeleteProfile { name } => {
            client.delete_profile(&name).await?;
            println!("Deleted agent profile: {}", name);
        }
    }

    Ok(())
}
