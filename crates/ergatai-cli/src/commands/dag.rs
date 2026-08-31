use crate::client::http::ErgataiClient;
use crate::output::formatter;
use crate::DagAction;
use anyhow::Result;
use std::fs;

pub async fn handle(action: DagAction, api_url: &str, token: Option<&str>) -> Result<()> {
    let client = ErgataiClient::new(api_url, token);

    match action {
        DagAction::List => {
            let dags = client.list_dags().await?;
            formatter::format_dags_table(&dags);
        }
        DagAction::Status { dag_id } => {
            let status = client.get_dag_status(dag_id.as_deref()).await?;
            formatter::format_dag_status(&status);
        }
        DagAction::Submit { file } => {
            let content = fs::read_to_string(&file)?;
            let response = client.submit_dag(&content).await?;
            println!("DAG submitted: {} ({} nodes)", response.status, response.submitted_nodes);
        }
    }

    Ok(())
}
