# tmux 注入问题修复

## 问题描述

agent 间通信时，消息被注入到 bash shell 而不是 opencode，导致 bash 尝试执行 JSON 消息作为命令：

```
$ {"from":"agent-3","message":"..."}[Reply via send_message MCP, then TERMINATE] 
opencode: 行 5: from:agent-3[Reply: 未找到命令
```

## 根本原因

1. **opencode 进程崩溃或退出**：tmux pane 现在运行的是父 shell（bash）
2. **ergatai 继续注入消息**：`send_to_pane` 不检查 pane 状态，直接把消息注入到 bash
3. **bash 尝试执行 JSON**：bash 把 JSON 当作命令执行，失败并报错

## 为什么手动复制粘贴能工作

- 手动测试时，opencode 还在运行
- 自动化注入时，opencode 可能已经崩溃

## 解决方案

在 `send_to_pane` 函数中添加 pane 状态检查：

### 新增函数

```rust
/// 检查 pane 当前运行的命令
async fn get_pane_command(pane: &str) -> Option<String>

/// 检查 pane 是否在运行 shell（bash/sh/zsh/fish）
async fn is_pane_running_shell(pane: &str) -> bool
```

### 修改 `send_to_pane`

在注入前检查 pane 状态：

```rust
async fn send_to_pane(pane: &str, text: &str) -> ErgataiResult<()> {
    // 检查 pane 是否在运行 shell（agent 进程已死亡）
    if Self::is_pane_running_shell(pane).await {
        tracing::warn!(
            pane = %pane,
            "Pane is running shell (agent likely died). Skipping injection to prevent command execution."
        );
        return Err(ErgataiError::internal(format!(
            "Cannot inject message: pane {} is running shell (agent process died)",
            pane
        )));
    }
    
    // 原有的注入逻辑...
}
```

## 效果

1. **防止错误注入**：当 agent 进程死亡时，不再向 shell 注入消息
2. **清晰的错误提示**：返回明确的错误信息，说明 agent 进程已死亡
3. **日志记录**：warn 级别日志记录 pane 状态

## 后续改进

1. **自动重启 agent**：检测到 pane 运行 shell 时，可以尝试重启 agent
2. **健康检查增强**：在 `is_alive` 中增加进程检查
3. **告警机制**：当 agent 死亡时发送告警

## 测试验证

编译并部署后，当 agent 崩溃时：
- 消息注入会失败并返回错误
- 日志中会看到 "Pane is running shell" 警告
- 不会再出现 bash 尝试执行 JSON 的情况

## 相关文件

- `crates/ergatai-runtime/src/backends/tmux.rs`: 添加 pane 状态检查
- `crates/ergatai-api/src/mcp/message_delivery.rs`: 消息投递（使用 send_to_pane）
- `crates/ergatai-api/src/mcp/server.rs`: 消息格式化
