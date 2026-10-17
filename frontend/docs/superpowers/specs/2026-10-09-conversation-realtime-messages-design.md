# Conversation 级别实时消息推送 - 设计规范

## 概述

将 Ergatai 前端的消息接收方式从**轮询 REST API** 改为**订阅 Conversation 级别的 SSE 流**，实现实时消息推送，延迟 < 100ms。

## 目标

1. ✅ 实时推送：消息延迟 < 100ms
2. ✅ 减少服务器负载：移除轮询
3. ✅ 简化架构：以 Conversation 为中心，Agent 只是角色来源
4. ✅ 向后兼容：支持渐进式迁移

## 架构设计

### 核心原则

- **Conversation 是执行单元**：所有消息都属于某个 conversation
- **Agent 只是角色来源**：Agent 信息（`sender_agent_id`）只是消息的元数据
- **NATS 是信息交换基础设施**：所有消息（用户 + Agent）都通过 NATS

### 数据流

```
用户发送消息：
  Frontend → REST API → SQLite (永久存储)
                       ↓
                    NATS (ergatai.conversation.message.{conv_id})
                       ↓
                    SSE 端点 → 前端实时推送

Agent 回复：
  Agent → MCP send_message
         ↓
      MessageSender
         ├─ SQLite (永久存储)
         └─ NATS (ergatai.conversation.message.{conv_id})
             ↓
          SSE 端点 → 前端实时推送
```

### NATS Subject 设计

**新增：**
```
ergatai.conversation.message.{conversation_id}
```

**废弃：**
```
ergatai.agent.message.{agent_id}  // 标记为 deprecated
```

## 前端实现

### 核心 Hook

**文件：** `src/renderer/features/agents/hooks/use-conversation-messages.ts`

**职责：**
- 首次加载：通过 REST API 获取历史消息
- 实时订阅：通过 SSE 接收新消息
- 去重和排序：确保消息不重复且按顺序显示

**API：**
```typescript
function useConversationMessages(conversationId: string): {
  messages: Message[]
  isLoading: boolean
  error: Error | null
}
```

**实现要点：**
1. 使用 `useQuery` 加载历史消息
2. 使用 `useSubscription` 订阅实时消息
3. 通过 `lastSequenceRef` 实现增量订阅
4. 自动去重和排序

### tRPC Subscription

**文件：** `src/main/lib/trpc/routers/ergatai.ts`

**职责：**
- 桥接后端 SSE 端到前端 tRPC subscription
- 管理 EventSource 连接生命周期
- 错误处理和自动重连

**实现要点：**
1. 使用 `observable` 创建订阅流
2. 监听 `EventSource.onmessage` 事件
3. 处理 `EventSource.onerror` 错误
4. 在清理函数中关闭连接

### 组件修改

**1. inter-agent-replies-disclosure.tsx**

**改动：**
- 移除 `refetchInterval: 4000` 轮询
- 使用 `useConversationMessages` hook
- 添加 `isLoading` 状态处理

**2. collaboration-session-runtime.ts**

**改动：**
- 移除 `setInterval` 轮询
- 使用 tRPC subscription 订阅事件
- 简化状态管理

## 后端改动

详见 `docs/BACKEND_REQUIREMENTS_CONVERSATION_SSE.md`

### 关键改动

1. **新增 NATS Subject**：`ergatai.conversation.message.{conversation_id}`
2. **修改 MessageSender**：所有消息都发布到 conversation subject
3. **新增 SSE 端点**：`GET /api/v1/conversations/{id}/sse`
4. **JetStream Stream**：`CONVERSATION_MESSAGES`

## 迁移策略

### 阶段 1：向后兼容（1-2 周）

**后端：**
- 新增 `ergatai.conversation.message.*` subject
- 保留 `ergatai.agent.message.*` subject（deprecated）
- 双写：消息同时发布到两个 subject

**前端：**
- 新增 `useConversationMessages` hook
- 逐步替换轮询代码
- 保留旧代码作为 fallback

### 阶段 2：完全迁移（1-2 月）

**后端：**
- 移除 `ergatai.agent.message.*` subject
- 清理旧代码

**前端：**
- 完全使用 conversation 订阅
- 移除所有轮询代码

## 测试计划

### 单元测试

1. **useConversationMessages hook**
   - 首次加载历史消息
   - 实时接收新消息
   - 去重和排序
   - 错误处理

2. **tRPC subscription**
   - EventSource 连接管理
   - 消息解析
   - 错误处理

### 集成测试

1. 用户发送消息 → 前端实时接收
2. Agent 回复 → 前端实时接收
3. 多个前端同时订阅同一 conversation
4. 网络断开 → 自动重连

### 性能测试

1. 1000 个并发 SSE 连接
2. 每秒 100 条消息的推送延迟
3. 内存占用和 CPU 使用率

## 验收标准

- [ ] 消息延迟 < 100ms
- [ ] 移除所有轮询代码
- [ ] 消息不丢失，不重复
- [ ] 支持 1000+ 并发 SSE 连接
- [ ] 自动重连机制正常工作
- [ ] 向后兼容，不影响现有功能

## 风险与缓解

### 风险 1：后端改动延迟

**缓解：**
- 前端先用轮询优化（增量查询）
- 保留旧代码作为 fallback
- 与后端团队紧密协作

### 风险 2：SSE 连接不稳定

**缓解：**
- tRPC 自动重连机制
- 前端添加重连重试逻辑
- 监控 SSE 连接状态

### 风险 3：消息丢失

**缓解：**
- 消息持久化到 SQLite
- SSE 支持增量订阅（`afterSequence`）
- 前端轮询作为 fallback

## 时间线

| 阶段 | 时间 | 任务 |
|------|------|------|
| 设计 | Week 1 | 完成设计规范，后端需求文档 |
| 后端开发 | Week 2-3 | 实现 SSE 端点，conversation subject |
| 前端开发 | Week 2-3 | 实现 hook，修改组件 |
| 测试 | Week 4 | 单元测试，集成测试，性能测试 |
| 部署 | Week 5 | 灰度发布，全量上线 |

## 参考

- [后端需求文档](./BACKEND_REQUIREMENTS_CONVERSATION_SSE.md)
- [NATS JetStream 文档](https://docs.nats.io/nats-concepts/jetstream)
- [SSE 规范](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [tRPC Subscription](https://trpc.io/docs/subscriptions)
