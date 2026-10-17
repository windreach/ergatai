# Agent-to-Agent 消息路由完整事件追踪

## 场景：Agent A (Claude) 调用 Agent B (Codex)

### 阶段 1: Frontend - 用户发送消息

**文件**: `src/renderer/features/agents/main/active-chat.tsx`

```typescript
// 用户在 chat input 中输入消息并发送
const handleSend = async (message: string) => {
  // 1. 调用 useChat 的 sendMessage
  await sendMessage({
    role: "user",
    parts: [{ type: "text", text: message }],
  })
}
```

**追踪点**: 
- `sendMessage` 来自 `useChat` hook (ai sdk)
- 触发 transport 的 `sendMessages` 方法

---

### 阶段 2: Frontend - ErgataiChatTransport.sendMessages

**文件**: `src/renderer/features/agents/lib/ergatai-chat-transport.ts`

```typescript
async sendMessages(options: { messages: UIMessage[]; abortSignal?: AbortSignal }) {
  // 1. 提取 prompt
  const prompt = this.extractPrompt(lastUser)
  
  // 2. 获取或创建 agent
  let agentId = this.config.agentId
  if (!agentId) {
    agentId = await getOrCreateActiveAgent(
      this.config.chatId,
      this.config.command,
      this.config.subChatId
    )
  }
  
  // 3. 构建消息 payload
  const isAgentToAgent = !!this.config.fromAgentId
  
  if (isAgentToAgent) {
    // Agent-to-agent 消息
    messagePayload = {
      agentId,
      message: prompt,
      from: this.config.fromAgentId,  // 发送方 agent ID
      messageType: "request",
      targetAgentCommand: this.config.targetAgentCommand,  // 目标 agent 类型
      forceNewSession: this.config.forceNewSession,
      correlationId: this.config.correlationId,
    }
  } else {
    // 用户消息
    messagePayload = {
      agentId,
      message: prompt,
      from: "user",
      messageType: "request",
      subChatId: this.config.subChatId,
    }
  }
  
  // 4. 调用 tRPC endpoint
  await trpcClient.ergatai.sendMessage.mutate(messagePayload)
  
  // 5. 订阅 SSE stream 接收响应
  subscription = trpcClient.ergatai.subscribeAgentStream.subscribe({
    agentId,
    promptId: promptId ?? undefined,
  }, {
    onData: (event) => { /* 处理事件 */ },
    onError: (error) => { /* 处理错误 */ },
    onComplete: () => { /* 完成 */ },
  })
}
```

**追踪点**:
- `trpcClient.ergatai.sendMessage.mutate` → tRPC IPC → main process
- `trpcClient.ergatai.subscribeAgentStream.subscribe` → SSE subscription

---

### 阶段 3: Main Process - tRPC Router

**文件**: `src/main/lib/trpc/routers/ergatai.ts`

```typescript
sendMessage: publicProcedure
  .input(z.object({
    agentId: z.string(),
    message: z.string(),
    from: z.string().optional(),
    messageType: z.enum(["request", "response", "broadcast"]).optional(),
    correlationId: z.string().optional(),
    targetAgentCommand: z.string().optional(),  // Agent-to-agent 字段
    forceNewSession: z.boolean().optional(),
  }))
  .mutation(async ({ input }) => {
    const body: Record<string, any> = {
      message: input.message,
      from: input.from,
      message_type: input.messageType,
      correlation_id: input.correlationId,
    }
    
    // 添加 agent-to-agent 字段
    if (input.targetAgentCommand) {
      body.target_agent_command = input.targetAgentCommand
    }
    if (input.forceNewSession !== undefined) {
      body.force_new_session = input.forceNewSession
    }
    
    // 调用后端 API
    return ergataiFetch(`/api/v1/agents/${input.agentId}/message`, {
      method: "POST",
      body: JSON.stringify(body),
    })
  })
```

**追踪点**:
- `ergataiFetch` → HTTP POST → Rust backend (localhost:3000)
- 路径: `/api/v1/agents/:agentId/message`

---

### 阶段 4: Backend - Axum Router

**文件**: `crates/ergatai-api/src/lib.rs`

```rust
.route(
    "/api/v1/agents/:id/message",
    post(api::agents::send_message),
)
```

**追踪点**:
- Axum 路由匹配 → 调用 `api::agents::send_message` handler

---

### 阶段 5: Backend - send_message Handler

**文件**: `crates/ergatai-api/src/api/agents.rs`

```rust
pub async fn send_message(
    State(_state): State<AppState>,
    Path(id): Path<String>,  // 发送方 agent ID
    Json(req): Json<SendMessageRequest>,
) -> impl IntoResponse {
    let sender = get_message_sender()?;
    
    // 检查是否是 agent-to-agent 路由
    if let Some(target_command) = &req.target_agent_command {
        // 1. 获取发送方 agent 信息
        let sender_info = get_agent_info(&id).await?;
        let chat_id = sender_info.workspace_id.clone();
        
        // 2. 检查是否需要强制新 session
        let force_new = req.force_new_session.unwrap_or(false);
        
        if !force_new {
            // 3. 查找已绑定的 agent
            let bindings = group_agent_bindings::list(&chat_id).await?;
            
            for binding in bindings {
                if binding.agent_command.as_deref() == Some(target_command) {
                    // 4. 检查 agent 是否存活
                    if let Some(target_info) = get_agent_info(&binding.agent_id).await {
                        if target_info.lifecycle.is_alive() {
                            // 5. 路由到已存在的 agent
                            let send_req = SendRequest {
                                from: req.from.unwrap_or(id),
                                to: binding.agent_id,
                                message: req.message,
                                message_type: req.message_type,
                                correlation_id: req.correlation_id,
                                sub_chat_id: req.sub_chat_id,
                            };
                            
                            let result = sender.send(send_req).await;
                            return match result {
                                SendMessageResult::Queued { target_agent, stream, sequence } => {
                                    Json(json!({
                                        "status": "queued",
                                        "target_agent_id": target_agent,
                                        "session_id": stream,
                                        "sequence": sequence,
                                        "reused": true,  // 标记复用
                                    }))
                                }
                                // ...
                            };
                        }
                    }
                }
            }
        }
        
        // 6. 没有找到存活的 agent → spawn 新的
        let resolved_command = resolve_profile_command(target_command);
        let work_dir = get_work_dir_from_metadata(&sender_info);
        
        let spec = WorkspaceSpec {
            id: chat_id.clone(),
            work_dir: work_dir.into(),
            env: HashMap::new(),
            resources: ResourceLimits::default(),
            capture_thoughts: false,
        };
        
        let instruction = Some(format!(
            "Agent-to-agent message from {}. Target: {}.",
            id, target_command
        ));
        
        // 7. 启动新 agent
        let new_agent_id = runtime.launch_agent(spec, &resolved_command, instruction.as_deref()).await?;
        
        // 8. 绑定到 chat
        let binding = GroupAgentBinding {
            id: format!("binding_{}", Uuid::new_v4()),
            chat_id: chat_id.clone(),
            agent_id: new_agent_id.clone(),
            agent_name: target_command.clone(),
            agent_command: Some(target_command.clone()),
            sub_chat_id: req.sub_chat_id.clone().unwrap_or(chat_id),
            created_at: Utc::now().timestamp(),
            updated_at: Utc::now().timestamp(),
        };
        group_agent_bindings::upsert(binding).await?;
        
        // 9. 发送消息到新 agent
        let send_req = SendRequest {
            from: req.from.unwrap_or(id),
            to: new_agent_id.clone(),
            message: req.message,
            // ...
        };
        
        return match sender.send(send_req).await {
            SendMessageResult::Queued { target_agent, stream, sequence } => {
                Json(json!({
                    "status": "queued",
                    "target_agent_id": target_agent,
                    "session_id": stream,
                    "sequence": sequence,
                    "spawned": true,  // 标记新 spawn
                }))
            }
            // ...
        };
    }
    
    // 普通消息（非 agent-to-agent）
    let send_req = SendRequest {
        from: req.from.unwrap_or("api".to_string()),
        to: id,
        message: req.message,
        // ...
    };
    
    match sender.send(send_req).await {
        // ...
    }
}
```

**追踪点**:
- `get_agent_info` → 查询 runtime agent 状态
- `group_agent_bindings::list` → 查询 SQLite 数据库
- `runtime.launch_agent` → 启动新 agent 进程
- `sender.send` → 消息路由系统

---

### 阶段 6: Backend - MessageSender

**文件**: `crates/ergatai-api/src/messaging/` (具体实现)

```rust
impl MessageSender {
    pub async fn send(&self, req: SendRequest) -> SendMessageResult {
        // 1. 解析目标 agent
        let target_agent = self.resolve_agent(&req.to).await?;
        
        // 2. 检查 agent 状态
        if !target_agent.is_alive() {
            return SendMessageResult::Rejected {
                reason: "Agent is not alive".to_string(),
            };
        }
        
        // 3. 路由消息
        match target_agent.message_queue {
            Some(queue) => {
                // 3a. 直接投递到 agent 的消息队列
                queue.push(Message {
                    from: req.from,
                    content: req.message,
                    message_type: req.message_type,
                    correlation_id: req.correlation_id,
                }).await;
                
                SendMessageResult::DirectDelivered {
                    target_agent: req.to,
                }
            }
            None => {
                // 3b. 通过 NATS 消息系统
                let stream = self.nats_client
                    .publish(&target_agent.subject, req.message)
                    .await?;
                
                SendMessageResult::Queued {
                    target_agent: req.to,
                    stream,
                    sequence: stream.sequence(),
                }
            }
        }
    }
}
```

**追踪点**:
- `resolve_agent` → 查找 agent 的进程句柄
- `message_queue.push` → 直接投递（同进程）
- `nats_client.publish` → NATS 消息队列（跨进程）

---

### 阶段 7: Backend - Agent 接收消息

**文件**: `crates/ergatai-runtime/src/agent.rs` (agent 进程内部)

```rust
impl Agent {
    pub async fn message_loop(&mut self) {
        loop {
            // 1. 从 NATS 或消息队列接收消息
            let msg = self.message_rx.recv().await?;
            
            // 2. 处理消息
            match msg.message_type.as_str() {
                "request" => {
                    // 3. 调用 ACP provider 处理
                    let response = self.acp_provider
                        .send_message(msg.content)
                        .await?;
                    
                    // 4. 发送响应
                    self.send_response(msg.from, response, msg.correlation_id).await?;
                }
                "response" => {
                    // 处理响应
                }
                _ => {}
            }
        }
    }
}
```

**追踪点**:
- `message_rx.recv` → 接收消息
- `acp_provider.send_message` → 调用 AI provider (Claude/Codex)
- `send_response` → 发送响应回发送方

---

### 阶段 8: Backend - SSE Stream 推送事件

**文件**: `crates/ergatai-api/src/api/agents.rs`

```rust
pub async fn stream_agent_output(
    Path(agent_id): Path<String>,
) -> impl IntoResponse {
    let (tx, rx) = mpsc::channel(100);
    
    // 订阅 agent 的事件流
    let subscription = agent_event_bus.subscribe(agent_id.clone());
    
    // 启动事件推送任务
    tokio::spawn(async move {
        while let Some(event) = subscription.recv().await {
            let sse_event = match event {
                AgentEvent::Text(delta) => {
                    SseEvent::default().data(json!({
                        "type": "text",
                        "delta": delta,
                    }))
                }
                AgentEvent::ToolCall(tool) => {
                    SseEvent::default().data(json!({
                        "type": "tool_call_start",
                        "id": tool.id,
                        "name": tool.name,
                    }))
                }
                AgentEvent::Done(stop_reason) => {
                    SseEvent::default().data(json!({
                        "type": "done",
                        "stop_reason": stop_reason,
                    }))
                }
                // ...
            };
            
            if tx.send(sse_event).await.is_err() {
                break;
            }
        }
    });
    
    // 返回 SSE stream
    SseResponse::new(rx)
}
```

**追踪点**:
- `agent_event_bus.subscribe` → 订阅 agent 事件
- `SseEvent` → SSE 格式的事件
- `SseResponse` → HTTP SSE stream

---

### 阶段 9: Main Process - tRPC Subscription

**文件**: `src/main/lib/trpc/routers/ergatai.ts`

```typescript
subscribeAgentStream: publicProcedure
  .input(z.object({
    agentId: z.string(),
    promptId: z.string().optional(),
  }))
  .subscription(({ input }) => {
    return observable((emit) => {
      // 1. 连接到后端 SSE stream
      const eventSource = new EventSource(
        `${apiUrl}/api/v1/agents/${input.agentId}/stream`
      )
      
      // 2. 处理事件
      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data)
        
        // 3. 转发给 renderer
        emit.next(data)
        
        // 4. 检查是否完成
        if (data.type === "done" || data.type === "error") {
          eventSource.close()
          emit.complete()
        }
      }
      
      // 5. 清理
      return () => {
        eventSource.close()
      }
    })
  })
```

**追踪点**:
- `EventSource` → SSE client
- `emit.next` → tRPC subscription 事件
- `emit.complete` → 结束 subscription

---

### 阶段 10: Renderer - 接收并显示响应

**文件**: `src/renderer/features/agents/lib/ergatai-chat-transport.ts`

```typescript
subscription = trpcClient.ergatai.subscribeAgentStream.subscribe(
  { agentId, promptId },
  {
    onData: (event) => {
      // 转换后端事件为 UIMessageChunk
      const chunks = transformEvent(event, textBlockId)
      
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      
      // 检查完成
      if (event.type === "done" || event.type === "error") {
        close([
          { type: "text-end", id: textBlockId },
          ...transformEvent(event, textBlockId),
        ])
      }
    },
    onError: (error) => {
      close([
        { type: "text-end", id: textBlockId },
        { type: "error", errorText: error.message },
        { type: "finish" },
      ])
    },
    onComplete: () => {
      close([
        { type: "text-end", id: textBlockId },
        { type: "finish" },
      ])
    },
  }
)
```

**追踪点**:
- `transformEvent` → 转换事件格式
- `controller.enqueue` → 推送到 ReadableStream
- `useChat` hook 消费 stream → 更新 UI

---

## 🔍 关键数据结构流转

### 1. SendMessageRequest (Frontend → Backend)

```typescript
// Frontend (TypeScript)
{
  agentId: "ws1-agent-1",
  message: "Please help with this task",
  from: "ws1-agent-0",  // Agent A
  messageType: "request",
  targetAgentCommand: "codex",  // 目标 agent 类型
  forceNewSession: false,
  correlationId: "conv-123",
}
```

```rust
// Backend (Rust)
pub struct SendMessageRequest {
    pub message: String,
    pub from: Option<String>,
    pub message_type: Option<String>,
    pub correlation_id: Option<String>,
    pub sub_chat_id: Option<String>,
    pub target_agent_command: Option<String>,
    pub force_new_session: Option<bool>,
}
```

### 2. Agent Binding (SQLite)

```rust
pub struct GroupAgentBinding {
    pub id: String,              // "binding_abc123"
    pub chat_id: String,         // "chat_xyz"
    pub agent_id: String,        // "ws1-agent-2"
    pub agent_name: String,      // "codex"
    pub agent_command: Option<String>,  // "codex"
    pub sub_chat_id: String,     // "subchat_456"
    pub created_at: i64,         // Unix timestamp
    pub updated_at: i64,
}
```

### 3. SendMessageResponse (Backend → Frontend)

```rust
// Backend (Rust)
Json(json!({
    "status": "queued",
    "target_agent_id": "ws1-agent-2",
    "session_id": "session_789",
    "sequence": 42,
    "spawned": true,  // 或 "reused": true
}))
```

```typescript
// Frontend (TypeScript)
{
  status: "queued",
  target_agent_id: "ws1-agent-2",
  session_id: "session_789",
  sequence: 42,
  spawned: true,
}
```

### 4. SSE Event (Backend → Frontend)

```rust
// Backend (Rust)
SseEvent {
    event: Some("message".to_string()),
    data: json!({
        "type": "text",
        "delta": "Hello from Codex!",
    }).to_string(),
}
```

```typescript
// Frontend (TypeScript)
{
  type: "text",
  delta: "Hello from Codex!",
}
```

---

## 🎯 关键决策点

### 决策 1: Agent 复用 vs 新建

```
if (binding_exists && agent_is_alive && !force_new_session) {
    // 复用 ✓
    route_to_existing_agent()
} else {
    // 新建 ✓
    spawn_new_agent()
    bind_to_chat()
}
```

### 决策 2: 消息路由方式

```
if (same_process) {
    // 直接投递到消息队列
    message_queue.push(msg)
} else {
    // 通过 NATS 消息系统
    nats_client.publish(subject, msg)
}
```

### 决策 3: 事件推送方式

```
// 所有 agent 事件都通过 EventBus 广播
agent_event_bus.publish(AgentEvent::Text(delta))

// SSE subscription 接收并转发
while let Some(event) = subscription.recv().await {
    emit.next(event)
}
```

---

## 📊 性能指标

| 阶段 | 延迟 | 说明 |
|------|------|------|
| Frontend → tRPC | ~1ms | IPC 调用 |
| tRPC → Backend | ~5ms | HTTP POST |
| Backend 路由决策 | ~2ms | 查询 binding + agent 状态 |
| Agent spawn (如需要) | ~500ms | 启动新进程 |
| 消息投递 | ~1ms | NATS 或本地队列 |
| Agent 处理 | ~100ms-10s | 取决于 AI provider |
| SSE 推送 | ~1ms | 事件流 |
| **总计（复用）** | ~110ms | 不含 agent 处理时间 |
| **总计（新建）** | ~610ms | 含 agent spawn |

---

## 🐛 调试技巧

### 1. 开启详细日志

```bash
# Backend
RUST_LOG=debug cargo run

# Frontend
DEBUG=ergatai:* bun run dev
```

### 2. 追踪消息 ID

```typescript
// 在 message 中添加 trace_id
const traceId = crypto.randomUUID()
message.metadata = { traceId }

// 在日志中搜索
grep traceId logs/*.log
```

### 3. 监控 NATS 消息

```bash
# 订阅所有消息
nats sub '>'

# 订阅特定 agent
nats sub 'agent.ws1-agent-2.>'
```

### 4. 检查 agent 绑定

```bash
# 查询 SQLite
sqlite3 ~/.ergatai/user_data.db \
  "SELECT * FROM group_agent_bindings WHERE chat_id = 'chat_123'"
```

---

## ✅ 验证清单

- [ ] 用户消息正确发送到 backend
- [ ] Agent-to-agent 字段正确传递
- [ ] Binding 查询返回正确结果
- [ ] Agent 复用逻辑工作正常
- [ ] Agent 新建逻辑工作正常
- [ ] 消息正确路由到目标 agent
- [ ] Agent 正确接收并处理消息
- [ ] SSE 事件正确推送到 frontend
- [ ] UI 正确显示 agent 响应
- [ ] 错误情况正确处理（agent 死亡、网络断开等）
