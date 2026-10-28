# Agent 消息渲染规则

本文档定义了 Ergatai 中 agent-to-agent 消息的渲染规则。这些规则适用于**除群聊会话以外的所有会话类型**（主聊天、侧边聊天等）。

## 概述

在多 agent 协作场景中，消息分为三类：
1. **Agent 发送的请求消息** - Agent 调用 MCP 工具发送给其他 agent 的消息
2. **宿主 Agent 的回复** - 当前会话的主 agent 处理消息后的响应
3. **其他 Agent 的回复** - 被请求的 agent 返回的响应

每种类型的消息有不同的渲染方式，以保持界面的清晰性和信息的完整性。

---

## 规则 1: Agent 发送的请求消息

### 定义
Agent 通过调用 `send_message` MCP 工具发送给其他 agent 的消息。

### 渲染样式
- **气泡样式**：Agent 气泡（类似用户消息，但显示 agent 身份）
- **身份标识**：显示 agent 的 logo + 名称
- **内容渲染**：**只渲染文本内容**
- **不渲染**：工具调用、思考步骤

### 视觉效果
```
┌─────────────────────────────────┐
│ 🤖 Agent A                      │  ← Logo + 名称
├─────────────────────────────────┤
│ 请帮我检查这个文件的 bug...       │  ← 只渲染文本
└─────────────────────────────────┘
```

### 技术实现
- 消息角色：`role: "agent"` 或 `metadata.source: "agent"` + `metadata.messageType: "request"`
- 渲染组件：简化的文本气泡组件
- 位置：在消息流中作为独立的 initiator 消息

###  rationale
- Agent 发送的请求是"指令"，不需要展示执行过程
- 保持界面简洁，避免信息过载
- 用户可以清楚看到是哪个 agent 发起了请求

---

## 规则 2: 宿主 Agent 的回复

### 定义
当前会话的主 agent（宿主 agent）处理消息后生成的响应。

### 渲染样式
- **气泡样式**：Assistant 气泡
- **内容渲染**：**完整渲染所有内容**
  - ✅ 思考步骤 (Thinking/Reasoning)
  - ✅ 工具调用 (Tool calls) - 带状态指示
  - ✅ 文本输出 (Text content)
- **交互功能**：支持折叠/展开工具调用、复制代码等

### 视觉效果
```
┌─────────────────────────────────┐
│ 💭 Thinking                     │  ← 思考步骤
│ 让我分析一下这个问题...           │
├─────────────────────────────────┤
│ 🔧 Bash: ✓                      │  ← 工具调用（带状态）
│    $ cat file.ts                │
│ 🔧 Edit: ✓                      │
│    Modified: src/utils.ts       │
├─────────────────────────────────┤
│ 我已经修复了这个 bug...           │  ← 文本输出
└─────────────────────────────────┘
```

### 技术实现
- 消息角色：`role: "assistant"`
- 输出归属：`metadata.senderAgentId` / `metadata.senderAgentName`；普通 agent turn 使用 `metadata.messageType: "agent_output"`
- 渲染组件：`AssistantMessageItem` 或同等完整渲染组件
- 位置：紧跟在触发它的 user/agent 消息后面

### rationale
- 宿主 agent 是用户直接交互的对象
- 展示完整的执行过程增强透明度和可信度
- 用户可以了解 agent 的推理过程和使用的工具

---

## 规则 3: 其他 Agent 的回复

### 定义
当宿主 agent 请求其他 agent 协助时，被请求的 agent 返回的响应。

### 渲染样式
- **默认状态**：在宿主 agent 消息末尾显示**可折叠标签**
- **标签内容**：显示 agent 名称 + 消息数量摘要
- **展开后**：**完整渲染**（工具调用 + 思考步骤 + 文本）
- **视觉层级**：作为宿主消息的子内容，使用缩进或边框区分

### 视觉效果

**折叠状态：**
```
┌─────────────────────────────────┐
│ 宿主 Agent 的响应内容...         │
│                                 │
│ ┌───────────────────────────┐  │
│ │ ▶ Agent B 的回复 (3)      │  │  ← 可折叠标签
│ └───────────────────────────┘  │
└─────────────────────────────────┘
```

**展开状态：**
```
┌─────────────────────────────────┐
│ 宿主 Agent 的响应内容...         │
│                                 │
│ ┌───────────────────────────┐  │
│ │ ▼ Agent B 的回复          │  │
│ └───────────────────────────┘  │
│ ┌───────────────────────────┐  │
│ │ 💭 Thinking: 让我检查...   │  │  ← 完整渲染
│ │ 🔧 Read: ✓                │  │
│ │ 🔧 Grep: ✓                │  │
│ │ 📝 我发现了以下问题...      │  │
│ └───────────────────────────┘  │
└─────────────────────────────────┘
```

### 技术实现
- 消息角色：`metadata.messageType: "response"` + `metadata.source: "agent"`
- 渲染组件：`InterAgentRepliesDisclosure` 或同等可折叠组件
- 数据来源：轮询目标 agent 的 conversation messages
- 选择规则：优先使用 `metadata.senderAgentId === binding.agentId`。`role: "agent"` 是从其他 agent 注入的请求；`role: "assistant"` 是目标 agent 自己的输出。`send_message` part 现在会带 `toolKind: "inter_agent_send"`，不要仅凭工具名推断回复归属。
- 精确关联：目标 agent 输出使用 `metadata.replyToMessageId` / `metadata.correlationId`；`send_message` 工具结果返回 `message_id` / `correlation_id`。两者匹配时只渲染该次请求对应的输出。
- 位置：嵌入在触发请求的宿主 agent 消息内部

### rationale
- 其他 agent 的回复是"辅助信息"，不应抢占主聊天焦点
- 可折叠设计保持主聊天流畅，同时允许深入查看
- 完整渲染确保用户能了解其他 agent 的工作过程
- 符合"渐进式披露"设计原则

---

## 适用范围

### ✅ 适用的会话类型
- **主聊天 (Main Chat)** - 用户与宿主 agent 的主会话
- **侧边聊天 (Side Chat)** - 与特定 agent 的独立会话
- **子会话 (Sub-chat)** - 从主会话派生的会话

### ❌ 不适用的会话类型
- **群聊会话 (Group Chat)** - 多 agent 平等参与的会话，使用不同的渲染规则

---

## 消息角色映射

后端消息通过 `metadata` 字段确定前端渲染角色：

| metadata.messageType | metadata.source | 前端 role | 渲染规则 |
|---------------------|----------------|-----------|---------|
| `"request"` | `"agent"` | `"agent"` | 规则 1：简化渲染 |
| `"response"` | `"agent"` | `"assistant"` | 规则 2 或 3 |
| `"broadcast"` | `"agent"` | `"assistant"` | 规则 2 或 3 |
| `"agent_output"` | 绑定 agent | `"assistant"` | 规则 2 或 3 |
| - | `"user"` | `"user"` | 用户消息 |
| - | `"system"` | `"assistant"` | 规则 2 |

**区分规则 2 和 3：**
- 如果消息在当前 agent 自己的 conversation 中 → 规则 2（宿主回复）
- 如果消息在其他 agent 的 conversation 中 → 规则 3（其他 agent 回复）
- 在目标 agent 的绑定 conversation 中，`role: "assistant"` 明确表示该绑定 agent 的输出；跨 conversation 复制到主会话的副本必须保留 `metadata.messageType: "response"`、sender 元数据和 `correlationId`。

---

## 实现检查清单

### 主聊天
- [ ] Agent 发送的请求消息使用简化渲染
- [ ] 宿主 agent 的回复完整渲染（工具 + 思考 + 文本）
- [ ] 其他 agent 的回复使用可折叠标签
- [ ] 折叠标签显示 agent 名称和消息摘要
- [ ] 展开后完整渲染其他 agent 的回复

### 侧边聊天
- [ ] 与主聊天相同的渲染规则
- [ ] 消息正确映射 role（基于 metadata）
- [ ] 保留完整的 parts 数组
- [ ] 同步到 Jotai store 以支持完整渲染

### 通用
- [ ] 消息 parts 包含所有类型（text, tool-*, reasoning）
- [ ] 工具调用显示状态（⏳ 进行中 / ✓ 完成 / ❌ 错误）
- [ ] 思考步骤可折叠或隐藏
- [ ] 文本内容支持 markdown 渲染

---

## 相关代码位置

### 前端组件
- `src/renderer/features/agents/main/assistant-message-item.tsx` - 完整渲染组件
- `src/renderer/features/agents/main/inter-agent-replies-disclosure.tsx` - 可折叠标签组件
- `src/renderer/features/agents/main/isolated-message-group.tsx` - 消息分组渲染
- `src/renderer/features/details-sidebar/components/side-chat-panel.tsx` - 侧边聊天面板

### 消息处理
- `src/renderer/features/agents/stores/message-store.ts` - 消息存储和 role 策略
- `src/renderer/features/agents/lib/ergatai-chat-transport.ts` - 消息传输层

### 后端 API
- `crates/ergatai-api/src/api/agents.rs` - Agent 消息 API
- `crates/ergatai-api/src/mcp/message_delivery.rs` - 消息投递

---

## 版本历史

- **2026-10-07**: 初始版本，定义三条渲染规则
- 修复 agent-to-agent 消息不显示工具调用和思考步骤的问题
- 统一主聊天和侧边聊天的渲染逻辑
