# Mention Group Unification & Hardcoded Trigger Cleanup Plan

## 目标

1. 类别字段统一为 `group`（后端输出、前端消费、持久化/缓存一致）。
2. 前端只保留 `@agents` 与文件识别（`@file` / `@folder`）相关设施。
3. 移除过期的前端关键词触发与硬编码类别设施（skills / commands / tools(MCP) mention providers 等）。
4. 后端成为类别/group 的唯一真相源，前端不再硬编码 provider category。

## 范围

### 保留
- `frontend/src/renderer/features/mentions/providers/files-provider.ts`
- `frontend/src/renderer/features/mentions/providers/agents-provider.ts`
- `@` / 文件识别相关序列化与反序列化：`mentions-utils.ts` 中 `file:` / `folder:` / `agent:`

### 逐步移除 / 迁移
- `skills-provider.ts`
- `commands-provider.ts`
- `tools-provider.ts`
- `builtInProviders` 中对应注册
- 前端 mention `category` 硬编码（Files & Folders / Agents 除外可保留为 fallback）
- 后端 `category` 与 `group` 混用逻辑

## 字段统一约定

- 后端 discovery 输出统一使用 `group` 作为类别字段。
- 前端 `MentionItem` / provider data 统一使用 `group`，不再使用 `category` 作为 item 级类别。
- `MentionProvider.category`（UI 分组壳）重命名为 `group` 或保留为 `uiGroup`，避免与 item group 混淆。
- `MENTION_PREFIXES` 两处定义合并为单一来源。

## 阶段计划

### Phase 0：基线与保护
- [ ] 为 mention 序列化/反序列化、discovery merge、provider registry 建立/补充测试。
- [ ] 记录当前 `@` / `/` 触发路径与调用点。
- [ ] 确认 `@agents` 与文件识别的调用方（chat input、quick comment、queue processor 等）。

### Phase 1：后端 group 权威化
- [ ] `discovery_service::merge_sources` 统一输出 `group`，移除 `category` 混用。
- [ ] plugins 的 `category` 富化改为写入 `group` 或保留 `category` 仅作为插件元数据，不作为 UI 类别。
- [ ] MCP registry fallback 统一写 `group: "MCP"`。
- [ ] tRPC discovery 返回结构文档化为 `{ skills, commands, mcp, plugins, errors }`，每项含 `group`。
- [ ] 后端测试覆盖：缺 group 默认值、plugin category 富化、dedup。

### Phase 2：前端消费后端 group
- [ ] `SkillData` / `CommandData` / `ToolData` 的 `group?` 改为必填或以后端值为准。
- [ ] provider search 结果按后端 `group` 分组，而不是 provider 硬编码 category。
- [ ] `registry.getCategories()` 从后端/配置派生，或降级为 provider fallback。

### Phase 3：移除过期 mention providers
- [ ] 移除 `skills-provider.ts`、`commands-provider.ts`、`tools-provider.ts`。
- [ ] 从 `providers/index.ts` 与 `mentions/index.ts` 移除导出与注册。
- [ ] 更新 `builtInProviders`，仅保留 `filesProvider`、`agentsProvider`。
- [ ] 删除对应缓存与类型导出。
- [ ] 更新调用方：不再调用 `trpcClient.discovery.getSkills/getCommands/getMcpStatus` 的 mention 路径；如仍需数据，改为非 mention 用途或删除。

### Phase 4：清理 native trigger / 硬编码设施
- [ ] 审计 `native-triggers.ts` 与 agent profile triggers，移除过期 trigger 定义。
- [ ] 移除前端 `/` slash command mention 入口（若仅用于 commands provider）。
- [ ] 清理 `MENTION_PREFIXES` 重复定义，合并为单一模块。

### Phase 5：清理过期产物
- [ ] 删除未引用的 tests / mocks / docs 中过期描述。
- [ ] 更新 `docs/agent-auxiliary-discovery-plan.md`，说明 skills/commands/mcp 不再作为 frontend mention provider。
- [ ] 清理 tRPC discovery 仅保留仍被使用的接口。

### Phase 6：验证
- [ ] `@agents` 与文件识别功能回归。
- [ ] discovery 后端接口仍可用（供非 mention 或调试用途）。
- [ ] 类型检查、lint、相关 tests 通过。

## 风险

- 移除 skills/commands/tools providers 可能影响聊天输入体验；需确认这些信息是否仍通过其他 UI 展示。
- `MENTION_PREFIXES` 两处定义合并时需兼容历史消息反序列化。
- 后端 group 改动可能影响插件 category 展示。

## 建议执行顺序

1. 先做 Phase 1（后端 group 权威化），不破坏前端。
2. 再做 Phase 2（前端消费 group）。
3. 最后做 Phase 3-5（移除过期 providers 与清理）。
4. 每阶段独立提交，便于回滚。
