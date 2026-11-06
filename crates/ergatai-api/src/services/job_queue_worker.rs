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
                        let error_msg = e.to_string();
                        warn!(error = %error_msg, job_id = job.id, action = %job.action, "Job failed");
                        let job_id = job.id;
                        let _ = tokio::task::spawn_blocking(move || {
                            crate::user_data_db::chats::mark_job_failed(
                                job_id,
                                MAX_RETRIES,
                                Some(&error_msg),
                            )
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
            #[derive(serde::Deserialize, Default)]
            struct Payload {
                #[serde(default)]
                chat_id: Option<i64>,
                acp_session_id: String,
                #[serde(default)]
                title: Option<String>,
                #[serde(default)]
                conversation_id: Option<i64>,
                #[serde(default)]
                capture_limit: Option<usize>,
                #[serde(default)]
                persist_limit: Option<usize>,
                #[serde(default)]
                limit: Option<usize>,
                #[serde(default)]
                cursor: Option<String>,
            }

            let payload: Payload = serde_json::from_str(job.payload.as_deref().unwrap_or("{}"))?;
            let agent_id = job.entity_id.clone();
            let input = crate::services::agent_history_import::ImportAgentSessionHistoryInput {
                chat_id: payload.chat_id,
                acp_session_id: payload.acp_session_id,
                title: payload.title,
                conversation_id: payload.conversation_id,
                capture_limit: payload.capture_limit,
                persist_limit: payload.persist_limit,
                limit: payload.limit,
                cursor: payload.cursor,
            };
            crate::services::agent_history_import::import_agent_session_history(&agent_id, input).await?;
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
