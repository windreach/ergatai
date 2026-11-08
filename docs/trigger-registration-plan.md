# Trigger Registration & Frontend Abstraction Plan

## 目标

1. 后端成为 `/`、`@` 等特殊符号的唯一注册源（trigger chars、位置规则、可拉取类型）。
2. 前端不再硬编码 trigger 检测与 item-type 映射，统一通过后端注册表读取 + 调用抽象。
3. `/` 与 `@` 共用同一套数据加载与分组渲染逻辑，仅插入语义不同。

## 当前状态

- 后端 `discovery` 已返回 `triggers`（`/`、`@`）及其 `types`。
- 前端 `useDiscoveryGroups` 已统一拉取并按后端 `group` 分组。
- `/` 与 `@` 仍各自硬编码 trigger 检测（行首 `/`、standalone `@`）。
- item-type → mention token 的映射仍散落在前端。

## 阶段计划

### Phase 1：后端 trigger 契约稳定化
- [ ] 将 `triggers` 从 discovery 内联回到独立端点或 profile 配置，便于缓存与版本化。
- [ ] 定义 trigger schema：`char`, `position`, `allowSpaces`, `maxLength`, `types`。
- [ ] 后端根据 agent 能力动态裁剪 `types`（例如无 MCP 时移除 `mcp`）。

### Phase 2：前端 trigger 注册表
- [ ] 新增 `useRegisteredTriggers(agentId, cwd)`，从后端读取 trigger 列表。
- [ ] 前端维护 trigger → handler 的注册表，不再硬编码 `/` / `@`。
- [ ] trigger 检测逻辑从 `agentId`/`cwd` 上下文动态生成 regex。

### Phase 3：统一渲染与插入
- [ ] `/` 与 `@` 共用一个通用 dropdown 组件，只接收 `groups` + `onSelect`。
- [ ] 插入语义按 item `type` 分发：`command/skill` → `/name` 或 `@[skill:name]`，`mcp` → `@[tool:name]` 等。
- [ ] 移除 `agents-slash-command.tsx` / `agents-file-mention.tsx` 中的类型硬编码。

### Phase 4：清理
- [ ] 删除前端遗留的 trigger 字符串常量与类型白名单。
- [ ] 更新 `docs/agent-auxiliary-discovery-plan.md`，说明 trigger 由后端注册。

### Phase 5：验证
- [ ] 类型检查、lint、相关 tests 通过。
- [ ] 手动验证 `/` 与 `@` 在不同 agent 能力下的分组渲染与插入。

## 已知 Bug：New Chat / 无 agent 场景下 @ 与 / 失效

> **Bug 标注**：新建对话没有 agentId，前端 discovery 查询被禁用，导致 `@` 与 `/` 完全无数据，即使约定文档扫描可用。

- `agents-file-mention.tsx` 与 `agents-slash-command.tsx` 的 discovery 查询条件为 `enabled: !!agentId`。
- 新建对话尚未绑定 agent，因此不会触发 discovery，`/` 与 `@` 为空。
- 约定文档扫描（convention skills）与 marketplace plugins 不依赖 agent 运行时，理论上应可独立展示。

### 可能方案
- **预热缓存**：后台启动时对常见 cwd 预跑 convention skills / plugins 扫描，写入独立缓存。
- **无 agent 发现模式**：允许 discovery 在无 agentId 时仅返回静态源（skills/plugins），commands/mcp/plugins-runtime 为空或按 profile 类型推断。
- **profile 级发现**：新建对话先选定 profile/agent type，用类型而非实例 id 调 discovery，避免强依赖 agent 运行时。
- **前端降级**：无 agentId 时直接调用 `/api/v1/skills` 与 plugins 接口，至少渲染静态 Skills/Plugins 组。

## 静态层缺口（未运行 agent 时的信息边界）

> 静态扫描只能稳定提供部分信息，以下类型仍无静态等价：

- **Commands**：无静态扫描，完全依赖 ACP/SDK 运行时。
- **MCP**：仅 Ergatai 注册表 fallback，无运行时真实状态。
- **Models**：无静态扫描，依赖 SDK/ACP。
- **Plugins**：仅扫描 marketplace `skills` 目录，不覆盖插件 commands/hooks 等。

因此“未运行 agent 也有信息”时，静态层最多稳定提供 **Skills + Plugins（部分）**；Commands/MCP/Models 仍需 agent 在线或按 profile 推断。

## 已知 Bug：缓存与运行时耦合

> **Bug 标注**：当前 discovery 缓存未与 agent 运行时解耦，导致 agent 未运行时无法稳定返回 commands/mcp/models，必须 agent 在线才能拿到完整数据。

- `commands` / `mcp` / `models` 依赖 ACP session + SDK 子进程，agent 未运行时返回空或降级到 last-known-good。
- 静态源（convention skills / marketplace plugins）与运行时源未彻底分层，缓存粒度仍以 source 为单位，但运行时源的空结果会污染缓存。
- SDK 为附着式增强，不会启动 agent，也不会替代 ACP；agent 未运行时 SDK 数据自然缺失。
- 目标：静态源可独立缓存与渲染；运行时源异步补全，不阻塞静态层展示。

## 风险

- 编辑器按键检测改造可能影响输入体验，需要保留回退。
- trigger 动态化会增加一次网络请求，需缓存。
- 插入语义分发需覆盖所有 item type，避免未知类型无法插入。

## 建议顺序

1. 先稳定后端 trigger 契约（Phase 1）。
2. 再做前端注册表（Phase 2）。
3. 最后统一渲染与清理（Phase 3-4）。
4. 每阶段独立提交，便于回滚。
