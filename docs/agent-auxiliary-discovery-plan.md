# Agent 辅助信息发现计划（Skills / Commands / MCP / Plugins）

> 状态：**核心能力已落地**。OpenCode server 连接管理已实现（健康检查 + 自动回退）。嵌入策略已落地（`include_str!` + 临时目录）。
> 最后更新：2026-11-08（缓存重构 + 模型 SDK 集成 + 前端迁移 + OpenCode 连接管理 + 嵌入策略）

## 目标

- Ergatai 前端通过 `@` / `/` 获取 agent 辅助信息时，不再依赖硬编码或盲猜。
- 后端作为唯一数据源，统一提供 skills、commands、MCP 状态、plugins。
- ACP 专注对话/运行时，SDK/约定作为元数据增强层。

## 三段式架构

1. **ACP（对话/运行时）**
   - 负责：发送消息、流式输出、turn 边界、取消、会话管理。
   - 端点：`/api/v1/agents/:id/*`

2. **约定文件（稳定兜底）**
   - 负责：skills 目录扫描（Claude/Codex/OpenCode + 插件）。
   - 端点：`/api/v1/skills`

3. **Agent SDK（增强层）**
   - 负责：通过 agent 专有 SDK 获取 skills/models/commands/MCP。
   - 实现：Node 子进程（`scripts/agent-sdk-discover.mjs`），Rust 调用并解析 JSON。
   - 端点：`/api/v1/agent-sdk/discover`（内部使用，不直接暴露给前端）

## 统一发现端点

```
GET /api/v1/agents/:id/discovery[?cwd=...][&refresh=1]
  → {
      skills:   [...],   // 约定 + SDK
      commands: [...],   // ACP available commands + SDK
      mcp:      [...],   // 运行时 MCP 状态
      plugins:  [...]    // 运行时/缓存
    }
```

前端只调用此端点，获取全部辅助信息；ACP 对话端点保持独立。

### 数据契约（统一 schema）

```json
{
  "skills": [
    { "name": "string", "description": "string", "path": "string", "source": "user|project|plugin|agent-sdk|convention" }
  ],
  "commands": [
    { "name": "string", "description": "string", "argumentHint": "string", "aliases": ["string"], "source": "acp|agent-sdk" }
  ],
  "mcp": [
    { "name": "string", "status": "connected|failed|needs-auth|pending", "config": "object|null", "source": "agent-sdk|acp|registry" }
  ],
  "plugins": [
    { "name": "string", "version": "string", "description": "string", "path": "string", "source": "string", "marketplace": "string", "category": "string|null", "homepage": "string|null", "tags": ["string"] }
  ]
}
```

约定：
- 所有数组缺失时返回 `[]`，不返回 `null`。
- 部分失败时仍返回已获取的部分，并在顶层附 `errors: [{source, message}]`（可选）。
- `refresh=1` 跳过缓存强制重探。

## 文件布局

```
crates/ergatai-api/
├── src/
│   ├── services/
│   │   ├── agent_sdk_service.rs   # Rust 调用 Node SDK
│   │   ├── skills_service.rs      # 约定扫描
│   │   └── profile_service.rs     # 集成 SDK 结果（待接入）
│   └── api/
│       ├── agents.rs              # /agents/:id 附带 discovery（待实现）
│       ├── skills.rs              # /skills
│       └── agent_sdk.rs           # /agent-sdk/discover
└── assets/
    └── agent-sdk-discover.mjs     # Node helper（include_str! 嵌入，待实现）

scripts/
├── agent-sdk-discover.mjs         # 开发期脚本
└── agent-sdk-model.mjs            # 模型切换 helper
```

嵌入策略（待定，二选一）：
- **A. 嵌入**：`assets/` + `include_str!`，运行时写入临时文件执行；需解决 node_modules 解析（把 helper 与依赖一起打包，或在运行时从安装目录解析）。
- **B. 安装目录**：二进制与 `scripts/`、`node_modules` 一起安装到固定路径，`project_root()` 解析该目录。
当前实现走 B 的雏形（`project_root()`），生产环境需明确安装约定。

## 持久化与缓存策略

| 信息 | 是否持久化 | 策略 |
|---|---|---|
| Profile triggers | ✅ | `native_triggers_json`（启动回填） |
| Models | ✅ | `models_json`（启动探测 + 手动刷新） |
| Skills | ❌ | 运行时探测 + 5 分钟缓存 |
| Commands | ❌ | ACP 推送 + 内存缓存 |
| MCP 状态 | ❌ | 运行时查询 + 30 秒缓存 |
| Plugins | ⚠️ | 运行时/缓存 1 小时 |

缓存设计要求：
- key：`agent_id + cwd`（plugins 仅 `agent_id`/全局）。
- 同一 key 并发请求复用进行中的探测，避免重复 spawn Node。
- `refresh=1` 强制失效并重探。
- TTL 到期后台刷新，不阻塞读取（stale-while-revalidate）。

## Agent SDK 映射（按 agent）

| 辅助信息 | Claude | OpenCode | Codex | 获取方式 |
|---|---|---|---|---|
| Skills | `reloadSkills().skills` | `client.skills()` | 约定目录 | SDK → 约定 |
| Commands | `supportedCommands()` | `client.commands()` | ACP | SDK → ACP |
| MCP 状态 | `mcpServerStatus()` | `client.mcpStatus()` | ACP/注册表 | SDK → ACP → 注册表 |
| Models | `supportedModels()` | providers/config | ACP | SDK → 约定 → ACP |
| 模型切换 | `setModel()` | `sessionSwitchModel()` | 仅启动时 | SDK → ACP `/model` |

修正点（相对当前脚本）：
- Claude 的 `skills` 与 `commands` 必须分离：`skills` 来自 `reloadSkills()`，`commands` 来自 `supportedCommands()`；当前脚本把 `supportedCommands()` 同时映射到两者，需修正。
- Claude 必须调用 `mcpServerStatus()` 获取 MCP 状态，当前脚本未调用。
- OpenCode 依赖运行中的 server（默认 `http://127.0.0.1:4096`）；需明确 server 启动 ownership，失败回退约定/空结果，不能静默 localhost。

## 前端

- `@` / `/` 触发时调用 `/api/v1/agents/:id/discovery`。
- 合并展示 skills、commands、MCP、plugins。
- 不再自己扫描文件系统，不感知 SDK 存在。
- plugins：当前由前端 main 进程扫描 Claude marketplace；若纳入统一端点，需决定后端复刻或前端继续负责（见风险）。

## 实施步骤

1. ✅ 约定层：`/api/v1/skills` 目录扫描。
2. ✅ SDK 增强层：`/api/v1/agent-sdk/discover` + `/api/v1/agent-sdk/models`。Claude skills/commands 已正确分离，MCP 状态已接入。
3. ✅ 统一发现端点：`/api/v1/agents/:id/discovery` 已落地（skills/commands/mcp/plugins），前端 `skills-provider.ts` / `commands-provider.ts` 已迁移。
4. ✅ 缓存层：按 source 分 TTL（convention skills 5min / ACP commands 1min / SDK bundle 30s / plugins 1h）+ stale-while-revalidate（2×TTL 窗口内返回旧数据并后台刷新）+ 并发去重。
5. ✅ 前端迁移：`@` / `/` 下拉调用 `trpcClient.discovery.getSkills` / `getCommands`。
6. ✅ OpenCode SDK 连接：HTTP 健康检查（30s 间隔）+ 自动回退空结果。`OPENCODE_URL` 环境变量支持自定义地址。Server 启动 ownership 仍依赖外部（用户手动启动或集成到其他组件）。
7. ⬜ Codex：约定 + ACP，无 SDK 增强（Codex 无 SDK 支持）。
8. ✅ 模型探测接入 SDK：`profile_service::refresh_profile_models_via_sdk()` 以 `source=agent_sdk` 保存；`POST /agents/:id/model` 在切换后自动触发 SDK 模型刷新。
9. ✅ 嵌入策略落地：`embedded_scripts.rs` 使用 `include_str!` 嵌入 Node 脚本，运行时提取到 `/tmp/ergatai-embedded-scripts/`，开发期自动 fallback 到源码 `scripts/` 目录。Shutdown 时自动清理。

## 风险与缓解

- **Node 子进程开销**：缓存 + 手动刷新 + 并发去重。
- **SDK 版本耦合**：Adapter 层隔离，失败回退约定。
- **MCP 状态 stale**：短 TTL 缓存 + 运行时刷新 + `refresh=1`。
- **OpenCode server 依赖**：SDK 调用失败时回退约定/空结果；明确 server 启动 ownership。
- **生产路径**：`project_root()` 脆弱；需嵌入或固定安装目录。
- **plugins 归属**：前端扫描 vs 后端统一；若后端接管，需复刻 marketplace 扫描或保留前端作为插件专用通道。

## 模型探测与切换（SDK 增强）

### 问题
现有模型探测/切换依赖 ACP `set_session_model` 或 `/model` 斜杠命令，agent 支持不一致，输出解析脆弱。

### SDK 能力
| Agent | 探测 | 切换 |
|---|---|---|
| Claude | `supportedModels()` | `setModel()` |
| OpenCode | providers / config | `sessionSwitchModel()` |
| Codex | 无 | 仅启动时 `ThreadOptions.model` |

### 策略
1. **探测优先级**：SDK → 约定文件 → ACP config options → 空结果
2. **切换优先级**：SDK → ACP `set_session_model` → `/model` 斜杠命令
3. **Rust 保持数据源**：`agent_sdk_service::switch_model` 调用 Node helper，失败回退 ACP

### 文件
- `scripts/agent-sdk-model.mjs`：Node helper（已验证 Claude 切换成功）
- `crates/ergatai-api/src/services/agent_sdk_service.rs`：`switch_model()` 封装

## 历史消息渲染策略（可选增强，roadmap）

> 本节超出「辅助信息发现」核心范围，保留为后续独立课题。

- 用户开启「历史渲染」时，先直接读取 agent 原生文件做**临时视图**（不入库）。
- 后台静默执行迁移（读文件 → 入库），迁移完成后切换到数据库渲染。
- 迁移完成后清理临时视图，避免重复数据。

### 流程
1. 用户打开历史视图 → 前端请求 `/api/v1/agents/:id/history?mode=temp`
2. 后端按 agent 约定读取原生文件，返回临时消息列表。
3. 后台异步执行迁移（已有导入流程）。
4. 迁移完成 → 前端切换到 `/api/v1/agents/:id/history?mode=db`。
5. 可选：迁移完成后删除临时缓存。

### 优点
- 用户无需等待迁移完成即可看到历史。
- 迁移在后台静默进行，不阻塞 UI。
- 最终数据仍统一入库，保证元数据和性能。

## MCP 与 Skills 是否需要迁移到 SDK

### SDK 支持情况
| Agent | Skills | MCP | 说明 |
|---|---|---|---|
| Claude | ✅ `reloadSkills()` | ✅ `McpServerStatus` / `setMcpServers()` | SDK 可直接查询/配置 |
| OpenCode | ✅ `skills()` | ✅ `mcpStatus()` / `mcpAdd()` | HTTP SDK 提供 |
| Codex | ❌ | ⚠️ 仅 MCP tool call 事件 | 无管理 API |

### 策略
- **MCP 状态/配置**：SDK 优先（Claude/OpenCode），失败回退 Ergatai 自己的 MCP 注册表 + ACP。
- **Skills**：SDK 优先（Claude/OpenCode），失败回退约定目录扫描。
- **Codex**：继续用约定 + ACP + Ergatai MCP 注册表。

### 原则
SDK 是增强手段，不是唯一来源；Ergatai 自己的 MCP/Skills 注册表保留作为兜底和统一视图。

## 辅助信息来源矩阵（roadmap，非本期范围）

> 本矩阵包含文件变更/Todo/权限/用量/历史等超出发现端点的能力，作为后续能力规划参考，不作为本期交付。

| 辅助信息 | Claude | Codex | OpenCode | 优先级 |
|---|---|---|---|---|
| **Skills** | SDK ✅ | 约定 ⚠️ | SDK ✅ | SDK → 约定 |
| **Commands** | ACP ✅ + SDK ✅ | ACP ✅ | ACP ✅ + SDK ✅ | ACP → SDK |
| **MCP 状态** | SDK ✅ | ACP ⚠️ | SDK ✅ | SDK → ACP → 注册表 |
| **Models** | SDK ✅ | ACP ⚠️ | SDK ✅ | SDK → 约定 → ACP |
| **模型切换** | SDK ✅ | ❌（仅启动时） | SDK ✅ | SDK → ACP `/model` |
| **文件变更** | SDK ✅ | SDK ⚠️（ThreadItem） | SDK ⚠️ | SDK → Workaround（tool calls/git diff） |
| **Todo** | SDK ⚠️ | SDK ⚠️（TodoListItem） | SDK ⚠️ | SDK → Workaround（文本解析） |
| **权限/Hooks** | SDK ✅ | ACP ⚠️ | SDK ⚠️ | SDK → ACP elicitations |
| **用量/成本** | SDK ✅ | ACP ⚠️ | SDK ⚠️ | SDK → ACP usage |
| **会话历史** | ⚠️（读文件） | ⚠️（读 sqlite） | SDK ✅ | ACP + Ergatai SQLite → SDK |

### 图例
- **SDK ✅**：agent 专有 SDK 直接提供，最稳定。
- **ACP ✅/⚠️**：ACP 协议原生或部分支持。
- **约定 ⚠️**：约定目录/文件扫描，稳定兜底。
- **Workaround**：Ergatai 通过 tool calls/文本解析绕过获取，脆弱。

### 优先级链
```
SDK（Claude/OpenCode） → ACP 原生 → 约定文件 → Workaround 兜底
Codex: ACP 原生 → 约定文件 → Workaround 兜底（无 SDK）
```

## 一句话

**ACP 走对话，约定做兜底，SDK 做增强；统一挂载到 agent 发现端点，后端保持数据源，前端无感。模型探测/切换优先 SDK，失败回退 ACP。MCP/Skills 优先 SDK，失败回退 Ergatai 注册表。本期聚焦 skills/commands/mcp/plugins 四类发现，其余能力列入 roadmap。**
