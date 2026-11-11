# Trigger Registration & Frontend Abstraction Plan

## 目标

1. 后端成为 `/`、`@` 等特殊符号的唯一注册源（trigger chars、位置规则、可拉取类型）。
2. 前端不再硬编码 trigger 检测与 item-type 映射，统一通过后端注册表读取 + 调用抽象。
3. `/` 与 `@` 共用同一套数据加载与分组渲染逻辑，仅插入语义不同。
4. **静态源（Skills/Plugins）与运行时源（Commands/MCP）彻底解耦，无 agent 场景可用静态源。**

## 当前状态

- 后端 `discovery` 已返回 `triggers`（`/`、`@`）及其 `types`。
- 前端 `useDiscoveryGroups` 已统一拉取并按后端 `group` 分组。
- `/` 与 `@` 仍各自硬编码 trigger 检测（行首 `/`、standalone `@`）。
- item-type → mention token 的映射仍散落在前端。
- **缓存 key 包含 agent_id，静态源无法跨 agent 复用**。

---

## 阶段计划

### Phase 1：后端 trigger 契约稳定化 + 缓存解耦

#### 1.1 Trigger Schema 简化 ✅
- [x] 定义精简 trigger schema：`char`, `position`, `types`（移除 `allowSpaces`/`maxLength`，当前不需要）。
- [x] 将 `triggers` 从 discovery 内联回到独立端点 `/api/v1/triggers?agentId=xxx&cwd=xxx`，便于缓存与版本化。
- [x] 后端根据 agent 能力动态裁剪 `types`（无 agent 时只返回 skill/plugin）。

#### 1.2 缓存 key 重构 ✅
- [x] 静态源 cache_key 只用 `cwd`，不含 `agent_id`：
  ```rust
  // 当前：`convention_skills::{agent_id}::{cwd}`
  // 改为：`convention_skills::{cwd}`
  ```
- [x] 运行时源 cache_key 保持 `{source}::{agent_id}::{cwd}`。

#### 1.3 静态源独立端点 ✅
- [x] 新增 `/api/v1/discovery/static?cwd=xxx` 端点：
  - 只返回 `convention_skills` + `plugins`。
  - 不依赖 agentId，新建对话可用。
  - 缓存 key 只用 `cwd`。
- [x] 响应格式与现有 discovery 兼容：
  ```json
  {
    "skills": [...],
    "plugins": [...],
    "triggers": [...]
  }
  ```

### Phase 2：前端 trigger 注册表 + 降级方案

#### 2.1 前端降级（优先实现）✅
- [x] 新增 `getStaticDiscovery` tRPC 过程：
  - 无 agentId 时调用 `/api/v1/discovery/static`。
  - 返回 `{ skills, plugins, triggers }`。
- [x] `useDiscoveryGroups` 改造：
  ```typescript
  // 有 agentId → 调完整 discovery
  // 无 agentId → 调 static discovery（降级）
  ```
- [x] `agents-slash-command.tsx` / `agents-file-mention.tsx`：
  - 无 agentId 时至少渲染静态 Skills/Plugins 组。（通过 `useDiscoveryGroups` 降级自动生效）

#### 2.2 Trigger 注册表 ✅
- [x] 新增 `useRegisteredTriggers(agentId, cwd)`，从后端读取 trigger 列表。
- [x] 前端维护 trigger → handler 的注册表，不再硬编码 `/` / `@`（hook 提供 `isTriggerChar`/`getTriggerTypes`/`getTriggerPosition`）。
- [x] trigger 检测逻辑从 `agentId`/`cwd` 上下文动态生成配置（`useRegisteredTriggers` 缓存 5 分钟）。

### Phase 3：统一渲染与插入 ✅ (部分)

- [x] `/` 与 `@` 共用 `useDiscoveryGroups` hook 获取数据（数据流统一）。
- [x] 插入语义按 item `type` 分发（slash command 用 `/name`，mention 用 `@[type:name]`）。
- [x] 提取 `useDropdownShell` 通用 hook（位置计算、键盘导航、自动滚动、点击外部、搜索防抖）。
- [x] `agents-slash-command.tsx` 使用 `useDropdownShell`，从 ~380 行缩减到 ~230 行。
- [x] `agents-file-mention.tsx` 使用 `useDropdownShell`，从 ~818 行缩减到 ~657 行（减少 161 行）。
- [x] `useDropdownShell` 支持 `debounceMs: 0` 跳过内部 debounce（避免 double debounce）。
- [x] 移除 `DiscoveryTrigger` 接口中的 `allowSpaces` 字段（后端已简化 schema）。（当前 `DiscoveryTrigger` 仅含 `char`/`position`/`types`）
> **注意**：trigger 检测（`walkTreeOnce` 中的 `@`/`/` 字符匹配）深度集成在 contenteditable
> 编辑器的树遍历逻辑中，完全动态化需要重构编辑器核心。当前阶段保持硬编码检测，
> 后端 triggers 仅作为数据源提供给 dropdown 渲染。

### Phase 4：清理 ✅ (部分)

- [x] 移除前端 `DiscoveryTrigger` 接口中的 `allowSpaces` 字段。
- [x] 后端 trigger schema 简化（`char`, `position`, `types` 三字段）。
- [x] 更新 `docs/agent-auxiliary-discovery-plan.md`，说明 trigger 由后端注册。
- [x] 编辑器 trigger 检测动态化 — `walkTreeOnce` 接收 `EditorTriggerConfig` 参数，支持自定义 trigger 字符和位置规则。
- [x] 新增 `EditorTriggerConfig` 类型，导出自 `mentions/index.ts`。
- [x] `AgentsMentionsEditorProps` 新增 `mentionTrigger` 和 `slashTrigger` 可选 props。
- [x] `chat-input-area.tsx` 和 `new-chat-form.tsx` 使用 `useRegisteredTriggers` 获取配置并传递给编辑器。
- [x] 默认 fallback：无配置时使用 `@`（standalone）和 `/`（start-of-line）。

> **注**：trigger 检测现在从后端注册表动态获取配置。如果后端未返回配置或 agent 未连接，
> fallback 到硬编码的 `@` 和 `/`。这保证了向后兼容性和无 agent 场景的基本功能。

### Phase 5：验证

- [x] 类型检查通过（`tsc --noEmit`：改动文件无新增错误；既有错误均为缺失第三方模块的环境问题）。
- [x] lint 通过（使用 oxlint 对改动文件检查：无 error；剩余 warning 均为既有代码，与本次改动无关）。
- [x] 相关 tests 通过（后端 `discovery_service` 9/9；前端 `native-triggers` 5/5）。
- [ ] 手动验证：
  - 有 agent 时：`/` 与 `@` 显示完整数据（Skills + Commands + MCP + Plugins）。
  - 无 agent 时：`/` 与 `@` 显示静态数据（Skills + Plugins）。
  - 不同 agent 能力下的分组渲染与插入。

---

## Phase 6：Agent 级 Discovery Trigger 扩展（设计）

> **状态**：实现完成（后端数据层 + 前端 N-trigger 检测 + 插入/序列化参数化 + 编辑器状态统一已完成；clearSlashCommand 已按 index 工作；手动验证待执行）。目标：让 agent 能注册 `/`、`@` 之外的 discovery trigger 符号，并按 agent 能力/配置动态生效。

### 6.1 目标

1. 后端 trigger 注册表从「固定 `/`、`@`」扩展为「默认 `/`、`@` + agent 自定义 trigger」。
2. agent 可通过 profile/注册表声明自己的 discovery trigger（char、位置规则、可拉取类型、UI 种类）。
3. 前端编辑器检测支持 N 个 trigger，不再硬编码 `@`/`/` 两个具名变量。
4. 插入语义按 trigger `kind` 分发（slash 风格 vs mention 风格），并使用 trigger 自身的 char。

### 6.2 后端 Schema 扩展

#### 6.2.1 Agent Profile 新增字段

在 `agent_registrations` 表新增列（类似 `native_triggers_json`）：

```sql
ALTER TABLE agent_registrations ADD COLUMN discovery_triggers_json TEXT;
```

JSON 结构：

```json
[
  {
    "char": "$",
    "position": "start-of-line",
    "types": ["command"],
    "kind": "slash"
  },
  {
    "char": "#",
    "position": "standalone",
    "types": ["file", "folder"],
    "kind": "mention"
  }
]
```

字段说明：
- `char`：单字符 trigger。
- `position`：`start-of-line` / `standalone` / `anywhere`。
- `types`：该 trigger 可拉取的 discovery 类型（skill/command/mcp/plugin/agent/file/folder）。
- `kind`：UI/插入语义分类：
  - `slash`：类似 `/`，打开命令风格 dropdown，插入 `{char}{name} `。
  - `mention`：类似 `@`，打开 mention 风格 dropdown，插入 `{char}[{type}:{name}]`。

#### 6.2.2 Trigger 合并逻辑

```rust
pub fn get_triggers(agent_id: Option<&str>, cwd: Option<&str>) -> Value {
    // 1. 默认 triggers
    let mut triggers = vec![
        Trigger { char: "/", position: "start-of-line", types: [...], kind: "slash" },
        Trigger { char: "@", position: "standalone", types: [...], kind: "mention" },
    ];

    // 2. agent 自定义 triggers（如果 agent_id 存在且 profile 有 discovery_triggers_json）
    if let Some(agent) = lookup_agent(agent_id) {
        if let Some(custom) = parse_discovery_triggers(agent.discovery_triggers_json) {
            triggers.extend(custom);
        }
    }

    // 3. 无 agent 时：仅返回静态 types（skill/plugin）的默认 triggers
    if agent_id.is_none() {
        triggers = triggers.into_iter().map(|t| t.with_static_types()).collect();
    }

    json!(triggers)
}
```

注意：
- 无 agent 场景（New Chat）不读取 agent profile，只返回默认 `/`、`@` 的静态类型。
- 自定义 trigger 的 char 必须是单字符，且与 native trigger 体系隔离（discovery trigger 只负责 discovery dropdown，不负责 native trigger hint）。
- 默认 char（`/`、`@`）不可被自定义覆盖，避免破坏基础能力。

### 6.3 前端通用化

#### 6.3.1 EditorTriggerConfig 扩展

```typescript
export interface EditorTriggerConfig {
  char: string
  position: "standalone" | "start-of-line" | "anywhere"
  types?: string[]
  kind: "slash" | "mention"
}
```

#### 6.3.2 walkTreeOnce 通用化

当前签名：

```typescript
walkTreeOnce(root, range, nativeTriggers, mentionTrigger, slashTrigger)
```

改为：

```typescript
walkTreeOnce(root, range, nativeTriggers, discoveryTriggers: EditorTriggerConfig[])
```

内部逻辑：
- 遍历所有 discoveryTriggers，检测每个 char 的位置规则。
- 选择「最靠近光标且合法」的 trigger 作为 active trigger。
- 返回 `{ activeTrigger: EditorTriggerConfig | null, triggerIndex, textAfterTrigger, ... }`。

#### 6.3.3 编辑器状态通用化

将当前的两个独立状态：

```typescript
const triggerStartIndex = useRef<number | null>(null)        // mention
const slashTriggerActive = useRef(false)
const slashTriggerStartIndex = useRef<number | null>(null)  // slash
```

重构为：

```typescript
const activeDiscoveryTrigger = useRef<{
  config: EditorTriggerConfig
  startIndex: number
} | null>(null)
```

插入时根据 `config.kind` 和 `config.char` 决定：
- `slash`：`clearDiscoveryTrigger()` + `setValue(`${char}${name} `)`
- `mention`：`insertDiscoveryTrigger(option)`，使用 `char` 替代硬编码 `@`

#### 6.3.4 useEditorTriggerConfigs 调整

```typescript
export function useEditorTriggerConfigs(agentId, cwd) {
  const { triggers } = useRegisteredTriggers(agentId, cwd)
  return triggers.map(t => ({
    char: t.char,
    position: t.position ?? "anywhere",
    types: t.types,
    kind: t.kind ?? (t.char === "/" ? "slash" : "mention"),
  }))
}
```

#### 6.3.5 Dropdown 映射

- `kind === "slash"` → 使用 `AgentsSlashCommand` 组件（或通用化为 `AgentsDiscoveryDropdown` with `insertStyle="slash"`）。
- `kind === "mention"` → 使用 `AgentsFileMention` 组件。

建议后续将两个 dropdown 组件合并为一个通用 `AgentsDiscoveryDropdown`，通过 `insertStyle` prop 控制插入语义，减少重复。当前阶段可保留两个组件，由 editor 根据 `activeTrigger.kind` 决定调用 `onSlashTrigger` 还是 `onTrigger`。

### 6.4 迁移与兼容

- 旧 agent（无 `discovery_triggers_json`）：后端返回默认 `/`、`@`，行为与当前完全一致。
- 前端：`EditorTriggerConfig.kind` 缺失时 fallback：`/` → slash，其余 → mention。
- `walkTreeOnce` 默认参数：空数组时 fallback 到 `/` 与 `@`，保证无配置场景可用。

### 6.5 风险

| 风险 | 缓解措施 |
|------|----------|
| agent 注册了与默认冲突的 char | 后端拒绝覆盖默认 `/`、`@` |
| 多个 trigger 同时匹配 | 选择最靠近光标的；若等距，按注册顺序优先 |
| 插入语义分发遗漏新 kind | 默认 fallback 到 mention 风格，日志告警 |
| agent profile 字段迁移 | DB migration + 默认 NULL，向后兼容 |

### 6.6 建议实施顺序

1. **6.2** 后端 DB migration + profile 字段 + `get_triggers` 合并逻辑（1 天）
2. **6.3.1-6.3.2** 前端 `EditorTriggerConfig` 扩展 + `walkTreeOnce` 通用化（1 天）
3. **6.3.3-6.3.4** 编辑器状态重构 + `useEditorTriggerConfigs` 调整（1 天）
4. **6.3.5** Dropdown 映射 + 插入语义参数化（0.5 天）
5. **Phase 5 验证**：类型检查、lint、单测、手动验证（0.5 天）

**每阶段独立提交，便于回滚。**

---

## 已知 Bug：New Chat / 无 agent 场景下 @ 与 / 失效

> **Bug 标注**：新建对话没有 agentId，前端 discovery 查询被禁用，导致 `@` 与 `/` 完全无数据，即使约定文档扫描可用。

### 代码证据

| 文件 | 行号 | 问题 |
|------|------|------|
| `use-discovery-groups.ts` | 40 | `enabled: !!agentId` — 无 agentId 时查询被禁用 |
| `agents-slash-command.tsx` | 73-76 | agentId 来自 binding，新对话没有 |
| `agents-file-mention.tsx` | 202 | 同样依赖 props 传入的 agentId |

### 修复方案（Phase 2.1）

**前端降级**：无 agentId 时调用 `/api/v1/discovery/static?cwd=xxx`，至少渲染静态 Skills/Plugins 组。

```typescript
// use-discovery-groups.ts 改造
export function useDiscoveryGroups(agentId: string | undefined, cwd?: string) {
  // 有 agentId → 完整 discovery
  const fullQuery = trpc.discovery.getAgentDiscovery.useQuery(
    { agentId: agentId ?? "", cwd },
    { enabled: !!agentId, ... }
  )
  
  // 无 agentId → 静态 discovery（降级）
  const staticQuery = trpc.discovery.getStaticDiscovery.useQuery(
    { cwd },
    { enabled: !agentId, ... }
  )
  
  const data = agentId ? fullQuery.data : staticQuery.data
  // ... 后续处理不变
}
```

---

## 已知 Bug：缓存与运行时耦合

> **Bug 标注**：当前 discovery 缓存未与 agent 运行时解耦，静态源无法跨 agent 复用。

### 代码证据

| Source | 依赖 | Cache Key |
|--------|------|-----------|
| `convention_skills` | 纯文件系统扫描 | `{agent_id}::{cwd}` ❌ |
| `plugins` | 纯文件系统扫描 | `{agent_id}::{cwd}` ❌ |
| `acp_commands` | ACP 运行时 | `{agent_id}::{cwd}` ✅ |
| `sdk_bundle` | SDK 子进程 | `{agent_id}::{cwd}` ✅ |

**问题**：静态源 cache_key 包含 agent_id，导致：
- 不同 agent 的相同 cwd 会重复缓存静态源。
- 无 agent 时无法利用静态源缓存。

### 修复方案（Phase 1.2）

重构 cache_key 生成逻辑：

```rust
fn cache_key(source: &str, agent_id: &str, cwd: Option<&str>) -> String {
    let cwd_str = cwd.unwrap_or("");
    match source {
        // 静态源只用 cwd
        SRC_CONVENTION_SKILLS | SRC_PLUGINS => {
            format!("{}::{}", source, cwd_str)
        }
        // 运行时源包含 agent_id
        _ => format!("{}::{}::{}", source, agent_id, cwd_str),
    }
}
```

---

## 静态层缺口（未运行 agent 时的信息边界）

> 静态扫描只能稳定提供部分信息，以下类型仍无静态等价：

| 类型 | 静态源 | 运行时源 |
|------|--------|----------|
| Skills | ✅ Convention files 扫描 | ✅ SDK reloadPlugins |
| Plugins | ✅ Marketplace 目录扫描 | ✅ SDK reloadPlugins |
| Commands | ❌ 无 | ✅ ACP availableCommands |
| MCP | ❌ 无 | ✅ SDK listMcp |
| Models | ❌ 无 | ✅ SDK listModels |

**结论**：无 agent 时，静态层最多提供 **Skills + Plugins**；Commands/MCP/Models 仍需 agent 在线。

---

## 风险

| 风险 | 缓解措施 |
|------|----------|
| 编辑器按键检测改造影响输入体验 | 保留硬编码 fallback，开关控制新旧逻辑 |
| trigger 动态化增加网络请求 | 前端缓存 triggers 端点（5min TTL） |
| 插入语义分发遗漏未知类型 | 默认 fallback 到 `@[unknown:type]`，日志告警 |
| 静态源端点增加后端负载 | 缓存 5min TTL + 前端 stale-while-revalidate |

---

## 建议顺序

1. **Phase 1**：后端 trigger 契约 + 缓存解耦 + 静态端点（1-2 天）
2. **Phase 2**：前端降级 + trigger 注册表（1-2 天）
3. **Phase 3**：统一渲染与插入（1 天）
4. **Phase 4-5**：清理与验证（0.5 天）

**每阶段独立提交，便于回滚。**

---

## 成功标准

- [x] 新建对话（无 agentId）可使用 `/` 和 `@` 看到 Skills/Plugins。（Phase 2.1 降级实现）
- [x] 有 agent 的对话可使用完整功能（Skills/Commands/MCP/Plugins）。
- [x] 静态源缓存跨 agent 复用，减少重复扫描。（Phase 1.2 cache_key 重构）
- [x] 前端 trigger 配置从后端注册表读取（`useRegisteredTriggers` hook）。（Phase 2.2 完成）
- [x] 编辑器 trigger 检测动态化 — `walkTreeOnce` 使用后端配置，fallback 到 `@`/`/`。（Phase 4 完成）
