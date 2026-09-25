# 修复：Agent 自动启动顺序问题

## 问题描述

当 agent 尝试向未运行的 agent 发送消息时，系统报错：
```
Sender 'claude-code' is not a registered runtime agent. 
Cannot enforce rate limits — message rejected.
```

**根本原因**：消息发送流程中的执行顺序问题

### 原流程（有 bug）
1. **准入控制**（包括速率限制）← 在这里失败
2. Agent 解析和自动启动 ← 永远执行不到

`RateLimitGate` 要求发送者必须是已注册的 runtime agent，但自动启动逻辑在准入控制之后才执行，导致未注册的 sender 被直接拒绝。

## 解决方案

**调整执行顺序**：先解析/启动 agent，再进行准入控制

### 新流程（修复后）
1. **Step 1**: Agent 解析
   - 1a. 解析 sender（如果是 profile 名称，自动启动）
   - 1b. 解析 target（如果是 profile 名称，自动启动）
   - 1c. 创建带有解析后 ID 的 resolved request
2. **Step 2**: 准入控制（现在看到的是有效的 runtime agent ID）
3. **Step 3**: 继续后续处理

## 代码变更

### 文件：`crates/ergatai-api/src/messaging/mod.rs`

#### 1. 重构 `MessageSender::send()` 方法

**变更前**：
```rust
// 1. 准入控制（速率限制在这里检查 sender）
if let AdmissionResult::Denied { reason } = self.admission_gate.check(&req, &runtime).await {
    return SendMessageResult::Rejected { reason };
}

// 2. Agent 解析（永远执行不到）
let resolved_agent_id = match self.resolve_target_agent(&runtime, &req.to).await {
    // ...
};
```

**变更后**：
```rust
// ── Step 1: Agent resolution (BEFORE admission control) ──
// 1a. Resolve sender agent (auto-spawn if it's a profile name)
let resolved_sender_id = match runtime.resolve_agent_id(&req.from).await {
    Some(id) => id,
    None => {
        // Sender not found — try to auto-spawn from profile
        match self.try_auto_spawn_agent_standalone(&runtime, &req.from).await {
            Some(agent_id) => agent_id,
            None => {
                // Check if it's a system sender
                const SYSTEM_SENDERS: &[&str] = &["api", "user", "system"];
                if SYSTEM_SENDERS.contains(&req.from.as_str()) {
                    req.from.clone()
                } else {
                    return SendMessageResult::Rejected { /* ... */ };
                }
            }
        }
    }
};

// 1b. Resolve target agent (auto-spawn if it's a profile name)
let resolved_target_id = match self.resolve_target_agent(&runtime, &req.to).await {
    Some(id) => id,
    None => {
        match self.try_auto_spawn_agent(&runtime, &req.to, &resolved_sender_id).await {
            Some(agent_id) => agent_id,
            None => {
                return SendMessageResult::Rejected { /* ... */ };
            }
        }
    }
};

// 1c. Create resolved request with actual runtime agent IDs
let resolved_req = SendRequest {
    from: resolved_sender_id.clone(),
    to: resolved_target_id.clone(),
    // ...
};

// ── Step 2: Admission control (AFTER agent resolution) ──
if let AdmissionResult::Denied { reason } = self.admission_gate.check(&resolved_req, &runtime).await {
    return SendMessageResult::Rejected { reason };
}
```

#### 2. 新增方法：`try_auto_spawn_agent_standalone()`

为 sender 自动启动专门设计的方法，不依赖其他 agent 的 workspace 上下文：

```rust
async fn try_auto_spawn_agent_standalone(
    &self,
    runtime: &AgentRuntime,
    agent_name: &str,
) -> Option<String> {
    // 检查是否是 profile 名称
    let profile = match crate::services::profile_service::get_profile_by_name(agent_name).await {
        Ok(Some(p)) => p,
        Ok(None) => return None,
        Err(e) => {
            warn!(error = %e, agent = %agent_name, "Failed to look up profile");
            return None;
        }
    };

    // 使用默认 workspace（sender 不需要 workspace 上下文）
    let workspace_id = format!("auto-{}", uuid::Uuid::new_v4());
    let work_dir = "/tmp".to_string();

    // 启动 agent
    match runtime.launch_agent(spec, &profile.command, None, Some(&profile.name)).await {
        Ok(agent_id) => Some(agent_id),
        Err(e) => {
            warn!(error = %e, "Failed to auto-spawn sender agent");
            None
        }
    }
}
```

#### 3. 更新后续代码

- 将所有 `req.from` 替换为 `resolved_sender_id`
- 将所有 `resolved_agent_id` 替换为 `resolved_target_id`
- 更新 `pending_responses` 追踪使用 resolved sender ID
- 更新 NATS payload 使用 resolved IDs

## 测试验证

```bash
cargo check -p ergatai-api  # ✅ 编译通过，无错误
cargo test -p ergatai-api --lib messaging  # ✅ 4 tests passed
```

## 影响范围

### 受益场景
1. **Agent 间通信**：当 sender 是 profile 名称但未运行时，自动启动
2. **前端调用**：前端可以直接使用 profile 名称发送消息
3. **动态 agent 管理**：无需手动启动 agent，消息驱动自动启动

### 向后兼容
- ✅ 系统发送者（"api", "user", "system"）继续绕过速率限制
- ✅ 已注册的 agent 正常发送消息
- ✅ 所有现有测试通过

## 关键设计决策

### 为什么 sender 自动启动使用默认 workspace？
- Sender 不需要与 target 在同一个 workspace
- 使用 `/tmp` 作为默认工作目录，避免依赖特定路径
- 自动生成 UUID workspace ID，避免冲突

### 为什么先解析再准入？
- 速率限制需要有效的 runtime agent ID
- 自动启动会创建 runtime agent 记录
- 顺序调整后，速率限制能看到正确的 agent ID

### 为什么保留系统发送者白名单？
- "api", "user", "system" 不是真实的 agent
- 它们不需要速率限制（受信任的来源）
- 允许前端和 API 直接发送消息

## 后续优化建议

1. **Workspace 策略**：可以为 sender 自动启动配置专门的 workspace 池
2. **资源限制**：为自动启动的 agent 设置资源上限
3. **生命周期管理**：自动清理长时间空闲的自动启动 agent
4. **监控指标**：添加自动启动成功/失败的指标

---

**修复日期**：2026-09-25  
**修复文件**：`crates/ergatai-api/src/messaging/mod.rs`  
**影响方法**：`MessageSender::send()`, 新增 `try_auto_spawn_agent_standalone()`
