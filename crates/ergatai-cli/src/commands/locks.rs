use crate::client::http::ErgataiClient;
use crate::output::formatter;
use crate::LocksAction;
use anyhow::Result;

pub async fn handle(action: LocksAction, api_url: &str, token: Option<&str>) -> Result<()> {
    let client = ErgataiClient::new(api_url, token);

    match action {
        LocksAction::List => {
            let locks = client.list_locks().await?;
            formatter::format_locks_table(&locks);
        }
        LocksAction::Contention => {
            let contentions = client.get_lock_contention().await?;
            formatter::format_contention_table(&contentions);
        }
    }

    Ok(())
}
