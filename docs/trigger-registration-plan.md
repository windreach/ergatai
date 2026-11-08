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
- [ ] `agents-file-mention.tsx` 使用 `useDropdownShell`（该组件逻辑更复杂（818行，含子页面导航），暂保持独立）。
- [x] 移除 `DiscoveryTrigger` 接口中的 `allowSpaces` 字段（后端已简化 schema）。

> **注意**：trigger 检测（`walkTreeOnce` 中的 `@`/`/` 字符匹配）深度集成在 contenteditable
> 编辑器的树遍历逻辑中，完全动态化需要重构编辑器核心。当前阶段保持硬编码检测，
> 后端 triggers 仅作为数据源提供给 dropdown 渲染。

### Phase 4：清理 ✅ (部分)

- [x] 移除前端 `DiscoveryTrigger` 接口中的 `allowSpaces` 字段。
- [x] 后端 trigger schema 简化（`char`, `position`, `types` 三字段）。
- [x] 更新 `docs/agent-auxiliary-discovery-plan.md`，说明 trigger 由后端注册。
- [ ] 完全移除编辑器中的 trigger 硬编码检测（需编辑器核心重构，当前作为 fallback 保留）。

**注**：`agents-provider.ts`、`files-provider.ts`、`agents-mentions-editor.tsx` 中的硬编码 trigger 检测（`@`/`/` 字符匹配）深度集成在 contenteditable 编辑器的树遍历逻辑中（`walkTreeOnce` 函数）。完全动态化需要重构编辑器核心，风险较高。当前阶段保留硬编码检测作为 fallback，后端 trigger 配置作为数据源提供给 dropdown 渲染。

### Phase 5：验证

- [ ] 类型检查、lint、相关 tests 通过。
- [ ] 手动验证：
  - 有 agent 时：`/` 与 `@` 显示完整数据（Skills + Commands + MCP + Plugins）。
  - 无 agent 时：`/` 与 `@` 显示静态数据（Skills + Plugins）。
  - 不同 agent 能力下的分组渲染与插入。

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
- [ ] 编辑器按键检测完全动态化（需编辑器核心重构，当前仍保持硬编码检测作为 fallback）。
