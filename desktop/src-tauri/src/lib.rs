use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentInfo {
    pub agent_id: String,
    pub workspace_id: String,
    pub state: String,
    pub created_at: String,
}

#[tauri::command]
async fn get_agents(api_url: String) -> Result<Vec<AgentInfo>, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(&format!("{}/api/v1/agents", api_url))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("API error: {}", response.status()));
    }

    response.json::<Vec<AgentInfo>>().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_status(api_url: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(&format!("{}/api/v1/status", api_url))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("API error: {}", response.status()));
    }

    response.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_agents, get_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
