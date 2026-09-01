# ACP 协议监控 API 文档

本文档详细说明 Ergatai 如何通过 ACP (Agent Client Protocol) 协议实现对 agent 的全面监控，为桌面版和 API 用户提供强大的可观察性能力。

## 概述

ACP 协议提供了比传统 PTY 更结构化的 agent 通信方式，使得 Ergatai 能够捕获和暴露以下监控数据：

- **Agent Thoughts** - agent 的思考过程（可选捕获）
- **Tool Calls** - agent 调用的工具及状态
- **Usage Statistics** - token 使用量统计
- **Structured Messages** - 结构化的消息流

## 启用思考捕获

在创建 workspace 时，可以通过 `capture_thoughts` 字段启用思考捕获：

```bash
# REST API 创建 workspace
curl -X POST http://localhost:3000/api/v1/workspaces \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-workspace",
    "work_dir": "/path/to/project",
    "env": {},
    "capture_thoughts": true
  }'
```

启用后，agent 的思考过程会被捕获到独立的缓冲区，可通过 API 查询。

## 监控 API 端点

### 1. 获取 Agent 思考

```http
GET /api/v1/agents/{agent_id}/thoughts
```

**响应示例**：
```json
{
  "agent_id": "ws1-agent-1",
  "thoughts": "[thinking] 我需要先分析代码结构...\n[thinking] 这个函数有性能问题..."
}
```

**说明**：
- 如果未启用 `capture_thoughts`，`thoughts` 字段为 `null`
- 思考内容以 `[thinking]` 前缀标记
- 缓冲区大小为 256 KiB，超出后会滚动删除旧内容

### 2. 获取 Agent 工具调用

```http
GET /api/v1/agents/{agent_id}/tool-calls
```

**响应示例**：
```json
{
  "agent_id": "ws1-agent-1",
  "tool_calls": [
    {
      "tool_name": "read_file",
      "status": "update",
      "timestamp": "5s ago"
    },
    {
      "tool_name": "execute_command",
      "status": "update",
      "timestamp": "12s ago"
    },
    {
      "tool_name": "write_file",
      "status": "update",
      "timestamp": "18s ago"
    }
  ]
}
```

**说明**：
- 返回最近 100 次工具调用
- 包含工具名称、状态和时间戳
- 时间戳显示相对于当前时间的秒数
- 用于追踪 agent 的工作流程和决策路径

### 3. 获取 Agent 使用量统计

```http
GET /api/v1/agents/{agent_id}/usage
```

**响应示例**：
```json
{
  "agent_id": "ws1-agent-1",
  "input_tokens": 125000,
  "output_tokens": 45000,
  "total_tokens": 170000
}
```

**说明**：
- 实时统计 agent 消耗的 token 数量
- 分别记录输入和输出 token
- 用于成本控制和资源优化
- 数据在 agent 生命周期内持续累积

## 桌面版集成示例

### React 前端组件示例

```typescript
interface AgentMonitoring {
  thoughts: string | null;
  toolCalls: ToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

function AgentMonitorPanel({ agentId }: { agentId: string }) {
  const [monitoring, setMonitoring] = useState<AgentMonitoring | null>(null);

  useEffect(() => {
    // 轮询监控数据（每 5 秒）
    const interval = setInterval(async () => {
      const [thoughtsRes, toolCallsRes, usageRes] = await Promise.all([
        fetch(`/api/v1/agents/${agentId}/thoughts`),
        fetch(`/api/v1/agents/${agentId}/tool-calls`),
        fetch(`/api/v1/agents/${agentId}/usage`),
      ]);

      setMonitoring({
        thoughts: (await thoughtsRes.json()).thoughts,
        toolCalls: (await toolCallsRes.json()).tool_calls,
        usage: await usageRes.json(),
      });
    }, 5000);

    return () => clearInterval(interval);
  }, [agentId]);

  if (!monitoring) return <div>Loading...</div>;

  return (
    <div className="agent-monitor">
      <section>
        <h3>思考过程</h3>
        <pre className="thoughts">{monitoring.thoughts || '未启用思考捕获'}</pre>
      </section>

      <section>
        <h3>工具调用历史</h3>
        <ul className="tool-calls">
          {monitoring.toolCalls.map((call, i) => (
            <li key={i}>
              <strong>{call.tool_name}</strong> - {call.timestamp}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Token 使用量</h3>
        <div className="usage-stats">
          <div>输入: {monitoring.usage.inputTokens.toLocaleString()}</div>
          <div>输出: {monitoring.usage.outputTokens.toLocaleString()}</div>
          <div>总计: {monitoring.usage.totalTokens.toLocaleString()}</div>
        </div>
      </section>
    </div>
  );
}
```

### 实时监控面板布局

```
┌─────────────────────────────────────────────────────────┐
│  Agent: ws1-agent-1                                     │
├─────────────────────────────────────────────────────────┤
│  思考过程                                    [启用/禁用] │
│  ┌───────────────────────────────────────────────────┐  │
│  │ [thinking] 分析代码结构...                        │  │
│  │ [thinking] 发现性能瓶颈在循环中...                │  │
│  │ [thinking] 需要优化算法复杂度...                  │  │
│  └───────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│  工具调用 (最近 100 次)                                 │
│  ┌───────────────────────────────────────────────────┐  │
│  │ 12:34:56  read_file       src/main.rs             │  │
│  │ 12:35:02  execute_command cargo build             │  │
│  │ 12:35:15  write_file      src/optimized.rs        │  │
│  │ 12:35:20  execute_command cargo test              │  │
│  └───────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│  Token 使用量                                           │
│  ┌───────────────────────────────────────────────────┐  │
│  │ 输入: 125,000 tokens  ████████████░░░░  73%      │  │
│  │ 输出: 45,000 tokens   █████░░░░░░░░░░░  27%      │  │
│  │ 总计: 170,000 tokens                              │  │
│  │ 预估成本: $0.51                                   │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## 高级用法

### 1. 成本追踪

结合使用量 API 和模型定价，可以计算 agent 的运行成本：

```python
import requests

def calculate_cost(agent_id, pricing):
    """
    pricing: {"input": 0.000003, "output": 0.000015}  # per token
    """
    resp = requests.get(f"http://localhost:3000/api/v1/agents/{agent_id}/usage")
    usage = resp.json()
    
    input_cost = usage["input_tokens"] * pricing["input"]
    output_cost = usage["output_tokens"] * pricing["output"]
    
    return {
        "input_cost": input_cost,
        "output_cost": output_cost,
        "total_cost": input_cost + output_cost
    }
```

### 2. 工作流分析

通过工具调用历史，可以分析 agent 的工作模式：

```python
def analyze_workflow(agent_id):
    resp = requests.get(f"http://localhost:3000/api/v1/agents/{agent_id}/tool-calls")
    tool_calls = resp.json()["tool_calls"]
    
    # 统计工具使用频率
    tool_counts = {}
    for call in tool_calls:
        tool_name = call["tool_name"]
        tool_counts[tool_name] = tool_counts.get(tool_name, 0) + 1
    
    # 识别工作模式
    patterns = {
        "read_heavy": tool_counts.get("read_file", 0) > 50,
        "test_driven": tool_counts.get("execute_command", 0) > 20,
        "refactoring": tool_counts.get("write_file", 0) > 30,
    }
    
    return {
        "tool_distribution": tool_counts,
        "patterns": patterns,
        "total_steps": len(tool_calls)
    }
```

### 3. 异常检测

监控 agent 的思考过程和工具调用，检测异常情况：

```python
def detect_anomalies(agent_id):
    thoughts = requests.get(f"http://localhost:3000/api/v1/agents/{agent_id}/thoughts").json()
    tool_calls = requests.get(f"http://localhost:3000/api/v1/agents/{agent_id}/tool-calls").json()
    
    anomalies = []
    
    # 检测重复错误
    if thoughts.get("thoughts"):
        error_count = thoughts["thoughts"].lower().count("error")
        if error_count > 10:
            anomalies.append(f"检测到 {error_count} 次错误提及")
    
    # 检测工具调用循环
    recent_tools = [c["tool_name"] for c in tool_calls["tool_calls"][-10:]]
    if len(set(recent_tools)) == 1 and len(recent_tools) > 5:
        anomalies.append("工具调用可能陷入循环")
    
    return anomalies
```

## SSE 实时流（未来增强）

计划添加 Server-Sent Events 支持，实现真正的实时推送：

```http
GET /api/v1/agents/{agent_id}/monitoring/stream
```

```typescript
const eventSource = new EventSource(`/api/v1/agents/${agentId}/monitoring/stream`);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  switch (data.type) {
    case 'thought':
      updateThoughts(data.content);
      break;
    case 'tool_call':
      addToolCall(data.tool_call);
      break;
    case 'usage_update':
      updateUsage(data.usage);
      break;
  }
};
```

## 技术实现细节

### 数据流

```
Agent (ACP)
  ↓ SessionUpdate::AgentThoughtChunk
AcpBackend (thoughts buffer)
  ↓ get_agent_thoughts()
REST API (/api/v1/agents/:id/thoughts)
  ↓ HTTP Response
Desktop UI / API Client

Agent (ACP)
  ↓ SessionUpdate::ToolCallUpdate
AcpBackend (ToolCallTracker)
  ↓ get_agent_tool_calls()
REST API (/api/v1/agents/:id/tool-calls)
  ↓ HTTP Response
Desktop UI / API Client

Agent (ACP)
  ↓ SessionUpdate::UsageUpdate
AcpBackend (UsageTracker)
  ↓ get_agent_usage()
REST API (/api/v1/agents/:id/usage)
  ↓ HTTP Response
Desktop UI / API Client
```

### 存储限制

- **Thoughts**: 256 KiB 滚动缓冲区
- **Tool Calls**: 最近 100 次调用
- **Usage**: agent 生命周期内累积（无上限）

### 线程安全

- Thoughts buffer: `RwLock<Vec<u8>>`
- ToolCallTracker: `RwLock<Vec<ToolCall>>`
- UsageTracker: `AtomicUsize` (无锁)

## 故障排除

### 问题：thoughts 返回 null

**原因**：workspace 创建时未启用 `capture_thoughts`

**解决**：重新创建 workspace 并设置 `capture_thoughts: true`

### 问题：tool_calls 为空

**原因**：agent 尚未调用任何工具

**解决**：等待 agent 执行任务，或检查 agent 是否正常运行

### 问题：usage 数据不更新

**原因**：agent 未产生 token 消耗（可能卡住）

**解决**：检查 agent 状态，必要时重启 agent

## 总结

通过 ACP 协议的全面集成，Ergatai 为桌面版和 API 用户提供了：

✅ **完全可观察性** - 捕获 agent 的思考、工具调用和 token 使用  
✅ **结构化数据** - 比 PTY 原始输出更易解析和展示  
✅ **实时监控** - REST API 支持轮询，未来支持 SSE 推送  
✅ **成本控制** - 精确的 token 使用量追踪  
✅ **工作流分析** - 工具调用历史揭示 agent 决策模式  
✅ **异常检测** - 及时发现问题 agent  

这些能力使得多 agent 协作不再是黑盒，用户可以完全理解、控制和优化 agent 的行为。
