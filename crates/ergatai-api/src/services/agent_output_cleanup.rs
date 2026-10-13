//! Agent Output TTL Cleanup Service
//!
//! 定期清理超过保留期限的 `agent_outputs` 记录，防止存储无限增长。
//!
//! # 行为
//!
//! * 启动时记录 TTL 配置。
//! * 每隔 [`CLEANUP_INTERVAL_SECS`] 秒执行一次清理。
//! * 清理失败只记录警告，不会让主服务崩溃。
//! * 没有删除任何记录时不输出 info 日志（避免噪音）。

use tracing::{info, warn};

/// 默认保留天数
const DEFAULT_TTL_DAYS: u64 = 30;

/// 清理间隔（秒）：每天一次
const CLEANUP_INTERVAL_SECS: u64 = 86_400;

/// 启动后台清理任务。
///
/// 返回的 `JoinHandle` 可以用于 graceful shutdown（当前实现中不持有，
/// 因为清理任务是长驻且可丢弃的）。
pub fn spawn_cleanup_task() -> tokio::task::JoinHandle<()> {
    tokio::spawn(async {
        let ttl_days = get_ttl_days();
        info!(
            ttl_days,
            interval_secs = CLEANUP_INTERVAL_SECS,
            "Agent output cleanup task started"
        );

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(CLEANUP_INTERVAL_SECS)).await;

            match run_cleanup(ttl_days).await {
                Ok(deleted) => {
                    if deleted > 0 {
                        info!(deleted, ttl_days, "Agent output cleanup completed");
                    }
                }
                Err(e) => {
                    warn!(error = %e, "Agent output cleanup failed");
                }
            }
        }
    })
}

/// 执行一次清理，返回删除的记录数。
async fn run_cleanup(ttl_days: u64) -> anyhow::Result<usize> {
    // Guard against clock skew: if system time is before UNIX_EPOCH, use 0 rather than panicking.
    // This matches the behavior in output_accumulator.rs for consistency.
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or(std::time::Duration::from_secs(0))
        .as_secs();
    // Guard against overflow: use saturating arithmetic to prevent incorrect cutoff calculation
    // when ttl_days is very large. The multiplication can overflow i64::MAX / 86_400 ≈ 106751 days.
    let ttl_seconds = (ttl_days as i64).saturating_mul(86_400);
    let cutoff = (now_secs as i64).saturating_sub(ttl_seconds);

    let deleted = tokio::task::spawn_blocking(move || {
        crate::user_data_db::agent_outputs::delete_older_than(cutoff)
    })
    .await??;

    Ok(deleted)
}

/// 从环境变量读取 TTL 天数。
///
/// 读取 `ERGATAI_AGENT_OUTPUT_TTL_DAYS`，非法值回退到 [`DEFAULT_TTL_DAYS`]。
fn get_ttl_days() -> u64 {
    std::env::var("ERGATAI_AGENT_OUTPUT_TTL_DAYS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(DEFAULT_TTL_DAYS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_ttl_days_default() {
        // Remove the env var to exercise default path.
        std::env::remove_var("ERGATAI_AGENT_OUTPUT_TTL_DAYS");
        assert_eq!(get_ttl_days(), DEFAULT_TTL_DAYS);
    }

    #[test]
    fn get_ttl_days_invalid_falls_back() {
        std::env::set_var("ERGATAI_AGENT_OUTPUT_TTL_DAYS", "not-a-number");
        assert_eq!(get_ttl_days(), DEFAULT_TTL_DAYS);
        std::env::remove_var("ERGATAI_AGENT_OUTPUT_TTL_DAYS");
    }

    #[test]
    fn get_ttl_days_zero_falls_back() {
        std::env::set_var("ERGATAI_AGENT_OUTPUT_TTL_DAYS", "0");
        assert_eq!(get_ttl_days(), DEFAULT_TTL_DAYS);
        std::env::remove_var("ERGATAI_AGENT_OUTPUT_TTL_DAYS");
    }

    #[test]
    fn get_ttl_days_valid() {
        std::env::set_var("ERGATAI_AGENT_OUTPUT_TTL_DAYS", "7");
        assert_eq!(get_ttl_days(), 7);
        std::env::remove_var("ERGATAI_AGENT_OUTPUT_TTL_DAYS");
    }
}
