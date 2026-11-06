//! Generic job queue worker
//!
//! Processes persisted jobs from `job_queue` in the background.
//! Jobs are executed in batches to avoid long-lived DB locks.

use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

const POLL_INTERVAL_SECS: u64 = 2;
const MAX_RETRIES: i64 = 5;

pub fn spawn_worker(cancellation_token: CancellationToken) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        info!("Job queue worker started");

        // Recover any jobs stuck in 'processing' state from a previous crash
        match tokio::task::spawn_blocking(|| {
            crate::user_data_db::chats::reset_stale_processing_jobs()
        })
        .await
        {
            Ok(Ok(count)) if count > 0 => {
                info!(count, "Reset stale processing jobs back to pending");
            }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => warn!(error = %e, "Failed to reset stale processing jobs"),
            Err(e) => warn!(error = %e, "Reset task panicked"),
        }

        loop {
            tokio::select! {
                _ = cancellation_token.cancelled() => {
                    info!("Job queue worker shutting down");
                    break;
                }
                _ = tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)) => {}
            }

            let jobs =
                match tokio::task::spawn_blocking(|| crate::user_data_db::chats::dequeue_jobs(10))
                    .await
                {
                    Ok(Ok(jobs)) => jobs,
                    Ok(Err(e)) => {
                        warn!(error = %e, "Failed to dequeue jobs");
                        continue;
                    }
                    Err(e) => {
                        warn!(error = %e, "Dequeue task panicked");
                        continue;
                    }
                };

            if jobs.is_empty() {
                continue;
            }

            for job in jobs {
                let result = process_job(&job).await;
                match result {
                    Ok(()) => {
                        let job_id = job.id;
                        let res = tokio::task::spawn_blocking(move || {
                            crate::user_data_db::chats::mark_job_done(job_id)
                        })
                        .await;
                        match res {
                            Ok(Ok(())) => {}
                            Ok(Err(e)) => {
                                warn!(error = %e, job_id = job.id, "Failed to mark job done")
                            }
                            Err(e) => {
                                warn!(error = %e, job_id = job.id, "Join error marking job done")
                            }
                        }
                    }
                    Err(e) => {
                        warn!(error = %e, job_id = job.id, action = %job.action, "Job failed");
                        let job_id = job.id;
                        let _ = tokio::task::spawn_blocking(move || {
                            crate::user_data_db::chats::mark_job_failed(job_id, MAX_RETRIES)
                        })
                        .await;
                    }
                }
            }
        }
    })
}

async fn process_job(job: &crate::user_data_db::chats::Job) -> anyhow::Result<()> {
    match job.job_type.as_str() {
        "deletion" => process_deletion_job(job).await,
        "persistence" => process_persistence_job(job).await,
        other => {
            // Unknown job types are logged and treated as no-ops for now.
            tracing::warn!(
                job_type = other,
                job_id = job.id,
                "Unknown job type; marking done"
            );
            Ok(())
        }
    }
}

async fn process_persistence_job(job: &crate::user_data_db::chats::Job) -> anyhow::Result<()> {
    match job.action.as_str() {
        "create_agent_session_conversation" => {
            #[derive(serde::Deserialize)]
            struct Payload {
                chat_id: i64,
                acp_session_id: String,
                title: Option<String>,
            }

            let payload: Payload = serde_json::from_str(job.payload.as_deref().unwrap_or("{}"))?;
            let chat_id = ergatai_error::ChatId::new(payload.chat_id);

            tokio::task::spawn_blocking(move || {
                crate::user_data_db::conversations::create_for_agent_session(
                    chat_id,
                    &payload.acp_session_id,
                    payload.title,
                )
            })
            .await
            .map_err(|e| anyhow::anyhow!("join error: {}", e))??;

            Ok(())
        }
        "import_agent_session_history" => {
            #[derive(serde::Deserialize)]
            struct Payload {
                chat_id: i64,
                acp_session_id: String,
                title: Option<String>,
                conversation_id: Option<i64>,
                capture_limit: Option<usize>,
                persist_limit: Option<usize>,
            }

            let payload: Payload = serde_json::from_str(job.payload.as_deref().unwrap_or("{}"))?;
            let chat_id = ergatai_error::ChatId::new(payload.chat_id);
            let capture_limit = payload.capture_limit.unwrap_or(50).min(50);
            let persist_limit = payload.persist_limit.unwrap_or(20).min(20);
            let agent_id = job.entity_id.clone();
            let acp_session_id = payload.acp_session_id.clone();

            // Ensure conversation exists.
            let conversation_id = if let Some(id) = payload.conversation_id {
                ergatai_error::ConversationId::new(id)
            } else {
                let title = payload.title.clone();
                let acp = acp_session_id.clone();
                tokio::task::spawn_blocking(move || {
                    crate::user_data_db::conversations::create_for_agent_session(
                        chat_id, &acp, title,
                    )
                })
                .await
                .map_err(|e| anyhow::anyhow!("join error: {}", e))??
            };

            // Idempotency: skip if messages already imported.
            let conv_id_for_check = conversation_id;
            let has_messages = tokio::task::spawn_blocking(move || {
                crate::user_data_db::messages::list(conv_id_for_check)
                    .map(|m| !m.is_empty())
                    .unwrap_or(false)
            })
            .await
            .unwrap_or(false);
            if has_messages {
                return Ok(());
            }

            // Capture history from agent.
            let captured = crate::services::agent_service::resume_session_capture(
                &agent_id,
                &payload.acp_session_id,
                capture_limit,
            )
            .await?;

            if captured.is_empty() {
                return Ok(());
            }

            // Map captured updates to messages.
            let captured_len = captured.len();
            // Persist only the most recent `persist_limit` messages.
            let start = captured_len.saturating_sub(persist_limit);
            let mut messages = Vec::new();
            for update in captured.into_iter().skip(start).take(persist_limit) {
                let session_update = update
                    .get("sessionUpdate")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let role = match session_update {
                    "user_message_chunk" => "user",
                    _ => "assistant",
                };
                let parts = update.clone();
                let metadata = serde_json::json!({});
                messages.push((role.to_string(), parts, metadata));
            }

            let imported = messages.len() as i64;
            let has_more = captured_len >= persist_limit;

            // Persist.
            let conv_id = conversation_id;
            tokio::task::spawn_blocking(move || {
                crate::user_data_db::messages::append_batch(conv_id, messages)
            })
            .await
            .map_err(|e| anyhow::anyhow!("join error: {}", e))??;

            // Update import state.
            let conv_id2 = conversation_id;
            tokio::task::spawn_blocking(move || {
                crate::user_data_db::agent_sessions::update_import_state(
                    conv_id2.as_i64(),
                    imported,
                    None,
                    has_more,
                    captured_len as i64,
                )
            })
            .await
            .map_err(|e| anyhow::anyhow!("join error: {}", e))??;

            Ok(())
        }
        other => {
            tracing::warn!(
                action = other,
                job_id = job.id,
                "Unknown persistence action"
            );
            Ok(())
        }
    }
}

async fn process_deletion_job(job: &crate::user_data_db::chats::Job) -> anyhow::Result<()> {
    match job.action.as_str() {
        "cleanup_workspace" | "cleanup_chat" | "cleanup_agent" => {
            let ids: Vec<String> = job
                .payload
                .as_deref()
                .and_then(|p| serde_json::from_str(p).ok())
                .unwrap_or_default();

            const BATCH_SIZE: usize = 50;
            let mut decoded_ids = Vec::new();
            for id_str in ids {
                if let Ok(conv_id) = ergatai_error::ConversationId::decode(&id_str) {
                    decoded_ids.push(conv_id);
                }
            }

            for chunk in decoded_ids.chunks(BATCH_SIZE) {
                let tasks: Vec<_> = chunk
                    .iter()
                    .map(|&conv_id| {
                        tokio::task::spawn_blocking(move || {
                            crate::user_data_db::drop_message_table(conv_id)
                        })
                    })
                    .collect();

                for task in tasks {
                    if let Err(e) = task.await {
                        tracing::warn!(error = %e, "Failed to drop message table");
                    }
                }
            }
            Ok(())
        }
        other => {
            tracing::warn!(action = other, job_id = job.id, "Unknown deletion action");
            Ok(())
        }
    }
}
