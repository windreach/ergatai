# ACP 协议研究报告

## 什么是 ACP？

**Agent Client Protocol (ACP)** - 标准化代码编辑器和编码 agent 之间的通信协议。

- 官方网站：https://agentclientprotocol.com/
- Rust SDK：https://github.com/agentclientprotocol/rust-sdk
- 协议版本：v1 (stable), v2 (draft)

## 核心概念

### 角色

| 角色 | 说明 |
|------|------|
| **Client** | 代码编辑器（如 Cursor、VS Code） |
| **Agent** | 编码 agent（如 Claude、Codex） |
| **Proxy** | 中间件，拦截和转换消息 |
| **Conductor** | 编排多个 proxy 的链式结构 |

### 通信方式

```
Client ↔ Proxy Chain ↔ Agent
         (可选)
```

- **stdio**: 标准输入输出（本地进程）
- **HTTP/SSE**: 网络通信
- **WebSocket**: 双向实时通信

### 核心方法

| 方法 | 用途 |
|------|------|
| `initialize` | 建立连接，协商能力 |
| `session/new` | 创建新会话 |
| `session/prompt` | 发送提示给 agent |
| `session/load` | 加载已有会话 |
| `_proxy/initialize` | 初始化 proxy |
| `_proxy/successor` | 转发消息到下一个组件 |

## Rust SDK 结构

```
src/
├── agent-client-protocol/              # 核心 SDK
├── agent-client-protocol-http/         # HTTP/SSE/WebSocket 传输
├── agent-client-protocol-rmcp/         # MCP 集成
├── agent-client-protocol-conductor/    # Proxy 编排
├── agent-client-protocol-polyfill/     # 兼容性 proxy
└── agent-client-protocol-cookbook/     # 使用模式示例
```

## 简单 Agent 示例

```rust
use agent_client_protocol::{Agent, Result, Stdio};

#[tokio::main]
async fn main() -> Result<()> {
    Agent::builder()
        .name("my-agent")
        .on_receive_request(
            async move |initialize: InitializeRequest, responder, _connection| {
                responder.respond(
                    InitializeResponse::new(initialize.protocol_version)
                        .agent_capabilities(AgentCapabilities::new()),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_to(Stdio::new())
        .await
}
```

## 对 ergatai 的意义

### 可以替换的部分

| 现有组件 | ACP 替代方案 |
|---------|-------------|
| PTY 注入 | ACP 协议通信 |
| NATS/JetStream | ACP 会话管理 |
| MCP 服务器 | ACP + MCP bridge |
| 复杂文件锁 | 应用层锁（通过 ACP 控制） |

### 可以保留的部分

| 组件 | 说明 |
|------|------|
| Agent 生命周期管理 | 仍需管理 agent 进程 |
| DAG 调度器 | 核心协作逻辑 |
| 消息路由设计 | 简化后保留 |
| 错误处理框架 | 保留 |

### 需要新增的部分

| 组件 | 说明 |
|------|------|
| ACP 适配器 | 将 ACP 协议转换为内部消息 |
| ACP Agent 包装器 | 将现有 agent 包装为 ACP agent |
| 会话管理 | ACP 会话生命周期 |

## 优势分析

### ✅ 采用 ACP 的好处

1. **标准化协议**
   - 与 Cursor、VS Code 等编辑器兼容
   - 未来可扩展到更多 agent

2. **简化架构**
   - 不需要 PTY 管理（复杂）
   - 不需要 NATS（过度设计）
   - 不需要复杂文件锁（OS 级）

3. **更好的控制**
   - 协议层拦截（比 OS 层简单）
   - 完全监控 agent 行为
   - 应用层锁更容易实现

4. **生态系统**
   - 官方 Rust SDK（可直接使用）
   - 已有 10+ agent 支持
   - 社区活跃

### ❌ 潜在风险

1. **协议成熟度**
   - v2 仍是 draft 状态
   - 可能有 breaking changes

2. **依赖风险**
   - 依赖 ACP 生态发展
   - 如果 ACP 失败，需要迁移

3. **学习成本**
   - 需要理解 ACP 协议细节
   - 需要重写通信层

## 实施路线图

### Phase 1: 调研验证（1-2 周）

- [ ] 深入理解 ACP 协议（已完成初步调研）
- [ ] 运行 ACP 示例代码
- [ ] 测试与现有 agent 的兼容性
- [ ] 评估迁移工作量

### Phase 2: 最小原型（3-4 周）

- [ ] 实现 ACP 适配器（核心）
- [ ] 包装一个 agent 为 ACP agent
- [ ] 实现基础会话管理
- [ ] 测试 agent 间通信

### Phase 3: 迁移核心功能（4-6 周）

- [ ] 移除 PTY 注入代码
- [ ] 移除 NATS 依赖
- [ ] 简化文件锁为应用层
- [ ] 保留 DAG 调度器
- [ ] 集成测试

### Phase 4: 完善和优化（2-3 周）

- [ ] 性能优化
- [ ] 错误处理完善
- [ ] 文档编写
- [ ] 发布 v0.1.0

**总工作量：10-15 周**

## 关键决策点

### 决策 1: 是否采用 ACP？

**建议：是**

理由：
- 简化架构（减少 50% 复杂度）
- 标准化协议（未来扩展性）
- 官方 Rust SDK（降低开发成本）
- 更好的控制（应用层锁）

### 决策 2: 如何处理现有代码？

**建议：保留核心，重写通信层**

保留：
- Agent 生命周期管理
- DAG 调度器
- 协作逻辑

重写：
- 通信层（PTY → ACP）
- 消息队列（NATS → ACP sessions）
- 文件锁（OS → 应用层）

删除：
- PTY 管理代码
- NATS 集成
- MCP 服务器
- fanotify/enforcer

### 决策 3: 开源策略？

**建议：MIT 协议，建立生态**

- 核心库开源（MIT）
- 示例代码开源
- 文档公开
- 建立社区

## 下一步行动

1. **立即可做：**
   - 运行 ACP 示例代码
   - 测试与 Claude/Codex 的兼容性
   - 评估具体迁移工作量

2. **本周完成：**
   - 详细设计 ACP 适配器架构
   - 制定迁移计划
   - 确定优先级

3. **本月完成：**
   - 实现最小原型
   - 验证技术可行性
   - 决定是否全面推进

## 参考资源

- [ACP 官网](https://agentclientprotocol.com/)
- [Rust SDK 文档](https://docs.rs/agent-client-protocol)
- [Cookbook 示例](https://docs.rs/agent-client-protocol-cookbook)
- [Conductor 设计](./rust-sdk/md/conductor.md)
- [协议参考](./rust-sdk/md/protocol.md)
