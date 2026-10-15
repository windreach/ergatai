# Ergatai API 测试报告

## 测试环境
- API URL: http://localhost:3000
- Mock Agent: ./scripts/mock-acp-agent.py
- 测试时间: $(date)

## 测试结果

### ✅ 通过的测试 (5/8)

1. **健康检查** - `/health` 端点正常
2. **列出 Workspaces** - `/api/v1/workspaces` 端点正常
3. **列出 Agents** - `/api/v1/agents` 端点正常
4. **获取状态** - `/api/v1/status` 端点正常
5. **Workspace 生命周期** - 创建和删除 workspace 正常工作

### ❌ 失败的测试 (3/8)

1. **Mock Agent 生命周期** - Agent spawn 失败
2. **多 Mock Agent 协作** - Agent spawn 失败
3. **Mock Agent 消息传递** - Agent spawn 失败

## 失败原因

所有失败的测试都因为同一个 API bug：

**Workspace ID 验证不一致**

- Workspace 创建时接受字符串 ID（UUID 或数字字符串）
- 但 GET workspace 和 Agent spawn 端点尝试将 workspace_id 解析为 `i64`
- 导致这些端点返回 "Invalid workspace ID format" 错误

### 受影响的端点

1. `GET /api/v1/workspaces/{id}` - 期望 i64，但存储为 string
2. `POST /api/v1/agents` - workspace_id 验证失败

### 代码位置

`crates/ergatai-api/src/api/workspaces.rs`:
```rust
let workspace_id_i64 = match workspace_id.parse::<i64>() {
    Ok(id) => id,
    Err(_) => {
        return bad_request(format!("Invalid workspace ID format: {}", workspace_id))
    }
};
```

## 建议修复

1. 统一 workspace ID 类型（全部使用 string 或全部使用 i64）
2. 或者移除 workspace_id 的 i64 解析，直接使用 string 查询数据库

## Mock Agent Profile

✅ 成功注册 mock-acp-agent profile
- Name: mock-acp-agent
- Command: `python3 /path/to/mock-acp-agent.py {agent_name}`
- Agent Type: acp

## 结论

基础 API 功能正常，但 agent 相关功能因 workspace ID 验证 bug 无法测试。
需要修复 API 中的 workspace ID 类型不一致问题。
