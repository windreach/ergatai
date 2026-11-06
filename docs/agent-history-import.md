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

### 1.3 持久化策略（固定导入）
- 自动探测：`listAgentSessions` 时为未绑定 session 入队 `import_agent_session_history` job。
- 固定范围：最近 50 个 session，每 session 捕获 50 条、入库最近 20 条。
- 幂等：conversation 已有消息则跳过。
- `agent_sessions` 表新增导入状态字段：`imported_count`、`import_cursor`、`has_more`、`total_captured`。

### 1.4 API 端点
- `GET /api/v1/conversations/{id}/import-state`
- `POST /api/v1/conversations/{id}/import-history`（body: `agent_id`, `acp_session_id`, `limit`）

### 1.5 测试
- `ergatai-api` 单元测试全部通过（311 tests）。

---

## 2. 未完成

### 2.1 游标与分批导入（滚动补充）
- 尚未实现 `import_cursor` 的生成/解析。
- 尚未实现 `has_more` 的精确计算（目前基于捕获数量 >= 20）。
- 尚未支持“滚动到顶部”触发补充导入。

### 2.2 消息渲染映射
- 入库的 `parts` 为原始 ACP `session/update` JSON。
- 未提取 `role`/`content` 为可渲染结构。

### 2.3 前端集成
- `AgentHistorySelector` 仍显示 ACP sessions，未展示导入进度。
- 未接入 `import-state` / `import-history` API。
- 未实现滚动触发与 loading UI。

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
1. Job 失败原因记录与重试策略。
2. Agent 不支持 resume 的降级提示。
3. 集成测试（mock agent 支持 resume）。

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