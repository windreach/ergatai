//! ACP Agent 启动阶段抽象与重试机制
//!
//! 将 agent 启动过程分解为三个独立阶段，每个阶段实现统一的 trait，
//! 支持可配置的重试策略和超时控制。

use ergatai_error::{ErgataiError, ErgataiResult};
use std::time::Duration;
use tracing::{debug, error, info, warn};

/// 启动阶段标识
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupPhase {
    /// 阶段 1: 进程生成
    ProcessSpawn,
    /// 阶段 2: ACP 协议初始化
    AcpInitialize,
    /// 阶段 3: Session 创建/加载
    SessionCreate,
}

impl std::fmt::Display for StartupPhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartupPhase::ProcessSpawn => write!(f, "ProcessSpawn"),
            StartupPhase::AcpInitialize => write!(f, "AcpInitialize"),
            StartupPhase::SessionCreate => write!(f, "SessionCreate"),
        }
    }
}

/// 重试策略配置
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    /// 最大重试次数（0 = 不重试）
    pub max_attempts: u32,
    /// 初始延迟
    pub initial_delay: Duration,
    /// 延迟倍数（指数退避）
    pub backoff_multiplier: f64,
    /// 最大延迟上限
    pub max_delay: Duration,
    /// 是否添加随机抖动
    pub jitter: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            initial_delay: Duration::from_millis(100),
            backoff_multiplier: 2.0,
            max_delay: Duration::from_secs(5),
            jitter: true,
        }
    }
}

impl RetryPolicy {
    /// 为特定阶段创建默认策略
    pub fn for_phase(phase: StartupPhase) -> Self {
        match phase {
            StartupPhase::ProcessSpawn => Self {
                max_attempts: 2, // 进程生成失败通常是永久性的
                initial_delay: Duration::from_millis(200),
                ..Default::default()
            },
            StartupPhase::AcpInitialize => Self {
                max_attempts: 3, // 初始化可能因为 agent 启动慢而超时
                initial_delay: Duration::from_millis(500),
                max_delay: Duration::from_secs(10),
                ..Default::default()
            },
            StartupPhase::SessionCreate => Self {
                max_attempts: 3, // Session 创建可能有临时冲突
                initial_delay: Duration::from_millis(300),
                ..Default::default()
            },
        }
    }

    /// 计算第 n 次重试的延迟
    pub fn delay_for_attempt(&self, attempt: u32) -> Duration {
        let base_delay =
            self.initial_delay.as_millis() as f64 * self.backoff_multiplier.powi(attempt as i32);
        let delay_ms = base_delay.min(self.max_delay.as_millis() as f64);

        if self.jitter {
            // 使用基于时间的简单抖动（避免依赖 rand crate）
            // 使用纳秒级时间戳的多个位作为伪随机源，提供更好的熵
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos();
            let jitter_range = delay_ms * 0.25;
            // 使用纳秒的多个位（位 0-11，提供 0-4095 范围）以获得更好的分布
            let normalized = ((nanos & 0xFFF) as f64) / 4096.0; // 0.0 to 1.0
            let jitter = (normalized - 0.5) * 2.0 * jitter_range;
            Duration::from_millis((delay_ms + jitter).max(0.0) as u64)
        } else {
            Duration::from_millis(delay_ms as u64)
        }
    }
}

/// 启动阶段 trait
///
/// 每个启动阶段实现此 trait，提供统一的执行接口
#[async_trait::async_trait]
pub trait StartupPhaseExecutor: Send + Sync {
    /// 阶段标识
    fn phase(&self) -> StartupPhase;

    /// 执行阶段操作
    ///
    /// 返回 Ok(()) 表示成功，Err(ErgataiError) 表示失败
    async fn execute(&self) -> ErgataiResult<()>;

    /// 判断错误是否可重试
    ///
    /// 默认实现：所有错误都可重试。子类可以覆盖此方法以实现更精细的控制。
    fn is_retryable(&self, _error: &ErgataiError) -> bool {
        true
    }

    /// 阶段超时时间
    ///
    /// 默认值根据阶段不同而不同
    fn timeout(&self) -> Duration {
        match self.phase() {
            StartupPhase::ProcessSpawn => Duration::from_secs(10),
            StartupPhase::AcpInitialize => Duration::from_secs(30),
            StartupPhase::SessionCreate => Duration::from_secs(20),
        }
    }

    /// 重试策略
    fn retry_policy(&self) -> RetryPolicy {
        RetryPolicy::for_phase(self.phase())
    }

    /// 清理失败状态（在重试前调用）
    ///
    /// 默认实现为空。用于清理部分成功状态（如已生成的进程）。
    async fn cleanup_on_failure(&self) -> ErgataiResult<()> {
        Ok(())
    }
}

/// 带重试的执行器
pub struct RetryExecutor;

impl RetryExecutor {
    /// 执行带重试的阶段操作
    pub async fn execute_with_retry<E: StartupPhaseExecutor>(
        executor: &E,
        agent_id: &str,
    ) -> ErgataiResult<()> {
        let phase = executor.phase();
        let policy = executor.retry_policy();
        let timeout = executor.timeout();

        let mut last_error = None;

        for attempt in 0..=policy.max_attempts {
            if attempt > 0 {
                let delay = policy.delay_for_attempt(attempt - 1);
                info!(
                    agent_id = %agent_id,
                    phase = %phase,
                    attempt = attempt,
                    max_attempts = policy.max_attempts,
                    delay_ms = delay.as_millis(),
                    "Retrying startup phase"
                );
                tokio::time::sleep(delay).await;

                // 清理上一次失败的状态
                if let Err(e) = executor.cleanup_on_failure().await {
                    warn!(
                        agent_id = %agent_id,
                        phase = %phase,
                        error = %e,
                        "Cleanup before retry failed"
                    );
                }
            }

            debug!(
                agent_id = %agent_id,
                phase = %phase,
                attempt = attempt + 1,
                timeout_secs = timeout.as_secs(),
                "Executing startup phase"
            );

            // 带超时的执行
            let result = tokio::time::timeout(timeout, executor.execute()).await;

            match result {
                Ok(Ok(())) => {
                    info!(
                        agent_id = %agent_id,
                        phase = %phase,
                        attempt = attempt + 1,
                        "Startup phase completed successfully"
                    );
                    return Ok(());
                }
                Ok(Err(e)) => {
                    // 检查是否可重试
                    if !executor.is_retryable(&e) {
                        error!(
                            agent_id = %agent_id,
                            phase = %phase,
                            error = %e,
                            "Non-retryable error in startup phase"
                        );
                        return Err(e);
                    }

                    warn!(
                        agent_id = %agent_id,
                        phase = %phase,
                        attempt = attempt + 1,
                        error = %e,
                        "Startup phase failed (retryable)"
                    );
                    last_error = Some(e);
                }
                Err(_) => {
                    // 超时
                    let timeout_error = ErgataiError::AgentTimeout {
                        message: format!("{} timeout after {}s", phase, timeout.as_secs()),
                        source: None,
                    };

                    if !executor.is_retryable(&timeout_error) {
                        error!(
                            agent_id = %agent_id,
                            phase = %phase,
                            timeout_secs = timeout.as_secs(),
                            "Non-retryable timeout in startup phase"
                        );
                        return Err(timeout_error);
                    }

                    warn!(
                        agent_id = %agent_id,
                        phase = %phase,
                        attempt = attempt + 1,
                        timeout_secs = timeout.as_secs(),
                        "Startup phase timed out (retryable)"
                    );
                    last_error = Some(timeout_error);
                }
            }
        }

        // 所有重试用尽
        let final_error = last_error.unwrap_or_else(|| {
            ErgataiError::internal(format!(
                "{} failed after {} attempts",
                phase,
                policy.max_attempts + 1
            ))
        });

        error!(
            agent_id = %agent_id,
            phase = %phase,
            attempts = policy.max_attempts + 1,
            error = %final_error,
            "Startup phase failed after all retries"
        );

        Err(final_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_retry_policy_delay_calculation() {
        let policy = RetryPolicy {
            max_attempts: 3,
            initial_delay: Duration::from_millis(100),
            backoff_multiplier: 2.0,
            max_delay: Duration::from_secs(5),
            jitter: false,
        };

        assert_eq!(policy.delay_for_attempt(0), Duration::from_millis(100));
        assert_eq!(policy.delay_for_attempt(1), Duration::from_millis(200));
        assert_eq!(policy.delay_for_attempt(2), Duration::from_millis(400));
    }

    #[test]
    fn test_phase_specific_policies() {
        let spawn_policy = RetryPolicy::for_phase(StartupPhase::ProcessSpawn);
        assert_eq!(spawn_policy.max_attempts, 2);

        let init_policy = RetryPolicy::for_phase(StartupPhase::AcpInitialize);
        assert_eq!(init_policy.max_attempts, 3);
    }
}
