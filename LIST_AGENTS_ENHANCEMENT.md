# list_agents 增强：展示可用 Agent Profiles

## 修改内容

修改了 `crates/ergatai-api/src/mcp/tools/list_agents.rs`，使 `list_agents` MCP 工具同时返回：
1. **运行中的 agents** - 当前 workspace/chat 内可接收消息的 agent
2. **可用的 profiles** - ProfileRegistry 中注册的 agent 模板

## 新的响应格式

```json
{
  "agents": [
    {
      "agent_id": "ws1-agent-1",
      "workspace_id": "ws1",
      "state": "idle",
      "health": "healthy",
      "availability": "available",
      "can_receive_messages": true,
      ...
    }
  ],
  "profiles": [  // NEW
    {
      "profile_id": "uuid-xxx",
      "profile_name": "claude-code",
      "command": "npx @anthropic/claude-acp",
      "agent_type": "acp",
      "type": "profile",
      "status": "available",
      "can_receive_messages": false,
      ...
    },
    {
      "profile_id": "uuid-yyy",
      "profile_name": "opencode",
      "command": "opencode acp",
      "agent_type": "acp",
      "type": "profile",
      "status": "available",
      ...
    }
  ],
  "total": 1,           // 运行中的 agent 数量
  "total_profiles": 11, // NEW: 可用的 profile 数量
  "filter_applied": false,
  "note": "Agents: live agents in caller's workspace/chat scope (can receive messages if availability=available). Profiles: available agent templates that can be spawned via DAG orchestration or API."
}
```

## 解决的问题

### 之前
```
Agent 调用 list_agents
  ↓
只能看到 1 个运行中的 agent
  ↓
不知道有哪些 agent 可以启动
  ↓
无法动态创建新 agent ❌
```

### 现在
```
Agent 调用 list_agents
  ↓
看到 1 个运行中的 agent + 11 个可用 profiles
  ↓
知道可以启动 claude-code, opencode, gemini 等
  ↓
可以通过 DAG 编排或 API 启动新 agent ✅
```

## 使用场景

### 场景 1：Agent 需要协作
```
Agent A (claude-code): "我需要前端专家"
  ↓
调用 list_agents
  ↓
看到 profiles 中有 "react-expert" profile
  ↓
提交 DAG 工作流，引用 "react-expert" profile
  ↓
DAG 调度器自动启动 react-expert agent
  ↓
两个 agent 开始协作 ✅
```

### 场景 2：动态团队扩展
```python
# Agent 可以通过 submit_orchestration 提交 DAG
dag_yaml = """
tasks:
  - name: frontend-task
    agent: react-expert  # 引用 profile 名称
    task: "实现登录页面"
  - name: backend-task
    agent: api-developer  # 引用另一个 profile
    task: "实现认证 API"
"""

# DAG 调度器会根据 profiles 自动创建 agents
```

## 技术细节

### 隔离机制保持不变
- **运行中的 agents** 仍然按 workspace + chat 隔离
- **Profiles** 是全局的（所有 workspace 都能看到相同的 profiles）
- Agent 只能给**同 workspace/chat 的运行中 agent** 发消息
- Agent 可以基于**任何 profile** 创建新 agent（通过 DAG 或 API）

### 数据来源
- `agents`: 来自 `UnifiedAgentRegistry`（全局存储，查询时按 workspace/chat 过滤）
- `profiles`: 来自 `ProfileRegistry`（SQLite: `.ergatai/profile_registry.db`）

## 下一步

Agent 现在可以看到可用的 profiles，但还需要：
1. **DAG 调度器支持从 profile 创建 agent** - 当 DAG 引用不存在的 agent 时，自动从 profile 创建
2. **或者暴露 spawn_agent API** - 让 agent 可以直接调用 API 启动新 agent

当前实现让 agent **知道**有哪些可用的 agent 模板，这是动态多 agent 协作的第一步。
