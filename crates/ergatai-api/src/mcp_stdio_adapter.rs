//! MCP Stdio-HTTP Adapter
//!
//! 一个连接适配器，将 stdio MCP 协议转换为 HTTP MCP 协议。
//! 用于支持只实现 stdio MCP 的 ACP agent 连接到 Ergatai 的 HTTP MCP server。
//!
//! ## 使用场景
//!
//! 当 ACP agent 不支持 MCP-over-ACP 时，作为 fallback：
//! 1. ACP backend 启动此适配器作为子进程
//! 2. 适配器通过 stdio 与 agent 通信
//! 3. 适配器转发请求到 Ergatai 的 HTTP MCP endpoint
//!
//! ## 命令行
//!
//! ```bash
//! mcp-stdio-adapter --url http://localhost:3000/mcp
//! ```
//!
//! ## 环境变量
//!
//! - `ERGATAI_MCP_URL` - HTTP MCP endpoint URL（命令行参数优先）
//! - `ERGATAI_API_TOKEN` - API 认证 token（可选）

use anyhow::{Context, Result};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::io;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

#[derive(Parser, Debug)]
#[command(author, version, about = "MCP stdio to HTTP bridge adapter")]
struct Args {
    /// HTTP MCP endpoint URL
    #[arg(short, long, env = "ERGATAI_MCP_URL")]
    url: String,

    /// API authentication token (optional)
    #[arg(short = 'T', long, env = "ERGATAI_API_TOKEN")]
    token: Option<String>,

    /// Request timeout in seconds
    #[arg(short = 't', long, default_value = "30")]
    timeout: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<serde_json::Value>,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcError {
    code: i32,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // 初始化日志（输出到 stderr，不干扰 stdio）
    tracing_subscriber::fmt()
        .with_writer(io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing_subscriber::filter::LevelFilter::INFO.into()),
        )
        .init();

    tracing::info!("MCP stdio-HTTP adapter started");
    tracing::info!("HTTP endpoint: {}", args.url);

    // 创建 HTTP 客户端
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(args.timeout))
        .build()
        .context("Failed to create HTTP client")?;

    // 从 stdin 读取 JSON-RPC 请求
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut reader = tokio::io::BufReader::new(stdin);

    let mut line = String::new();
    loop {
        line.clear();

        // 读取一行 JSON-RPC 请求
        let bytes_read = reader
            .read_line(&mut line)
            .await
            .context("Failed to read from stdin")?;

        if bytes_read == 0 {
            tracing::info!("stdin closed, exiting");
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        tracing::debug!("Received request: {}", trimmed);

        // 解析 JSON-RPC 请求
        let request: JsonRpcRequest = match serde_json::from_str(trimmed) {
            Ok(req) => req,
            Err(e) => {
                tracing::error!("Failed to parse JSON-RPC request: {}", e);
                let error_response = JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: None,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32700,
                        message: format!("Parse error: {}", e),
                        data: None,
                    }),
                };
                let response_str = serde_json::to_string(&error_response)?;
                stdout.write_all(response_str.as_bytes()).await?;
                stdout.write_all(b"\n").await?;
                stdout.flush().await?;
                continue;
            }
        };

        // 转发到 HTTP endpoint
        let http_result = forward_to_http(&client, &args.url, &args.token, &request).await;

        // 构建响应
        let response = match http_result {
            Ok(resp) => resp,
            Err(e) => {
                tracing::error!("HTTP request failed: {}", e);
                JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: request.id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32603,
                        message: format!("Internal error: {}", e),
                        data: None,
                    }),
                }
            }
        };

        // 输出响应到 stdout
        let response_str = serde_json::to_string(&response)?;
        tracing::debug!("Sending response: {}", response_str);
        stdout.write_all(response_str.as_bytes()).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
    }

    Ok(())
}

async fn forward_to_http(
    client: &reqwest::Client,
    url: &str,
    token: &Option<String>,
    request: &JsonRpcRequest,
) -> Result<JsonRpcResponse> {
    // 构建 HTTP 请求
    let mut http_req = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(request);

    // 添加认证 token（如果有）
    if let Some(ref t) = token {
        http_req = http_req.header("Authorization", format!("Bearer {}", t));
    }

    // 发送 HTTP 请求
    let http_resp = http_req.send().await.context("HTTP request failed")?;

    let status = http_resp.status();
    let body = http_resp
        .text()
        .await
        .context("Failed to read response body")?;

    tracing::debug!("HTTP response status: {}, body: {}", status, body);

    // 解析 HTTP 响应
    if !status.is_success() {
        return Err(anyhow::anyhow!("HTTP error {}: {}", status, body));
    }

    let response: JsonRpcResponse =
        serde_json::from_str(&body).context("Failed to parse JSON-RPC response")?;

    Ok(response)
}
