# Compact 信息源迁移计划（SDK → Rust 后端接口）

## 背景

当前 `tool-Compact` 有两条来源：

1. Claude Code 路径：前端主进程 `frontend/src/main/lib/claude/transform.ts` 监听 Claude SDK 的 `status: compacting / compact_boundary`，合成 `tool-Compact` 消息部分。信息来自 SDK 消息流，不是 Ergatai 后端接口。
2. ACP / OpenCode 路径：后端 `acp_extension.rs` 仅解析 `opencode/compaction` meta 并合并到 `extension_meta`；前端未消费，未生成 `tool-Compact` 卡片。ACP 压缩信号通过 `session_info_update + _meta.opencode/compaction` 传递。

目标：**统一走 Rust 后端现有接口（SSE + agent outputs），不再依赖 Claude SDK 直接合成**，前端只做事件映射。

## 原则

- 不新增端口/接口；复用现有 SSE 流与 agent outputs API。
- Rust 后端作为唯一信息源：ACP adapter 信号 → Rust 解析/转发 → SSE → 前端映射。
- 保持 `tool-Compact` 消息部分语义，供 `message-store.ts` 的 token 窗口与 rollback 逻辑使用。

## Rust 后端改造

### R1. SSE 事件结构化（`crates/ergatai-runtime/src/backends/acp.rs`）
- `ExtensionUpdate { kind: "compaction_update" | "compaction_summary_chunk", payload }` 已转发，确认 payload 完整保留 compaction id/status/summary/facts。
- legacy 合成工具调用（title `Compact conversation`）保持转发 `ToolCallStart/Complete`，并在 `_meta` 中保留 `claudeCode.toolName = "compact"` 或 AIR `contextCompaction`。
- 新增/调整：在 `ToolCallStart` 路径识别 compaction 工具调用（title 或 `_meta`），统一 `name` 为 `"Compact"`（或保留原名并在前端映射），避免前端分支。

### R2. 落盘（`crates/ergatai-api/src/services/agent_output_persistence.rs` + `user_data_db`）
- 确保 compaction 相关 `ToolCallStart/Complete` 与 `ExtensionUpdate` 被持久化到 agent output 的 `tool_calls` / `metadata`。
- 对 `ExtensionUpdate(compaction_*)`，在 accumulator 中除文本累积外，额外记录结构化 compaction 标记（便于历史恢复）。

### R3. ACP meta → 统一事件（`crates/ergatai-runtime/src/acp_extension.rs` + `acp.rs`）
- `session_info_update._meta.opencode/compaction`（started/completed/failed）应转成与 Claude 路径一致的 `ExtensionUpdate` 或结构化 compaction 事件，而不是仅合并到 `extension_meta`。
- 为 OpenCode 路径提供与 Claude 一致的 compaction id/status/summary 字段。

## 前端改造

### F1. 移除 SDK 合成依赖（`frontend/src/main/lib/claude/transform.ts`）
- 移除/停用 `status: compacting / compact_boundary` → `tool-Compact` 的合成逻辑（或保留为 fallback，标记 deprecated）。
- Claude Code 路径改为通过 Ergatai 后端 SSE 获取 compaction 事件。

### F2. SSE 事件映射（`frontend/src/renderer/features/agents/lib/ergatai-chat-transport.ts`）
- `transformEvent` 新增 `extension_update` 分支：
  - kind `compaction_update`：映射为 `tool-input-start` + `tool-input-available`（toolName `Compact`）+（若有 terminal）`tool-output-available`。
  - kind `compaction_summary_chunk`：映射为 `tool-input-delta`。
- legacy `tool_call_start/complete` 中 title/`_meta` 识别为 Compact 时，统一 toolName 为 `Compact`。
- 保证 `tool-Compact` part 的 `state` 为 `output-available`/`result`，供 `message-store.ts` token 窗口使用。

### F3. 类型与 schema（`frontend/src/main/lib/ergatai/sse-client.ts`）
- 扩展 `AgentOutputEvent` 的 `extension_update.payload` 类型，明确 compaction 字段（id/status/summary/facts）。

### F4. 历史恢复
- 从 `/api/v1/conversations/:id/outputs` 恢复时，若 `tool_calls` 含 Compact 标记，重建 `tool-Compact` part。

## 测试

### T1. Rust 单元/集成
- `acp_extension::parse_meta` 已覆盖 `opencode/compaction`；新增测试：meta → ExtensionUpdate 转发。
- `acp.rs` 测试：`compaction_update` / `compaction_summary_chunk` 被转发为 `AgentOutputEvent::ExtensionUpdate`。
- output accumulator 测试：compaction 事件被正确记录。

### T2. 前端
- `ergatai-chat-transport` 单元测试：`extension_update(compaction_*)` → `tool-Compact` chunks。
- `message-store` 测试：含 `tool-Compact` part 时 token 窗口 startIndex 正确。

### T3. 端到端
- Claude Code 与 OpenCode 两条路径均在 SSE 流中产生 `tool-Compact` 卡片，历史视图可恢复。

## 里程碑

1. **M1**：Rust 转发与落盘稳定（R1-R3）。
2. **M2**：前端映射与 SDK 路径下线（F1-F2）。
3. **M3**：历史恢复与测试覆盖（F4, T1-T3）。

## 风险与回退

- Claude SDK 路径下线前保留 fallback 开关，便于回退。
- OpenCode 路径字段差异较大，需在 Rust 侧做字段归一化，避免前端分支。
- compaction 事件可能重复（SDK 重复 terminal），Rust 侧需幂等处理（参考 adapter `ContextCompactionLifecycle`）。