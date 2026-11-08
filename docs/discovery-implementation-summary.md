# Agent 辅助信息发现实现总结

## 完成的工作

### 1. 后端 Discovery Service ✅
- **文件**: `crates/ergatai-api/src/services/discovery_service.rs`
- **功能**:
  - 统一发现端点 `/api/v1/agents/:id/discovery`
  - 并发请求去重（in-flight deduplication）
  - 分 TTL 缓存架构（当前使用 30s 统一 TTL）
  - 支持 skills、commands、MCP、plugins 四类数据
- **状态**: 已完成并编译通过

### 2. 前端 Discovery Router ✅
- **文件**: `frontend/src/main/lib/trpc/routers/discovery.ts`
- **功能**:
  - `getAgentDiscovery`: 获取 agent 的完整 discovery 信息
  - `getSkills`: 便捷方法获取 skills
  - `getCommands`: 便捷方法获取 commands
  - `getMcpStatus`: 便捷方法获取 MCP 状态
- **状态**: 已完成

### 3. SDK 修正 ✅
- **文件**: `scripts/agent-sdk-discover.mjs`
- **修正**:
  - Claude skills/commands 分离（skills 来自 `reloadSkills()`，commands 来自 `supportedCommands()`）
  - Claude 调用 `mcpServerStatus()` 获取 MCP 状态
  - 完整的 JSON schema 输出
- **状态**: 已完成

### 4. Slash Command Provider ✅
- **文件**: `frontend/src/renderer/features/mentions/providers/commands-provider.ts`
- **功能**:
  - 使用 `/` 触发字符
  - 调用 discovery 端点获取 commands
  - 支持 agent 特有的命令（通过 SDK）
  - 优先级 90（高于 skills 的 80）
- **状态**: 已完成

### 5. Skills Provider 更新 ✅
- **文件**: `frontend/src/renderer/features/mentions/providers/skills-provider.ts`
- **功能**:
  - 支持可选的 `agentId`
  - 使用 discovery 端点获取 agent 特有的 skills
  - 保持向后兼容（无 agentId 时使用约定扫描）
- **状态**: 已完成

### 6. 前端集成 ✅
- **文件**:
  - `frontend/src/renderer/features/mentions/types/search.ts`: 添加 `agentId` 到 `MentionSearchContext`
  - `frontend/src/renderer/features/mentions/hooks/use-mention-search.ts`: 支持 `agentId` 选项
  - `frontend/src/renderer/features/agents/mentions/agents-file-mention.tsx`: 使用 discovery 端点获取 skills
  - `frontend/src/renderer/features/agents/main/chat-input-area.tsx`: 传递 `agentId` 给 AgentsFileMention
- **功能**:
  - 当有 `agentId` 时，使用 discovery 端点获取 skills
  - 当没有 `agentId` 时，使用约定文件扫描
  - 30s 缓存，避免频繁请求
- **状态**: 已完成

## 数据流

```
用户输入 @ 或 /
  ↓
chat-input-area.tsx (有 agentId)
  ↓
AgentsFileMention (agentId prop)
  ↓
trpc.discovery.getAgentDiscovery.query({ agentId, cwd })
  ↓
后端 /api/v1/agents/:id/discovery
  ↓
discovery_service::discover()
  ↓
├─ 缓存检查（30s TTL）
├─ 并发去重（in-flight deduplication）
├─ skills_service::list_skills() (约定扫描)
├─ agent_sdk_service::discover() (SDK 调用)
├─ agent_service::get_agent_available_commands() (ACP)
└─ scan_plugins() (插件扫描)
  ↓
返回 { skills, commands, mcp, plugins }
```

## 缓存策略

| 数据类型 | TTL | 说明 |
|---------|-----|------|
| 统一结果 | 30s | 当前使用 |
| Skills | 5min | 预留，未来可扩展 |
| Commands | 1min | 预留 |
| MCP | 30s | 预留 |
| Plugins | 1h | 预留 |

## 错误处理

- SDK 调用失败：返回约定数据（优雅降级）
- Agent 不存在：返回空数组
- 缓存命中：直接返回，不阻塞
- 并发请求：复用进行中的探测结果

## 下一步可以做的

1. **Commands 集成**: 在 chat-input-area 中集成 slash command provider
2. **MCP Provider**: 创建显示 MCP 服务器状态的 mention provider
3. **错误处理规范**: 标准化错误响应 schema（当前返回空数组）
4. **性能监控**: 添加 discovery 成功率和延迟指标
5. **测试**: 编写单元测试和集成测试
6. **OpenCode 验证**: 测试 OpenCode SDK 连接和降级
7. **嵌入策略**: 确定 SDK 脚本的嵌入方式（include_str! vs 安装目录）

## 已知限制

1. **新 Chat 无 agentId**: 新创建的 chat 在绑定 agent 前无法使用 discovery
2. **缓存粒度**: 当前使用统一 30s TTL，未来可按数据类型细化
3. **并发限制**: 未限制同时 discovery 请求数量（依赖缓存去重）

## 测试建议

```bash
# 后端编译
cargo build -p ergatai-api

# 前端类型检查
cd frontend && npx tsc --noEmit

# 启动服务测试
cargo run -p ergatai-api -- --port 3000

# 在浏览器中：
# 1. 打开现有 chat（有 agent）
# 2. 输入 @ 查看 skills 是否来自 discovery
# 3. 检查网络请求 /api/v1/agents/:id/discovery
# 4. 验证缓存生效（30s 内不重复请求）
```

## 文件清单

### 新增文件
- `frontend/src/main/lib/trpc/routers/discovery.ts`
- `frontend/src/renderer/features/mentions/providers/commands-provider.ts`

### 修改文件
- `crates/ergatai-api/src/services/discovery_service.rs` (缓存层完善)
- `scripts/agent-sdk-discover.mjs` (SDK 修正)
- `frontend/src/renderer/features/mentions/types/core.ts` (添加 COMMAND 前缀)
- `frontend/src/renderer/features/mentions/types/search.ts` (添加 agentId)
- `frontend/src/renderer/features/mentions/hooks/use-mention-search.ts` (支持 agentId)
- `frontend/src/renderer/features/mentions/providers/skills-provider.ts` (使用 discovery)
- `frontend/src/renderer/features/mentions/providers/index.ts` (注册 commands)
- `frontend/src/renderer/features/mentions/index.ts` (导出新类型)
- `frontend/src/renderer/features/agents/mentions/agents-file-mention.tsx` (集成 discovery)
- `frontend/src/renderer/features/agents/main/chat-input-area.tsx` (传递 agentId)
