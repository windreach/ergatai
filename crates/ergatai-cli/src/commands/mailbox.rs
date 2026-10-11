use crate::client::http::ErgataiClient;
use crate::output::formatter;
use crate::MailboxAction;
use anyhow::Result;

pub async fn handle(action: MailboxAction, api_url: &str, token: Option<&str>) -> Result<()> {
    let client = ErgataiClient::new(api_url, token);

    match action {
        MailboxAction::List => {
            let response = client.list_mailboxes().await?;
            formatter::format_mailbox_summary(&response.summary);
            formatter::format_mailbox_list(&response.mailboxes);
        }
        MailboxAction::Show { agent_id } => {
            let mailbox = client.get_agent_mailbox(&agent_id).await?;
            formatter::format_agent_mailbox(&mailbox);
        }
        MailboxAction::Clear { agent_id } => {
            client.clear_agent_mailbox(&agent_id).await?;
            println!("Mailbox cleared for agent: {}", agent_id);
        }
    }

    Ok(())
}
