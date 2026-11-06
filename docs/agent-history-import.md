# Agent 历史导入（ACP Resume）进度与后续计划

## 1. 已完成

### 1.1 通用 Job Queue 基础设施
- `job_queue` 表（迁移自 `deletion_queue`）。
- 通用函数：`enqueue_job`、`dequeue_jobs`、`mark_job_done`、`mark_job_failed`。
- `job_queue_worker` 按 `job_type` 分发，支持 `deletion` 与 `persistence`。

### 1.2 ACP 历史捕获（v2）
- 启用 `unstable_protocol_v2` feature。
- Runtime 新增 `resume_session_capture`，使用 `session/resume` + `replay_from: start`。
- 捕获通道收集 `session/update` 通知（JSON），支持 `max_messages` 上限。

### 1.3 持久化策略（固定导入 + 游标分批）
- 自动探测：`listAgentSessions` 时为未绑定 session 入队 `import_agent_session_history` job。
- 固定范围：最近 50 个 session，每 session 捕获 50 条、入库最近 20 条。
- 幂等：无导入状态的旧 conversation 已有消息则跳过；带导入状态时按 cursor 滚动补充。
- `agent_sessions` 表新增导入状态字段：`imported_count`、`import_cursor`、`has_more`、`total_captured`。
- 游标：`import_cursor` 保存下一批待导入区间的结束索引；`import-history` 支持 `cursor`；更新 `imported_count/import_cursor/has_more/total_captured`。

### 1.4 API 端点
- `GET /api/v1/conversations/{id}/import-state`
- `POST /api/v1/conversations/{id}/import-history`（body: `agent_id`, `acp_session_id`, `limit`, `cursor`）

### 1.5 测试
- `ergatai-api` 单元测试全部通过（311 tests）。

---

## 2. 未完成

### 2.1 游标与分批导入（滚动补充）—— 后端已完成
- ✅ `import_cursor` 生成/解析已实现（结束索引字符串）。
- ✅ `has_more` 基于剩余更早区间计算。
- ⏳ 前端“滚动到顶部”触发补充导入仍未接入（见 2.3）。

### 2.2 消息渲染映射 —— 后端已完成（前端渲染待验证）
- `parts` 对文本消息转为 `[{ type: "text", text }]`，非文本更新保留原始 ACP JSON。
- `role` 已按 `user_message_chunk` / `user_message` 识别为 user，其余为 assistant。
- 原始 ACP 更新保存在 `metadata.acp_update`。

### 2.3 前端集成 —— 部分完成
- ✅ 已接入 `import-state` / `import-history` API（tRPC）。
- ✅ `ActiveChatMessages` 滚动到顶部触发导入（limit=20），并显示 loading / “已导入前 50 条”。
- ✅ 导入后通过 `reloadConversationHistory` 刷新消息并尽量保持滚动位置。
- ⏳ `AgentHistorySelector` 仍主要显示 ACP sessions；更完整的导入进度 UI 待完善。

### 2.4 会话范围与限制
- 50 个 session 的固定范围未做分页/游标。
- 50 条/会话的总上限未在多批间累积控制。

---

## 3. 后续实施计划

### Phase 1：游标与分批（后端）
1. 定义 cursor 格式（例如最后一条导入消息的 sequence 或 ACP cursor）。
2. `import_agent_session_history` 支持 `cursor` 输入。
3. 更新 `imported_count`、`import_cursor`、`has_more`。
4. API `import-history` 支持 `cursor`。

### Phase 2：消息映射（后端）
1. 提取 `session/update` 中的 `UserMessageChunk` / `AgentMessageChunk` 文本。
2. 将 `parts` 转换为前端可渲染的结构（role + content）。
3. ToolCall/Plan 等更新可选持久化为 metadata。

### Phase 3：前端集成
1. 在 conversation 顶部展示导入状态与 loading。
2. 滚动到顶部触发 `import-history`（limit=20）。
3. 追加消息时保持滚动位置。
4. 达到 50 条时显示“已导入前 50 条”。

### Phase 4：可观测性与健壮性
1. ✅ Job 失败原因记录：`job_queue.last_error` 字段 + `mark_job_failed(..., error)`；worker 记录错误信息。
2. ⏳ Agent 不支持 resume 的降级提示（错误已记录，前端提示待接入）。
3. ✅ 集成测试：`crates/ergatai-runtime/tests/acp_integration_test.rs::test_acp_resume_session_capture`（mock agent 已支持 `session/resume`）。

---

## 4. 关键文件

- Runtime 捕获：`crates/ergatai-runtime/src/backends/acp.rs`
- Job Queue：`crates/ergatai-api/src/services/job_queue_worker.rs`
- DB 迁移/状态：`crates/ergatai-api/src/user_data_db.rs`
- API：`crates/ergatai-api/src/api/user_conversations.rs`
- 前端选择器：`frontend/src/renderer/features/agents/ui/agent-history-selector.tsx`

---

## 5. 风险与注意事项

- **ACP v2 不稳定**：目标 agent 必须支持 `session/resume`。
- **重复导入**：当前幂等基于“已有消息”，后续需按 cursor 去重。
- **性能**：捕获 50 条 × 50 会话可能产生大量 IO，需控制并发与批大小。
- **UI 一致性**：导入期间避免重复渲染与滚动跳动。

---

## 6. 下一步建议

优先实现 **Phase 1（游标与分批）**，使滚动补充导入具备后端基础，再进入前端集成。