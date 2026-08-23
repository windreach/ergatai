# Agent 启动失败修复

## 问题描述

运行 `ergatai start opencode` 后：
- tmux 会话被创建
- 但 opencode 没有启动，pane 运行的是 bash
- 用户输入的命令进入 bash 而不是 opencode

## 根本原因

**Pane ID 不匹配**：

1. 原始 agent 启动在 pane `%0, %1, %2`
2. opencode 崩溃或退出，pane 死亡
3. tmux 自动或手动创建了新 pane `%3, %4, %5`（运行 bash）
4. 服务器注册表仍然保存旧的 pane ID (`%0, %1, %2`)
5. 周期性 discovery 运行时：
   - 发现当前 pane 是 `%3, %4, %5`
   - 但检查到 workspace 已有 agent 注册（旧的 `%0, %1, %2`）
   - 只更新 metadata，**没有验证 pane_id 是否匹配**
   - 跳过重新注册
6. `ergatai start` 再次运行时：
   - 看到"agent already running"（基于过期注册表）
   - 不会启动新 agent

## 日志证据

```
# 服务器注册表
curl http://localhost:3000/api/v1/agents
[
  {"agent_id": "%0", "workspace_id": "start-opencode-1", ...},
  {"agent_id": "%1", "workspace_id": "start-opencode-2", ...},
  {"agent_id": "%2", "workspace_id": "start-opencode-3", ...}
]

# 实际 tmux panes
tmux list-panes -a
ergatai-start-opencode-1 %3 bash
ergatai-start-opencode-2 %5 bash
ergatai-start-opencode-3 %4 bash
```

**Pane ID 不匹配！** 注册表有 %0,%1,%2，实际是 %3,%4,%5。

## 解决方案

在 `discover_and_register_agents` 中添加 pane_id 验证：

```rust
if let Some(existing) = registry.values_mut().find(...) {
    let existing_pane_id = existing.handle.metadata.get("pane_id");
    let new_pane_id = handle.metadata.get("pane_id");
    
    if existing_pane_id != new_pane_id {
        warn!("Pane changed — agent likely died. Re-registering.");
        // Remove old registration
        registry.remove(&old_agent_id);
        // Fall through to register new agent
    } else {
        // Same pane - just update metadata
        continue;
    }
}
```

## 效果

✅ **自动检测 pane 变化**：当 agent 死亡且 pane 被重建时，自动重新注册
✅ **清晰的警告日志**：记录 pane 变化和重新注册
✅ **防止过期注册**：不再使用过期的 pane ID

## 与 tmux 注入修复的关系

这两个问题是相关的：

1. **Agent 死亡** → pane 变成 bash
2. **过期注册** → `ergatai start` 不启动新 agent
3. **消息注入到 bash** → bash 尝试执行 JSON 命令

修复后的流程：

```
Agent 死亡
  ↓
Pane 变成 bash (新 pane ID)
  ↓
Discovery 检测到 pane_id 变化
  ↓
移除旧注册，重新注册新 pane
  ↓
下次 ergatai start 看到没有运行中的 agent
  ↓
启动新 agent
```

## 相关文件

- `crates/ergatai-runtime/src/runtime.rs`: 添加 pane_id 验证
- `crates/ergatai-runtime/src/backends/tmux.rs`: 添加 pane 状态检查（防止注入到 bash）

## 测试验证

重启服务器后：
1. 杀掉旧的 tmux sessions
2. 运行 `ergatai start opencode`
3. 验证 opencode 正常启动
4. 检查日志没有 "Pane is running shell" 错误
