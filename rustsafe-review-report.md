# RustSafe 审查报告

## 概要
- **审查目标**: Git commit `095a1e7 feat: implement hcom-inspired message observability`
- **变更范围**: 25 个文件，+1744/-211 行
- **主要新增功能**:
  - Read receipts (ReadReceiptPayload) 用于追踪消息投递
  - Request monitoring (RequestMonitor) 用于请求/响应关联和超时检测
  - Auto-subscription presets 用于 agent 生命周期和回执事件
  - AgentMessagePayload 扩展字段: message_id, correlation_id, requires_receipt, timeout_ms

## 编译基线

### cargo check
- **状态**: ✅ 通过
- **错误数量**: 0 个
- **警告数量**: 7 个

### cargo test --no-run
- **状态**: ✅ 通过
- **编译失败的测试文件**: 无

### cargo clippy
- **状态**: ✅ 通过
- **警告数量**: 8 个
- **严重警告（deny 级别）**: 0 个

---

## 🔴 高危问题

### 问题 1: 算术溢出可能导致 panic
- **位置**: `crates/ergatai-api/src/mcp/request_monitor.rs:209`
- **类别**: 正确性 / 数值安全
- **来源**: 本次发现
- **描述**:
  ```rust
  let elapsed_ms = (now - request.sent_at) * 1000;
  ```
  如果系统时钟回拨（NTP 同步、手动调整），`now < request.sent_at`，减法会在 debug 模式下 panic，在 release 模式下 wrap around。即使 `now >= request.sent_at`，乘以 1000 也可能溢出（虽然需要 5.8 亿年的秒数才会溢出，但减法本身是风险点）。

- **影响**: 生产环境 panic 导致 request monitor 任务崩溃，所有超时检测失效
- **修复建议**:
  ```rust
  let elapsed_ms = now
      .checked_sub(request.sent_at)
      .and_then(|secs| secs.checked_mul(1000))
      .unwrap_or(u64::MAX); // 或 saturating_sub + saturating_mul
  ```

### 问题 2: 并发请求的 correlation_id 覆盖
- **位置**: `crates/ergatai-api/src/messaging/mod.rs:432`
- **类别**: 正确性 / 并发逻辑
- **来源**: 本次发现
- **描述**:
  ```rust
  pub fn record_pending_response(to_agent: &str, correlation_id: &str) {
      if let Some(sender) = get_message_sender() {
          if let Ok(mut pending) = sender.pending_responses.lock() {
              pending.insert(to_agent.to_string(), correlation_id.to_string());
          }
      }
  }
  ```
  `pending_responses` 是 `HashMap<String, String>`，key 是 agent_id，value 是单个 correlation_id。如果 agent B 同时收到来自 agent A 和 agent C 的请求，只有最后一个请求的 correlation_id 被记录。当 B 发送响应时，系统会自动填充错误的 correlation_id。

- **影响**: 多并发请求场景下，RequestMonitor 无法正确匹配请求和响应，导致虚假超时通知
- **修复建议**:
  改为 `HashMap<String, Vec<String>>` 或 `HashMap<String, HashSet<String>>`，支持一个 agent 对应多个 pending correlation_id：
  ```rust
  pub fn record_pending_response(to_agent: &str, correlation_id: &str) {
      if let Some(sender) = get_message_sender() {
          if let Ok(mut pending) = sender.pending_responses.lock() {
              pending
                  .entry(to_agent.to_string())
                  .or_insert_with(Vec::new)
                  .push(correlation_id.to_string());
          }
      }
  }
  ```

### 问题 3: 锁获取顺序不一致的潜在死锁风险
- **位置**: `crates/ergatai-api/src/mcp/request_monitor.rs:230`
- **类别**: 并发安全 / 死锁
- **来源**: 本次发现
- **描述**:
  ```rust
  pub fn remove_timeouts(&self, correlation_ids: &[String]) {
      match (self.pending.write(), self.retry_counts.write()) {
          // ...
      }
  }
  ```
  `remove_timeouts` 同时获取 `pending` 和 `retry_counts` 两个写锁。虽然当前代码中 `mark_responded` 也按相同顺序获取（pending → retry_counts），但这种模式很脆弱。如果未来有人添加一个方法以相反顺序获取（retry_counts → pending），就会死锁。

- **影响**: 当前无 bug，但维护风险高
- **修复建议**:
  使用 `parking_lot::RwLock` 或明确文档化锁获取顺序：
  ```rust
  /// Lock ordering: always acquire `pending` before `retry_counts` to prevent deadlock.
  pub struct RequestMonitor {
      pending: Arc<RwLock<HashMap<String, PendingRequest>>>,
      retry_counts: Arc<RwLock<HashMap<String, u32>>>,
  }
  ```
  或重构为单个锁保护两个 map：
  ```rust
  pub struct RequestMonitor {
      state: Arc<RwLock<MonitorState>>,
  }

  struct MonitorState {
      pending: HashMap<String, PendingRequest>,
      retry_counts: HashMap<String, u32>,
  }
  ```

---

## 🟡 中等问题

### 问题 4: 异步上下文中使用同步锁
- **位置**:
  - `crates/ergatai-api/src/mcp/request_monitor.rs:40,42` (`std::sync::RwLock`)
  - `crates/ergatai-api/src/messaging/mod.rs:82` (`std::sync::Mutex`)
- **类别**: 性能 / 异步最佳实践
- **来源**: 本次发现
- **描述**: 在 tokio 异步上下文中使用 `std::sync::RwLock` 和 `std::sync::Mutex` 会在锁竞争时阻塞 tokio worker 线程，影响其他异步任务的调度。

- **影响**: 高并发场景下性能下降，但当前负载可能不明显
- **修复建议**:
  替换为 `tokio::sync::RwLock` 和 `tokio::sync::Mutex`：
  ```rust
  use tokio::sync::{RwLock, Mutex};

  pub struct RequestMonitor {
      pending: Arc<RwLock<HashMap<String, PendingRequest>>>,
      retry_counts: Arc<RwLock<HashMap<String, u32>>>,
  }
  ```
  注意：需要将所有 `.write()` / `.read()` 调用改为 `.await`。

### 问题 5: pending map 无界增长风险
- **位置**: `crates/ergatai-api/src/mcp/request_monitor.rs`
- **类别**: 资源管理 / 内存泄漏
- **来源**: 本次发现
- **描述**: `pending` map 没有大小限制。如果请求被追踪但从未收到响应，且超时监控任务因 NATS 连接失败而无法发布超时事件，这些条目会永久留在 map 中。虽然 `spawn_request_monitor_with_cancel` 有重试逻辑（最多 3 次），但如果监控任务本身崩溃或 NATS 长期不可用，map 会无限增长。

- **影响**: 长期运行的服务可能出现内存泄漏
- **修复建议**:
  1. 添加 map 大小限制：
     ```rust
     const MAX_PENDING_REQUESTS: usize = 10_000;

     pub fn track_request(...) {
         let mut pending = self.pending.write().unwrap();
         if pending.len() >= MAX_PENDING_REQUESTS {
             warn!("pending map at capacity, rejecting new request tracking");
             return;
         }
         pending.insert(correlation_id.clone(), request);
     }
     ```
  2. 添加 TTL 清理（即使超时未发布，也在一定时间后移除）：
     ```rust
     const MAX_PENDING_AGE_SECS: u64 = 3600; // 1 hour

     fn cleanup_stale_entries(&self) {
         let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
         let mut pending = self.pending.write().unwrap();
         pending.retain(|_, req| {
             now.saturating_sub(req.sent_at) < MAX_PENDING_AGE_SECS
         });
     }
     ```

### 问题 6: ReadReceiptPayload 字段命名混淆
- **位置**: `crates/ergatai-nats/src/events.rs:162-171` 和 `crates/ergatai-api/src/mcp/message_delivery.rs:331-338`
- **类别**: 可维护性 / 命名
- **来源**: 本次发现
- **描述**:
  ```rust
  pub struct ReadReceiptPayload {
      pub message_id: String,
      pub from_agent: String,  // 实际含义：读取消息的 agent（接收方）
      pub to_agent: String,    // 实际含义：原始发送方（接收回执）
      pub read_at: u64,
  }
  ```
  字段名 `from_agent` / `to_agent` 与实际含义不一致。注释解释了（"from_agent is the READER"），但命名本身具有误导性。

- **影响**: 代码可读性差，容易导致误解和错误使用
- **修复建议**:
  重命名为更明确的字段名：
  ```rust
  pub struct ReadReceiptPayload {
      pub message_id: String,
      pub reader_agent: String,      // who read the message (recipient)
      pub original_sender: String,   // who sent the original message (receives receipt)
      pub read_at: u64,
  }
  ```
  或保持现有字段名但添加更强的文档：
  ```rust
  /// Read receipt: confirmation that a message was delivered and read
  ///
  /// **Field semantics**:
  /// - `from_agent`: The agent WHO READ the message (recipient of original message)
  /// - `to_agent`: The agent WHO SENT the original message (receives this receipt)
  ///
  /// This is intentionally "backwards" from the original message flow:
  /// Original: A → B  |  Receipt: B → A
  #[derive(Debug, Clone, Serialize, Deserialize)]
  pub struct ReadReceiptPayload {
      pub message_id: String,
      pub from_agent: String,
      pub to_agent: String,
      pub read_at: u64,
  }
  ```

---

## 🟢 低危问题

### 问题 7: 系统时钟回拨处理不一致
- **位置**: `crates/ergatai-api/src/mcp/request_monitor.rs:66-75, 185-194`
- **类别**: 错误处理 / 边界情况
- **来源**: 本次发现
- **描述**:
  ```rust
  let now = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap_or_else(|e| {
          warn!(error = %e, "System time before UNIX epoch...");
          Duration::from_secs(0)
      })
      .as_secs();
  ```
  如果系统时钟在 UNIX epoch 之前（极端情况），`now` 变为 0，导致所有请求看起来都已超时（`elapsed_ms = (0 - sent_at) * 1000` 会下溢）。虽然这种情况极其罕见，但处理方式不一致。

- **修复建议**:
  使用 `saturating_sub` 或返回错误：
  ```rust
  let now = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|d| d.as_secs())
      .unwrap_or(0);
  // 后续使用 now.saturating_sub(request.sent_at)
  ```

### 问题 8: Clippy 警告（预先存在）
- **位置**:
  - `crates/ergatai-api/tests/admission_gate_integration_tests.rs:3,6,10,11,58,80`
  - `crates/ergatai-collab/src/dag_scheduler/terminal.rs:663`
- **类别**: 代码质量
- **来源**: 预先存在
- **描述**: 未使用的导入和变量：
  - `std::sync::Arc` (unused)
  - `AgentHealthGate`, `ConversationLoopGate`, `MeshPolicyGate` (unused)
  - `AgentRegistry`, `AgentRuntime` (unused)
  - `runtime` (unused variable, 2x)
  - `sample_graph` (dead code)

- **修复建议**:
  移除未使用的导入和变量，或在变量名前加 `_`：
  ```rust
  // 移除未使用的导入
  // use std::sync::Arc;
  // use ergatai_core::agent_registry::AgentRegistry;

  // 或使用未使用的变量
  let _runtime = get_agent_runtime();
  ```

### 问题 9: correlation_id 和 timeout_ms 参数未使用
- **位置**: `crates/ergatai-api/src/messaging/mod.rs:376-377, 387`
- **类别**: 代码质量 / API 设计
- **来源**: 本次发现
- **描述**:
  ```rust
  pub fn format_agent_message(
      sender_display: &str,
      message: &str,
      reply_target_stable_id: &str,
      message_type: &str,
      correlation_id: Option<&str>,  // 未使用
      timeout_ms: Option<u64>,        // 未使用
  ) -> String {
      // ...
      let _ = (correlation_id, timeout_ms); // 显式忽略
  }
  ```
  参数保留是为了 "API 兼容性"，但实际上这些参数从未被使用。如果未来需要注入到 PTY JSON 中，应该重新设计；如果不需要，应该移除。

- **修复建议**:
  要么移除这些参数，要么在文档中明确说明保留原因：
  ```rust
  /// Note: `correlation_id` and `timeout_ms` parameters are retained for future
  /// extensibility but currently unused. They may be injected into the PTY JSON
  /// payload in a future version if agents need to see these values.
  pub fn format_agent_message(
      sender_display: &str,
      message: &str,
      reply_target_stable_id: &str,
      message_type: &str,
      // correlation_id and timeout_ms intentionally unused - see doc comment
      _correlation_id: Option<&str>,
      _timeout_ms: Option<u64>,
  ) -> String {
      // ...
  }
  ```

---

## 问题汇总

| 级别 | 数量 | 预先存在 | 本次发现 |
|------|------|----------|----------|
| 🔴 高危 | 3 | 0 | 3 |
| 🟡 中等 | 3 | 0 | 3 |
| 🟢 低危 | 3 | 1 | 2 |
| **总计** | **9** | **1** | **8** |

---

## 修复计划

### 第一步：修复高危问题（必须立即修复）

#### 1.1 修复算术溢出 (request_monitor.rs:209)
```rust
// 修复前
let elapsed_ms = (now - request.sent_at) * 1000;

// 修复后
let elapsed_ms = now
    .checked_sub(request.sent_at)
    .and_then(|secs| secs.checked_mul(1000))
    .unwrap_or(u64::MAX);
```

#### 1.2 修复并发请求 correlation_id 覆盖 (messaging/mod.rs)
```rust
// 修复前
pending_responses: Mutex<HashMap<String, String>>,

// 修复后
pending_responses: Mutex<HashMap<String, Vec<String>>>,

// 更新 record_pending_response
pub fn record_pending_response(to_agent: &str, correlation_id: &str) {
    if let Some(sender) = get_message_sender() {
        if let Ok(mut pending) = sender.pending_responses.lock() {
            pending
                .entry(to_agent.to_string())
                .or_insert_with(Vec::new)
                .push(correlation_id.to_string());
        }
    }
}

// 更新 send() 中的 auto-fill 逻辑
"response" => {
    req.correlation_id.clone().or_else(|| {
        match self.pending_responses.lock() {
            Ok(mut pending) => {
                pending.get_mut(&req.from).and_then(|vec| {
                    if vec.is_empty() {
                        pending.remove(&req.from);
                        None
                    } else {
                        Some(vec.remove(0)) // FIFO
                    }
                })
            }
            Err(e) => {
                warn!(...);
                None
            }
        }
    })
}
```

#### 1.3 文档化锁获取顺序 (request_monitor.rs)
```rust
/// Request monitor service
///
/// **Lock ordering**: Always acquire `pending` before `retry_counts` to prevent deadlock.
/// This invariant must be maintained across all methods.
pub struct RequestMonitor {
    pending: Arc<RwLock<HashMap<String, PendingRequest>>>,
    retry_counts: Arc<RwLock<HashMap<String, u32>>>,
}
```

### 第二步：修复中等问题（建议尽快修复）

#### 2.1 替换同步锁为异步锁
```rust
// request_monitor.rs
use tokio::sync::RwLock;

pub struct RequestMonitor {
    pending: Arc<RwLock<HashMap<String, PendingRequest>>>,
    retry_counts: Arc<RwLock<HashMap<String, u32>>>,
}

// 所有 .write() / .read() 调用改为 .await
```

#### 2.2 添加 pending map 大小限制
```rust
const MAX_PENDING_REQUESTS: usize = 10_000;

pub fn track_request(...) {
    let now = ...;
    let request = PendingRequest { ... };

    match self.pending.write() {
        Ok(mut pending) => {
            if pending.len() >= MAX_PENDING_REQUESTS {
                warn!("pending map at capacity ({}), rejecting new request tracking", MAX_PENDING_REQUESTS);
                return;
            }
            pending.insert(correlation_id.clone(), request);
        }
        Err(e) => warn!(...),
    }
}
```

#### 2.3 改进 ReadReceiptPayload 文档或重命名字段
```rust
// 选项 A: 重命名字段（推荐）
pub struct ReadReceiptPayload {
    pub message_id: String,
    pub reader_agent: String,      // who read the message
    pub original_sender: String,   // who receives this receipt
    pub read_at: u64,
}

// 选项 B: 增强文档
/// **IMPORTANT**: Field names are from the receipt's perspective, not the original message.
/// - `from_agent`: Agent WHO READ the message (recipient of original)
/// - `to_agent`: Agent WHO SENT the original message (receives this receipt)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadReceiptPayload { ... }
```

### 第三步：修复低危问题（可选，代码清理）

#### 3.1 修复系统时钟回拨处理
```rust
let now = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0);

// 后续使用 saturating_sub
let elapsed_secs = now.saturating_sub(request.sent_at);
```

#### 3.2 清理 clippy 警告
移除未使用的导入和变量。

#### 3.3 文档化未使用的参数
```rust
/// Note: `correlation_id` and `timeout_ms` are retained for future extensibility
/// but currently unused. See module documentation for design rationale.
pub fn format_agent_message(
    sender_display: &str,
    message: &str,
    reply_target_stable_id: &str,
    message_type: &str,
    _correlation_id: Option<&str>,
    _timeout_ms: Option<u64>,
) -> String { ... }
```

---

## 验证清单

- [ ] 所有高危问题已修复
- [ ] 所有中等问题已修复或标记为"接受风险"
- [ ] `cargo check` 通过（0 errors）
- [ ] `cargo test` 通过（0 failures）
- [ ] `cargo clippy` 通过（0 warnings，或明确标记为"接受风险"）
- [ ] 无新引入的问题（diff 基线 vs 修复后）

---

## 审查结论

本次提交实现了 hcom 启发的消息可观察性功能，整体代码质量良好，架构设计合理。发现 3 个高危问题需要立即修复（算术溢出、并发逻辑错误、死锁风险），3 个中等问题建议尽快修复（异步锁、内存泄漏、命名混淆），以及 3 个低危问题可以后续清理。

**建议**：在合并前修复所有高危问题，中等问题可以在后续迭代中处理。
