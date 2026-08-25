//! POC: Claude ACP Adapter Integration
//!
//! This demo validates the approach of using external ACP adapters
//! to get structured events from agents.
//!
//! Architecture:
//!   Ergatai (Rust) → Claude ACP Adapter (Node.js) → Claude Code
//!                    ↑ JSON-RPC events
//!
//! Usage:
//!   cargo run --example claude_acp_poc

use std::process::{Child, Command, Stdio};
use std::io::{BufRead, BufReader, Write};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// ACP JSON-RPC message
#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcMessage {
    jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<serde_json::Value>,
}

struct ClaudeAcpAdapter {
    process: Child,
    stdin: std::process::ChildStdin,
    stdout: std::process::ChildStdout,
}

impl ClaudeAcpAdapter {
    /// Start the Claude ACP adapter
    fn start() -> Result<Self, Box<dyn std::error::Error>> {
        println!("🚀 Starting Claude ACP adapter...");

        let mut process = Command::new("npx")
            .args(&[
                "-y",  // Auto-confirm installation
                "@agentclientprotocol/claude-agent-acp",
                "--stdio",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())  // Show adapter logs
            .spawn()?;

        let stdin = process.stdin.take().ok_or("Failed to get stdin")?;
        let stdout = process.stdout.take().ok_or("Failed to get stdout")?;

        println!("✅ Claude ACP adapter started (PID: {})", process.id());

        Ok(Self {
            process,
            stdin,
            stdout,
        })
    }

    /// Send a JSON-RPC message to the adapter
    fn send_message(&mut self, msg: &JsonRpcMessage) -> Result<(), Box<dyn std::error::Error>> {
        let json = serde_json::to_string(msg)?;
        println!("📤 Sending: {}", json);
        writeln!(self.stdin, "{}", json)?;
        self.stdin.flush()?;
        Ok(())
    }

    /// Initialize the ACP session
    fn initialize(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        let init_msg = JsonRpcMessage {
            jsonrpc: "2.0".to_string(),
            id: Some(json!(1)),
            method: Some("initialize".to_string()),
            params: Some(json!({
                "protocolVersion": 1,
                "clientInfo": {
                    "name": "ergatai-poc",
                    "version": "0.1.0"
                }
            })),
            result: None,
            error: None,
        };

        self.send_message(&init_msg)?;
        Ok(())
    }

    /// Create a new session
    fn create_session(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        let session_msg = JsonRpcMessage {
            jsonrpc: "2.0".to_string(),
            id: Some(json!(2)),
            method: Some("session/new".to_string()),
            params: Some(json!({
                "cwd": std::env::current_dir()?.to_string_lossy().to_string()
            })),
            result: None,
            error: None,
        };

        self.send_message(&session_msg)?;
        Ok(())
    }

    /// Send a prompt to the agent
    fn send_prompt(&mut self, session_id: &str, prompt: &str) -> Result<(), Box<dyn std::error::Error>> {
        let prompt_msg = JsonRpcMessage {
            jsonrpc: "2.0".to_string(),
            id: Some(json!(3)),
            method: Some("session/prompt".to_string()),
            params: Some(json!({
                "sessionId": session_id,
                "prompt": prompt
            })),
            result: None,
            error: None,
        };

        self.send_message(&prompt_msg)?;
        Ok(())
    }

    /// Handle an ACP event
    fn handle_event(&self, msg: &JsonRpcMessage) {
        // Handle responses (with id)
        if let Some(id) = &msg.id {
            if let Some(result) = &msg.result {
                println!("✅ Response [id={}]: {}", id, serde_json::to_string_pretty(result).unwrap());
            }
            if let Some(error) = &msg.error {
                println!("❌ Error [id={}]: {}", id, serde_json::to_string_pretty(error).unwrap());
            }
            return;
        }

        // Handle notifications (no id)
        if let Some(method) = &msg.method {
            match method.as_str() {
                "turn/started" => {
                    println!("🎬 Turn Started");
                    if let Some(params) = &msg.params {
                        println!("   Session: {:?}", params.get("sessionId"));
                        println!("   Turn ID: {:?}", params.get("turnId"));
                    }
                }
                "item/agentMessage/delta" => {
                    if let Some(params) = &msg.params {
                        if let Some(delta) = params.get("delta").and_then(|d| d.as_str()) {
                            print!("{}", delta);  // Stream output
                        }
                    }
                }
                "item/reasoning/textDelta" => {
                    if let Some(params) = &msg.params {
                        if let Some(delta) = params.get("delta").and_then(|d| d.as_str()) {
                            print!("\x1b[90m{}\x1b[0m", delta);  // Gray for reasoning
                        }
                    }
                }
                "item/tool/call" => {
                    if let Some(params) = &msg.params {
                        let tool_name = params.get("name").and_then(|n| n.as_str()).unwrap_or("unknown");
                        println!("\n🔧 Tool Call: {}", tool_name);
                        if let Some(input) = params.get("input") {
                            println!("   Input: {}", serde_json::to_string(input).unwrap());
                        }
                    }
                }
                "item/started" => {
                    println!("\n📦 Item Started");
                    if let Some(params) = &msg.params {
                        println!("   Item ID: {:?}", params.get("itemId"));
                        println!("   Type: {:?}", params.get("itemType"));
                    }
                }
                "item/completed" => {
                    println!("\n✅ Item Completed");
                    if let Some(params) = &msg.params {
                        println!("   Item ID: {:?}", params.get("itemId"));
                    }
                }
                "turn/completed" => {
                    println!("\n🏁 Turn Completed");
                    if let Some(params) = &msg.params {
                        println!("   Stop Reason: {:?}", params.get("stopReason"));
                        if let Some(usage) = params.get("usage") {
                            println!("   Usage: {}", serde_json::to_string(usage).unwrap());
                        }
                    }
                }
                "turn/error" => {
                    println!("\n❌ Turn Error");
                    if let Some(params) = &msg.params {
                        println!("   Error: {}", serde_json::to_string(params).unwrap());
                    }
                }
                _ => {
                    println!("📨 Notification: {} - {}", method, serde_json::to_string(&msg.params).unwrap());
                }
            }
        }
    }
}

impl Drop for ClaudeAcpAdapter {
    fn drop(&mut self) {
        println!("\n🛑 Stopping Claude ACP adapter...");
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("═══════════════════════════════════════════");
    println!("  Claude ACP Adapter POC");
    println!("  Testing external adapter integration");
    println!("═══════════════════════════════════════════\n");

    // Start the adapter
    let mut adapter = ClaudeAcpAdapter::start()?;

    // Give it a moment to start
    std::thread::sleep(std::time::Duration::from_millis(2000));

    // Initialize ACP
    println!("\n📡 Initializing ACP protocol...");
    adapter.initialize()?;

    // Wait for initialization response
    std::thread::sleep(std::time::Duration::from_millis(1000));

    // Create session
    println!("\n📡 Creating session...");
    adapter.create_session()?;

    // Wait for session creation
    std::thread::sleep(std::time::Duration::from_millis(1000));

    // Send a test prompt
    println!("\n📡 Sending test prompt...");
    adapter.send_prompt("session-1", "你好！请简单介绍一下你自己，用一两句话。")?;

    // Keep reading events
    println!("\n✨ Reading events (press Ctrl+C to stop)...\n");

    // Read events from stdout
    let reader = BufReader::new(&adapter.stdout);
    for line in reader.lines() {
        match line {
            Ok(line) => {
                if line.trim().is_empty() {
                    continue;
                }

                match serde_json::from_str::<JsonRpcMessage>(&line) {
                    Ok(msg) => {
                        adapter.handle_event(&msg);
                    }
                    Err(e) => {
                        println!("⚠️  Parse error: {} - Raw: {}", e, line);
                    }
                }
            }
            Err(e) => {
                println!("❌ Read error: {}", e);
                break;
            }
        }
    }

    Ok(())
}
