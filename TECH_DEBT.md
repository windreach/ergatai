# 技术债清单

> 最后更新：2026-10-11

## ✅ 已解决

### SSE 通道统一 (2026-10-11)
- **状态**: ✅ 已完成
- **问题**: 前端需要订阅两个 SSE 通道 (`/agents/{id}/stream` 和 `/conversations/{id}/sse`) 才能看到完整对话
- **解决方案**: 
  - `NatsOutputPublisher` 同时发布到 `ergatai.conversation.message.*` (主) 和 `ergatai.agent.output.*` (兼容)
  - `conversation_sse.rs` 支持两种事件类型 (ConversationMessagePayload + AgentOutputEvent)
  - ✅ **已移除**: `/agents/{id}/stream` deprecated endpoint (2026-10-11)
  - ✅ **已清理**: `stream_agent_output` 函数、`AgentStreamQuery` 结构体、相关导入
- **待办**: 前端迁移完成后，移除 `NatsOutputPublisher` 的双发布逻辑和 `ergatai.agent.output.*` subject
- **文档**: `UNIFIED_SSE_IMPLEMENTATION.md`

---

## 🔴 高优先级

### 1. ACP HTTP 后端未实现
- **位置**: `crates/ergatai-runtime/src/backends/acp_http.rs:238-244`
- **问题**: Prompt 投递和取消功能返回 "not implemented" 错误
- **影响**: HTTP 方式连接的 agent 无法正常工作
- **建议**: 实现完整的 HTTP ACP 客户端，支持 prompt 和 cancel

### 2. Subagent 会话持久化未实现
- **位置**: `crates/ergatai-runtime/src/backends/acp.rs:2397, 2415`
- **问题**: Subagent 产生时没有创建对应的 conversation 记录
- **影响**: 前端无法看到 subagent 的历史记录
- **建议**: 在 API 层监听 SubagentSpawned 事件，创建子会话记录

### 3. LockAwarePermissionHandler 未实现锁检查
- **位置**: `crates/ergatai-runtime/src/permission.rs:616-624`
- **问题**: 直接委托给 YoloPermissionHandler（自动批准），没有实际的锁检查逻辑
- **影响**: 多 agent 并发写入时可能出现冲突
- **建议**: 
  1. 从 permission request 中提取文件路径
  2. 检查 ergatai_lock::get_lock_manager() 中的冲突锁
  3. 实现锁竞争的等待/重试机制

### 4. 文件监控的回滚和通知未实现
- **位置**: `crates/ergatai-lock/src/monitor.rs:193-198`
- **问题**: 
  - 未实现基于 hash 快照的文件回滚
  - 未通过 NATS 事件总线发送未授权修改通知
- **影响**: 检测到未授权修改后只能记录，无法自动恢复
- **建议**: 
  1. 实现 snapshot 回滚机制
  2. 发布 `ergatai.file.unauthorized_modification` 事件

---

## 🟡 中优先级

### 5. Profile Name Resolution 未实现
- **位置**: `crates/ergatai-api/src/services/agent_service.rs:235, 737`
- **问题**: `resolve_agent_id` 只支持 runtime ID 和 MCP agent ID，不支持 profile name
- **影响**: 无法通过 profile 名称（如 "claude-code"）直接引用 agent
- **建议**: 在 resolve_agent_id 中添加 ProfileRegistry 查询

### 6. ACP Server 完整实现缺失
- **位置**: `crates/ergatai-api/src/api/acp_server.rs:111`
- **问题**: 当前只是 placeholder，需要使用 `agent_client_protocol_http::AcpHttpServer` 实现完整的 ACP 服务端
- **影响**: ergatai 不能作为 ACP agent 被其他系统调用
- **建议**: 
  1. 创建 AcpHttpServer 实例
  2. 实现 ACP agent 协议处理器
  3. 挂载到 axum router

### 7. DAG 指标计算不完整
- **位置**: `crates/ergatai-api/src/services/dag_service.rs:547`
- **问题**: `avg_completion_time_secs` 始终返回 None，未从时间戳计算
- **影响**: 无法获取 DAG 执行性能指标
- **建议**: 从节点的 started_at 和 completed_at 时间戳计算平均值

### 8. DAG 自定义 Reducer 未实现
- **位置**: `crates/ergatai-dag/src/context.rs:216-223`
- **问题**: `MergeStrategy::Reducer` 回退到覆盖模式，没有实现自定义 reducer 表达式
- **影响**: 多节点输出合并策略受限
- **建议**: 实现表达式求值引擎，支持自定义 reducer 逻辑

---

## 🟢 低优先级

### 9. Bash 路径提取的已知限制
- **位置**: `crates/ergatai-runtime/src/bash_path_extractor.rs:594`
- **问题**: 不支持 `awk -i inplace` 等命令的路径提取
- **影响**: 部分写入操作无法被文件锁系统捕获
- **建议**: 扩展路径提取规则，支持更多命令行工具

### 10. Elicitation form_data 解析未实现
- **位置**: `crates/ergatai-runtime/src/backends/acp.rs:2541`
- **问题**: TODO 注释标记需要解析 form_data 到 ElicitationContentValue map
- **影响**: Elicitation 功能可能不完整
- **建议**: 实现 form_data 解析逻辑

### 11. 资源限制支持未实现
- **位置**: `crates/ergatai-runtime/src/backends/acp.rs:1974`
- **问题**: `supports_resource_limits: false` 标记为 TODO: future enhancement
- **影响**: 无法对 agent 进行 CPU/内存限制
- **建议**: 集成 cgroups 或其他资源限制机制

### 12. 错误分类的链式 downcast 模式不足
- **位置**: `crates/ergatai-error/src/classify.rs:25`
- **问题**: TODO 注释建议添加更多 chain downcast 模式
- **影响**: 某些错误类型可能无法正确分类
- **建议**: 根据实际错误类型添加更多 downcast 模式

---

## 📋 命名混乱技术债

### 14. conversation_id 命名不统一
- **统计**:
  - `conversation_id`: 443 处（完整名称，推荐）
  - `conversation_id`: 171 处（奇怪缩写）
  - `conversation_id`: 69 处（另一个缩写）
  - **总计**: 683 处使用，三种命名混用
- **主要分布**:
  - `conversation_id`: runtime.rs, backends/acp.rs, messaging/mod.rs, agent_registry.rs
  - `conversation_id`: mcp/conversation.rs, api/agents.rs, api/conversation_sse.rs
- **影响**: 
  - 增加认知负担（需要理解三个名称是同一个概念）
  - 搜索困难（搜索一个名称找不到所有使用）
  - 代码审查和重构容易遗漏
- **建议**: 统一为 `conversation_id`
  1. 全局替换 `conversation_id` → `conversation_id`（171 处）
  2. 全局替换 `conversation_id` → `conversation_id`（69 处）
  3. 更新注释和文档
  4. 运行测试确保没有遗漏
- **优先级**: 🟡 中（不影响功能，但影响可维护性）

---

## 📋 Legacy 代码

### 13. Legacy Chat 兼容性代码
- **位置**: `crates/ergatai-api/src/user_data_db.rs:2024` (`legacy_chats` 模块)
- **问题**: 保留旧的 `subchat_` 前缀格式和 `serialize_legacy`/`replace_legacy` 方法
- **影响**: 增加代码复杂度和维护成本
- **建议**: 评估是否可以移除对旧格式的支持，或添加迁移工具

---

## 处理优先级建议

### 立即处理（影响核心功能）
1. **#3 LockAwarePermissionHandler** - 并发安全
2. **#4 文件监控回滚和通知** - 数据安全

### 近期处理（影响功能完整性）
1. **#2 Subagent 会话持久化** - 前端体验
2. **#1 ACP HTTP 后端实现** - 扩展性

### 中期处理（影响可扩展性）
1. **#5 Profile Name Resolution** - 易用性
2. **#6 ACP Server 完整实现** - 互操作性
3. **#7-8 DAG 指标和 Reducer** - 可观测性

### 长期处理（边缘场景）
1. **#9-12 低优先级技术债**
2. **#13 Legacy 代码清理**

---

## 相关文档

- [CLAUDE.md](../CLAUDE.md) - 项目架构和已知限制
- [UNIFIED_MESSAGE_DELIVERY_REFACTOR.md](./UNIFIED_MESSAGE_DELIVERY_REFACTOR.md) - 最近的消息投递重构
- [OUTPUT_PATH_REFACTOR.md](./OUTPUT_PATH_REFACTOR.md) - 输出路径重构
