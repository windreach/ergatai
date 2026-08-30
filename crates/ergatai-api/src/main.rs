//! Ergatai API Server - HTTP/WebSocket API for Ergatai
//!
//! This server provides a REST API and WebSocket interface for interacting
//! with Ergatai's multi-agent collaboration features.
//!
//! # Usage
//!
//! ```bash
//! ergatai-api --port 3000
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::Result;
use axum::Router;
use axum::http::HeaderValue;
use clap::Parser;
use tokio_util::sync::CancellationToken;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

use ergatai_api::mcp::{
    create_mcp_service, spawn_request_monitor_with_cancel, start_message_delivery_consumer,
    start_peer_reaper,
};
use ergatai_api::messaging::{get_message_sender, init_message_sender};
use ergatai_api::{app_state_with_token, build_rest_app};
use ergatai_core::cross_agent::{set_dag_scheduler, DagScheduler};
use ergatai_core::nats;

#[derive(Parser)]
#[command(name = "ergatai-api")]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Port to listen on
    #[arg(short, long, default_value = "3000")]
    port: u16,

    /// Host to bind to
    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    /// Enable verbose logging
    #[arg(short, long)]
    verbose: bool,

    /// API token for authentication. If not provided, API is open to all local clients.
    /// Can also be set via ERGATAI_API_TOKEN environment variable.
    #[arg(long, env = "ERGATAI_API_TOKEN")]
    api_token: Option<String>,

    /// TLS certificate file (PEM format) for HTTPS support.
    /// Can also be set via ERGATAI_TLS_CERT environment variable.
    #[arg(long, env = "ERGATAI_TLS_CERT")]
    tls_cert: Option<PathBuf>,

    /// TLS private key file (PEM format) for HTTPS support.
    #[arg(long, env = "ERGATAI_TLS_KEY")]
    tls_key: Option<PathBuf>,

    /// SSE keep-alive interval in seconds. Lower values detect dead clients faster
    /// but increase network traffic. Default: 15.
    /// Can also be set via ERGATAI_SSE_KEEP_ALIVE environment variable.
    #[arg(long, env = "ERGATAI_SSE_KEEP_ALIVE", default_value = "15")]
    sse_keep_alive: u64,

    /// Agent runtime backend. Controls how agent workspaces (panes) are created.
    /// Currently only `pty` (direct PTY) is supported.
    /// Can also be set via ERGATAI_RUNTIME_BACKEND environment variable.
    #[arg(long, env = "ERGATAI_RUNTIME_BACKEND", default_value = "pty")]
    runtime_backend: String,

    /// Session name prefix for the agent runtime backend.
    /// Workspace names will be `{prefix}-{workspace_id}`.
    /// Can also be set via ERGATAI_SESSION_PREFIX environment variable.
    #[arg(long, env = "ERGATAI_SESSION_PREFIX", default_value = "ergatai")]
    session_prefix: String,
}

/// Parse arguments and set environment variables BEFORE the tokio runtime starts.
fn setup_env_before_runtime() -> Args {
    let args = Args::parse();

    if args.verbose {
        // Safety: called before tokio runtime starts, only main thread exists.
        // Set ergatai=debug specifically to override the ergatai=info baseline
        // in init_logging(). A bare "debug" would be overridden by the more
        // specific "ergatai=info" directive.
        unsafe { std::env::set_var("RUST_LOG", "ergatai=debug,async_nats=info") };
    }

    args
}

fn main() -> Result<()> {
    let args = setup_env_before_runtime();
    tokio::runtime::Runtime::new()?.block_on(async_main(args))
}

async fn async_main(args: Args) -> Result<()> {
    ergatai_core::init_logging();
    ergatai_core::init_panic_hook();

    ergatai_api::init_prometheus();
    tracing::info!("Prometheus metrics exporter initialized");

    if let Err(e) = ergatai_core::setup_signal_handlers().await {
        eprintln!("Warning: failed to install signal handlers: {}", e);
    }

    tracing::info!("Starting Ergatai API server on {}:{}", args.host, args.port);

    if args.api_token.is_some() {
        tracing::info!("API authentication enabled");
    } else {
        tracing::info!("API authentication disabled - API is open to all clients");
    }

    // Validate TLS configuration
    let tls_enabled = args.tls_cert.is_some() || args.tls_key.is_some();
    if tls_enabled {
        match (&args.tls_cert, &args.tls_key) {
            (Some(cert), Some(key)) => {
                if !cert.exists() {
                    return Err(anyhow::anyhow!(
                        "TLS certificate file not found: {}",
                        cert.display()
                    ));
                }
                if !key.exists() {
                    return Err(anyhow::anyhow!("TLS key file not found: {}", key.display()));
                }
                tracing::info!("TLS enabled with certificate: {}", cert.display());
            }
            (Some(_), None) => {
                return Err(anyhow::anyhow!(
                    "--tls-key is required when --tls-cert is provided"
                ));
            }
            (None, Some(_)) => {
                return Err(anyhow::anyhow!(
                    "--tls-cert is required when --tls-key is provided"
                ));
            }
            (None, None) => unreachable!(),
        }
    } else {
        tracing::warn!(
            "TLS disabled - using plaintext HTTP. Provide --tls-cert and --tls-key for HTTPS."
        );
    }

    // Initialize MCP server
    let mcp_registry = std::sync::Arc::new(ergatai_api::mcp::AgentRegistry::new());
    let peer_registry = ergatai_api::mcp::server::new_peer_registry();

    // Initialize AgentRuntime with PTY backend (the only supported backend)
    let runtime_backend_name = args.runtime_backend.to_lowercase();
    if runtime_backend_name != "pty" {
        return Err(anyhow::anyhow!(
            "Unknown runtime backend '{}'. Only 'pty' is supported.",
            runtime_backend_name
        ));
    }
    let runtime_backend: std::sync::Arc<dyn ergatai_runtime::AgentRuntimeBackend> =
        std::sync::Arc::new(ergatai_runtime::PtyBackend::new());

    let mcp_cancellation_token = CancellationToken::new();

    match ergatai_runtime::init_agent_runtime(runtime_backend) {
        Ok(runtime) => {
            if let Err(e) = runtime.initialize().await {
                tracing::warn!("AgentRuntime backend initialization warning: {}", e);
            }
            tracing::info!(
                "AgentRuntime initialized (backend: pty, session prefix: {})",
                args.session_prefix
            );

            match runtime.discover_and_register_agents().await {
                Ok(count) if count > 0 => {
                    tracing::info!("Discovered {} running agent(s)", count);
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!("Agent discovery scan failed (non-fatal): {}", e);
                }
            }

            let periodic_runtime = runtime.clone();
            let periodic_cancel = mcp_cancellation_token.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
                interval.tick().await;
                loop {
                    tokio::select! {
                        _ = periodic_cancel.cancelled() => {
                            tracing::debug!("Periodic discovery shutting down");
                            break;
                        }
                        _ = interval.tick() => {
                            match periodic_runtime.discover_and_register_agents().await {
                                Ok(count) if count > 0 => {
                                    tracing::info!("Periodic discovery: found {} new agent(s)", count);
                                }
                                Ok(_) => {}
                                Err(e) => {
                                    tracing::debug!(error = %e, "Periodic discovery scan failed (will retry)");
                                }
                            }
                            let pruned = periodic_runtime.prune_unhealthy_agents().await;
                            if !pruned.is_empty() {
                                tracing::info!(count = pruned.len(), "pruned unhealthy agents");
                            }
                        }
                    }
                }
            });
        }
        Err(e) => {
            tracing::error!("Failed to initialize AgentRuntime: {}", e);
            return Err(anyhow::anyhow!("AgentRuntime initialization failed: {}", e));
        }
    }

    // Create MCP services
    // Initialize the global MessageSender so both REST API and MCP use the same pipeline.
    init_message_sender();

    // Initialize persistent binding store for MCP reconnection support
    // Store bindings in .ergatai directory alongside other ergatai data
    let binding_db_path = ".ergatai/agent_bindings.db";
    match ergatai_api::mcp::init_binding_store(binding_db_path) {
        Ok(_) => tracing::info!("Agent binding store initialized at {}", binding_db_path),
        Err(e) => tracing::warn!("Failed to initialize binding store: {}", e),
    }

    let mcp_service_1 = create_mcp_service(
        mcp_registry.clone(),
        peer_registry.clone(),
        mcp_cancellation_token.clone(),
        args.sse_keep_alive,
        Some("agent-1".to_string()),
    );
    let mcp_service_2 = create_mcp_service(
        mcp_registry.clone(),
        peer_registry.clone(),
        mcp_cancellation_token.clone(),
        args.sse_keep_alive,
        Some("agent-2".to_string()),
    );
    let mcp_service_3 = create_mcp_service(
        mcp_registry.clone(),
        peer_registry.clone(),
        mcp_cancellation_token.clone(),
        args.sse_keep_alive,
        Some("agent-3".to_string()),
    );
    let mcp_service_default = create_mcp_service(
        mcp_registry.clone(),
        peer_registry.clone(),
        mcp_cancellation_token.clone(),
        args.sse_keep_alive,
        None,
    );
    tracing::info!(
        "MCP server initialized (protocol 2025-06-18, Streamable HTTP, SSE keep-alive: {}s)",
        args.sse_keep_alive
    );

    // Start background reapers
    start_peer_reaper(
        mcp_registry.clone(),
        peer_registry.clone(),
        mcp_cancellation_token.clone(),
    );

    // Initialize NATS
    match nats::init_nats().await {
        Ok(conn) => {
            tracing::info!("✅ NATS initialized successfully");

            let delivery_handle =
                start_message_delivery_consumer(conn, mcp_cancellation_token.clone());
            let cancel_monitor = mcp_cancellation_token.clone();
            tokio::spawn(async move {
                match delivery_handle.await {
                    Ok(()) if !cancel_monitor.is_cancelled() => {
                        tracing::error!("Message delivery consumer exited unexpectedly — agent message delivery is broken.");
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "Message delivery consumer panicked — agent message delivery is broken.");
                    }
                    _ => {}
                }
            });

            // Start request monitor background task (reqwatch)
            if let Some(sender) = get_message_sender() {
                let monitor = sender.request_monitor.clone();
                let cancel_monitor = mcp_cancellation_token.clone();
                tokio::spawn(async move {
                    spawn_request_monitor_with_cancel(monitor, cancel_monitor).await;
                });
                tracing::info!("✅ Request monitor (reqwatch) started");
            }

            // Initialize activity feed for dashboard
            let activity_feed = ergatai_api::api::activity::init_activity_feed();
            if let Err(e) = activity_feed.start_nats_consumers().await {
                tracing::warn!("Activity feed initialization failed: {}", e);
            } else {
                tracing::info!("✅ Activity feed started (dashboard real-time events)");
            }

            // File access control
            let project_root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let runtime_for_resolver = ergatai_runtime::get_agent_runtime();
            let pid_resolver = ergatai_lock::CallbackPidResolver::with_cache(
                {
                    let runtime = runtime_for_resolver.clone();
                    move || {
                        let agents = tokio::task::block_in_place(|| {
                            tokio::runtime::Handle::current().block_on(runtime.list_agents())
                        });
                        agents
                            .into_iter()
                            .filter_map(|info| {
                                let pid: u32 = info.handle.process_id?.parse().ok()?;
                                Some((pid, info.agent_id.clone(), info.workspace_id.clone()))
                            })
                            .collect()
                    }
                },
                std::time::Duration::from_millis(50),
            );

            if let Err(e) = ergatai_lock::init_file_access_with_enforcer(
                "default",
                &project_root,
                std::sync::Arc::new(pid_resolver),
            )
            .await
            {
                tracing::warn!("File access control initialization failed: {}", e);
            } else {
                tracing::info!("✅ File access control initialized");
            }

            // DAG recovery
            match DagScheduler::load_all_from_disk(project_root.clone()).await {
                Ok(schedulers) if !schedulers.is_empty() => {
                    tracing::info!("🔄 Recovering {} DAG(s) from disk...", schedulers.len());
                    for scheduler in schedulers {
                        let dag_id = scheduler.dag_id().to_string();
                        tracing::info!(dag_id = %dag_id, "Recovering DAG...");
                        if let Err(e) = scheduler.rollback_running_nodes().await {
                            tracing::warn!(dag_id = %dag_id, "Failed to rollback: {}", e);
                            continue;
                        }

                        // Check if DAG still has viable nodes after rollback
                        let status_counts = scheduler.count_nodes_by_status().await;
                        let has_viable = scheduler.has_viable_nodes().await;

                        if !has_viable {
                            tracing::warn!(
                                dag_id = %dag_id,
                                ?status_counts,
                                "⚠️ DAG has no viable nodes after recovery (all Failed/Completed/Skipped), skipping"
                            );
                            // Clean up stale state files to prevent re-loading on next restart.
                            //
                            // SECURITY: `dag_id` is user-controlled (parsed from the YAML submitted
                            // via submit_orchestration). Reject any value that could escape the
                            // `.ergatai/` directory via path traversal (.. / \ NUL). The YAML parser
                            // already trims and requires non-empty names, but defense-in-depth here
                            // protects against a malicious dag_id sneaking through a future change.
                            let ergatai_dir = project_root.join(".ergatai");
                            if dag_id.contains("..")
                                || dag_id.contains('/')
                                || dag_id.contains('\\')
                                || dag_id.contains('\0')
                            {
                                tracing::warn!(
                                    dag_id = %dag_id,
                                    "Refusing to delete DAG state files — dag_id contains path-traversal characters"
                                );
                                continue;
                            }
                            let state_file = ergatai_dir.join(format!("dag-state-{dag_id}.json"));
                            let context_file =
                                ergatai_dir.join(format!("dag-context-{dag_id}.json"));
                            if state_file.exists() {
                                if let Err(e) = tokio::fs::remove_file(&state_file).await {
                                    tracing::warn!(dag_id = %dag_id, ?state_file, "Failed to remove stale DAG state file: {}", e);
                                }
                            }
                            if context_file.exists() {
                                if let Err(e) = tokio::fs::remove_file(&context_file).await {
                                    tracing::warn!(dag_id = %dag_id, ?context_file, "Failed to remove stale DAG context file: {}", e);
                                }
                            }
                            continue;
                        }

                        match scheduler.submit_graph().await {
                            Ok(submitted) => {
                                tracing::info!(
                                    dag_id = %dag_id,
                                    resubmitted = submitted.len(),
                                    ?status_counts,
                                    "✅ DAG recovery complete"
                                );
                                set_dag_scheduler(scheduler);
                            }
                            Err(e) => {
                                tracing::error!(dag_id = %dag_id, "Failed to resubmit: {}", e);
                            }
                        }
                    }
                }
                Ok(_) => tracing::debug!("No DAG state found on disk (fresh start)"),
                Err(e) => tracing::debug!("No DAG state found on disk: {}", e),
            }
        }
        Err(e) => {
            tracing::error!("❌ Failed to initialize NATS: {}", e);
            return Err(anyhow::anyhow!("NATS initialization failed: {}", e));
        }
    };

// Build application router
    let state = app_state_with_token(args.api_token.clone()).clone();

    // API routes
    let api_app = build_rest_app(state);

    // Static files at root, separate from API.
    // Cache-Control: no-cache forces the browser to revalidate with the server on each
    // request (ETag/Last-Modified → 304 Not Modified when unchanged). This prevents stale
    // files from being served indefinitely without needing manual ?v=N cache-busting.
    let static_router = Router::new()
        .fallback_service(ServeDir::new("web").append_index_html_on_directories(true))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        ));

    let app = api_app
        .merge(static_router)
        .nest_service("/mcp/agent-1", mcp_service_1)
        .nest_service("/mcp/agent-2", mcp_service_2)
        .nest_service("/mcp/agent-3", mcp_service_3)
        .nest_service("/mcp", mcp_service_default);

    let addr: SocketAddr = format!("{}:{}", args.host, args.port)
        .parse()
        .map_err(|e| anyhow::anyhow!("invalid --host '{}': {}", args.host, e))?;

    tracing::info!("API server listening on {}", addr);
    let app_with_connect_info = app.into_make_service_with_connect_info::<SocketAddr>();

    if let (Some(cert_path), Some(key_path)) = (&args.tls_cert, &args.tls_key) {
        tracing::info!("Starting HTTPS server on {}", addr);
        let tls_config = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert_path, key_path)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to load TLS certificate: {}", e))?;
        axum_server::bind_rustls(addr, tls_config)
            .serve(app_with_connect_info)
            .await?;
    } else {
        tracing::info!("Starting HTTP server on {}", addr);
        let listener = tokio::net::TcpListener::bind(addr).await?;
        axum::serve(listener, app_with_connect_info).await?;
    }

    mcp_cancellation_token.cancel();
    Ok(())
}
