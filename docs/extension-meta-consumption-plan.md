# Extension Meta 消费计划（ACP `_meta` / 自定义字段）

## 背景

当前 `crates/ergatai-runtime/src/acp_extension.rs` 已经把 adapter 的 `_meta` 解析为类型化的 `ExtensionMeta` / `UnifiedExtensionMeta`，并由 `backends/acp.rs` merge 保存。`crates/ergatai-runtime/src/acp_custom_fields.rs` 也提供了 18 个 adapter-specific helper。

但当前状态是：

- 大多数字段只完成“类型归一化 + merge + 保留”，没有消费面。
- `get_agent_extension_meta()` 只存在于 runtime，API / frontend 未调用。
- 只有少数字段被真正消费：compaction、quota、tool-call 元信息（`parent_tool_use_id`、`claude_tool_name`）、compaction tool detection。

本计划目标：**在不破坏现有 SSE/agent output 流的前提下，为 Extension Meta 建立消费面，并按优先级 surfaced 高价值字段。**

## 原则

- 不新增端口；复用现有 SSE、agent outputs API、tRPC/HTTP 路由。
- Rust 后端继续作为唯一信息源：adapter `_meta` → Rust 解析/归一化 → SSE/API → 前端映射。
- 优先 surfaced 影响 UI 渲染或用户决策的字段；诊断/内部字段先通过只读查询暴露。
- 保持 opaque payload（`jetbrains` / `codex` / `opencode` / `claude`）作为前向兼容兜底。
- 对新增字段采用“提一个发一个”：先类型化，再决定是否 emitted。

## Phase 0：消费面基线（P0）

### P0-1. 暴露只读查询 API

**目标**：让 API/frontend 能读取 agent 的 `ExtensionMeta`。

**涉及文件**：
- `crates/ergatai-runtime/src/backends/acp.rs`：已有 `get_agent_extension_meta()`。
- `crates/ergatai-runtime/src/backend.rs`：trait `extension_meta()` 已有默认实现。
- `crates/ergatai-api/src/services/agent_service.rs`：新增 `get_agent_extension_meta()` wrapper，模式参考 `get_agent_usage()`。
- `crates/ergatai-api/src/api/agents.rs` 或新增路由：暴露 `GET /api/v1/agents/:id/extension-meta` 或等价 tRPC query。

**验收**：
- API 可返回某个 agent 的 `ExtensionMeta` JSON。
- 不存在 agent 时返回 `None`/404，不 panic。
- 前端可 fetch 并类型化。

### P0-2. 建立前端类型与 store

**目标**：前端能读取并缓存 ExtensionMeta。

**涉及文件**：
- frontend agent service / store：新增 `extensionMeta` 状态。
- frontend types：复用 Rust `ExtensionMeta` serde 结构。

**验收**：
- 前端可查询并展示至少 `compaction`、`terminal`、`air_file_change_report`、`air_worktrees`、`air_async_tasks`、`air_diff_patch`。

## Phase 1：surfaced 高价值字段（P1）

### P1-1. 文件变更 / worktree / async task / diff

**目标**：把 AIR 中影响 UI 的字段转为 SSE 事件。

**涉及文件**：
- `crates/ergatai-runtime/src/backends/acp.rs`：`SessionUpdate::SessionInfoUpdate` 或 notification 路径。
- `crates/ergatai-runtime/src/acp_extension.rs`：已有 `air_file_change_report`、`air_worktrees`、`air_async_tasks`、`air_diff_patch`。

**新增/调整事件**：
- `AgentOutputEvent::ExtensionUpdate { kind: "file_change_report", payload }`
- `AgentOutputEvent::ExtensionUpdate { kind: "worktrees_update", payload }`
- `AgentOutputEvent::ExtensionUpdate { kind: "async_tasks_update", payload }`
- `AgentOutputEvent::ExtensionUpdate { kind: "diff_patch", payload }`

**验收**：
- 当 `_meta.jetbrains.air.*` 出现这些字段时，SSE 流发出对应事件。
- 前端可映射为文件变更/worktree/async task/diff UI。

### P1-2. Terminal 元数据

**目标**：surfaced terminal info/output/delta/exit/auth。

**涉及文件**：
- `crates/ergatai-runtime/src/acp_custom_fields.rs`：`extract_terminal_meta()`。
- `crates/ergatai-runtime/src/acp_extension.rs`：`ExtensionMeta.terminal`。

**新增/调整事件**：
- `AgentOutputEvent::ExtensionUpdate { kind: "terminal_update", payload }`
- 或挂到 tool result metadata。

**验收**：
- terminal 相关 `_meta` 能被前端读取并渲染。

### P1-3. Custom Answer

**目标**：把 ask-user-question 自定义答案接入流程。

**涉及文件**：
- `crates/ergatai-runtime/src/acp_custom_fields.rs`：`extract_custom_answer()`。
- `crates/ergatai-runtime/src/acp_extension.rs`：`ExtensionMeta.air_custom_answer`。

**方式**：
- 优先接入问答流程；若暂时无法接入，发出 `ExtensionUpdate { kind: "custom_answer", payload }`。

**验收**：
- 自定义答案不再只落库，能被消费。

### P1-4. Compaction 子字段补齐

**目标**：确保 `trigger/pre_tokens/post_tokens/duration_ms/error` 可消费。

**涉及文件**：
- `crates/ergatai-runtime/src/acp_extension.rs`：`compaction_*` 字段。
- `crates/ergatai-runtime/src/backends/acp.rs`：compaction 事件发送路径。

**方式**：
- 在 `compaction_update` payload 中包含这些子字段，或新增 `compaction_summary`/`compaction_error` 事件。

**验收**：
- 前端读取 `compaction_update` payload 即可拿到 trigger/tokens/duration/error。

## Phase 2：状态与诊断字段（P2）

### P2-1. Prompt Suggestions

**目标**：surfaced prompt suggestions。

**事件**：
- `ExtensionUpdate { kind: "prompt_suggestions", payload }` 或 session info。

### P2-2. Thread Status / Quota / Rate Limit / Auth Status

**目标**：把状态/限制/认证信息暴露给 agent status 或 diagnostics。

**方式**：
- 通过 Phase 0 的只读 API 返回。
- 必要时发出 `Status` / `ExtensionUpdate`。

### P2-3. Claude 元信息

**目标**：surfaced `claude_vertex`、`claude_options`、`claude_non_execution_kind`、`claude_prompt_queueing`。

**方式**：
- 优先挂到 `ToolCallStart` 或 tool metadata。
- 其次发出 `ExtensionUpdate { kind: "claude_code", payload }`。

### P2-4. Session-defining Metadata

**目标**：暴露 `additional_roots`、`system_prompt`、`disable_built_in_tools`、`gateway`、`goal`。

**方式**：
- 通过 session info / agent snapshot 返回，而不是 SSE 高频事件。

## Phase 3：准确性与维护性（P3）

### P3-1. 清理死代码 helper

**目标**：处理 `extract_air` / `extract_air_field`。

**选项**：
- 方案 A：用这两个 helper 重构 AIR 提取，统一 snake/camel 兜底。
- 方案 B：删除未使用 helper，避免误导。

### P3-2. Claude 子字段 top-level fallback

**目标**：当 `_meta` 直接提供 `claude_vertex` / `claude_options` 等子字段时，也能提取。

**涉及**：
- `extract_claude_vertex()`、`extract_claude_options()` 等。

### P3-3. Nested drift detection

**目标**：对 `jetbrains.air.*` 做 nested unknown key 检测。

**涉及**：
- `unknown_meta_keys()` 扩展 nested 检查。

### P3-4. AIR 覆盖清单固化

**目标**：明确 typed 字段与 opaque payload 的边界。

**输出**：
- 更新 `acp-custom-file` / `acp-extansion` audit 文档。
- 列出新增 AIR key 的处理策略：typed / opaque / ignored。

## 测试

### Rust
- `acp_extension::parse_meta`：新增字段提取测试。
- `acp.rs`：新增 ExtensionUpdate 转发测试（file_change_report、worktrees、async_tasks、diff_patch、terminal、custom_answer、prompt_suggestions）。
- agent service：新增 `get_agent_extension_meta` 测试。
- merge 逻辑：新增字段 merge 不覆盖已有值。

### Frontend
- SSE transport：`extension_update` 新 kind 映射测试。
- store：ExtensionMeta fetch/cache 测试。
- UI：高价值字段渲染测试。

### 端到端
- Claude/OpenCode 两条路径均能 surfaced 文件变更/worktree/async task/diff/terminal。
- 历史恢复时可读取 ExtensionMeta。

## 里程碑

1. **M0**：Phase 0 完成，ExtensionMeta 有只读消费面。
2. **M1**：Phase 1 完成，高价值字段 surfaced 为 SSE 事件。
3. **M2**：Phase 2 完成，状态/诊断字段可查询。
4. **M3**：Phase 3 完成，死代码与覆盖策略收敛。

## 风险与回退

- surfaced 字段可能带来 SSE 事件量增加；建议对高频字段做去重/节流（如 `compaction_update` 已有 previous 比较）。
- 前端映射新增分支可能影响现有消息渲染；建议 feature flag 或渐进启用。
- adapter 字段差异较大，Rust 侧必须归一化，避免前端分支。
- opaque payload 保留可作为回退，确保未 typed 字段不会丢失。