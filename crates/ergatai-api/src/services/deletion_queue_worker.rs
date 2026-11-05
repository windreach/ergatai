//! Deletion / archive queue worker
//!
//! Processes persisted jobs from `deletion_queue` in the background.
//! Jobs are executed in batches to avoid long-lived DB locks.

use ergatai_error::ConversationId;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

const POLL_INTERVAL_SECS: u64 = 2;
const MAX_RETRIES: i64 = 5;

pub fn spawn_worker(cancellation_token: CancellationToken) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        info!("Deletion queue worker started");

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
                    info!("Deletion queue worker shutting down");
                    break;
                }
                _ = tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)) => {}
            }

            let jobs = match tokio::task::spawn_blocking(|| {
                crate::user_data_db::chats::dequeue_deletions(10)
            })
            .await
            {
                Ok(Ok(jobs)) => jobs,
                Ok(Err(e)) => {
                    warn!(error = %e, "Failed to dequeue deletion jobs");
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
                            crate::user_data_db::chats::mark_deletion_done(job_id)
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
                            crate::user_data_db::chats::mark_deletion_failed(job_id, MAX_RETRIES)
                        })
                        .await;
                    }
                }
            }
        }
    })
}

async fn process_job(job: &crate::user_data_db::chats::DeletionJob) -> anyhow::Result<()> {
    match job.action.as_str() {
        "cleanup_workspace" | "cleanup_chat" | "cleanup_agent" => {
            let ids: Vec<String> = job
                .payload
                .as_deref()
                .and_then(|p| serde_json::from_str(p).ok())
                .unwrap_or_default();

            // Process message table drops in batches to avoid unbounded concurrency.
            // Large workspaces may have thousands of conversations; spawning all at once
            // would create thousands of blocking threads.
            const BATCH_SIZE: usize = 50;
            let decoded_ids: Vec<_> = ids
                .into_iter()
                .filter_map(|id_str| ConversationId::decode(&id_str).ok())
                .collect();

            for chunk in decoded_ids.chunks(BATCH_SIZE) {
                let tasks: Vec<_> = chunk
                    .iter()
                    .map(|&conv_id| {
                        tokio::task::spawn_blocking(move || {
                            crate::user_data_db::drop_message_table(conv_id)
                        })
                    })
                    .collect();

                // Await all tasks in this batch before starting the next
                for task in tasks {
                    // Log errors but continue processing other tables
                    if let Err(e) = task.await {
                        warn!(error = %e, "Failed to drop message table for conversation");
                    }
                }
            }
            Ok(())
        }
        _ => Err(anyhow::anyhow!(
            "unknown action '{}' for {} entity {} (job_id: {})",
            job.action,
            job.entity_type,
            job.entity_id,
            job.id
        )),
    }
}
