# Agent 状态监控方案 — 基于 LLM API 流量拦截

## 问题定义

当前 ergatai 能观察到 agent 的**进程级状态**（存活/僵尸/死亡），但无法观察 **语义级状态**：
- agent 在等什么？（空闲 / 等用户输入 / 等 LLM 响应 / 等工具执行）
- agent 在做什么？（思考 / 生成文本 / 调用工具 / 读文件）
- agent 遇到了什么？（限流 429 / API 错误 / 网络超时）
- agent 花了多少？（token 用量 / 延迟 / 成本）

## 核心思路（你的直觉是对的）

AI agent 通过 HTTP API（OpenAI / Anthropic 协议）与 LLM 通信。**拦截这些 HTTP 请求**就能推断出 agent 的语义状态，无需修改 agent 本身。

```
Agent 进程 → HTTP_PROXY → LLM API (api.openai.com / api.anthropic.com)
                │
                ↓
         ergatai 拦截层：解析 SSE 流 → 推断状态 → 发布到 NATS
```

## 方案对比

| 方案 | 可行性 | 侵入性 | 复杂度 | 推荐度 |
|------|--------|--------|--------|--------|
| **MITM 代理 + HTTP_PROXY** | ✅ 高 | 低（仅注入环境变量） | 中 | ⭐⭐⭐ |
| eBPF socket 拦截 | ✅ 高 | 无 | 极高 | ⭐（研究用） |
| strace syscall 监控 | ✅ 中 | 低 | 高 | ⭐⭐ |
| PTY 输出语义解析 | ⚠️ 部分 | 无 | 中 | 补充方案 |
| SDK hook / MCP 上报 | ✅ 高 | 高（需改 agent） | 低 | 受限场景 |

**推荐：MITM 代理** — 原因：
1. 任何语言的 agent 都能用（Node/Python/Go/Rust），只需注入 `HTTP_PROXY` 环境变量
2. 全明文 JSON/SSE 可见，解析简单
3. 不需要 root/CAP_BPF，普通用户可运行
4. 已有成熟参考实现（Helicone, llm-interceptor, http-mitm-proxy crate）

## 协议特征 → 状态推断

### Anthropic Messages API (`/v1/messages`, SSE streaming)

```
POST /v1/messages  ← 请求开始 → 状态: API_CALLING
  ← message_start  → 状态: THINKING (TTFB 开始计时)
  ← content_block_start (type=thinking)  → 状态: THINKING
  ← content_block_delta (type=thinking_delta)  → 状态: THINKING (持续)
  ← content_block_start (type=text)  → 状态: GENERATING_TEXT
  ← content_block_delta (type=text_delta)  → 状态: GENERATING_TEXT
  ← content_block_start (type=tool_use)  → 状态: GENERATING_TOOL
  ← message_stop (stop_reason=end_turn)  → 状态: IDLE (一轮结束)
  ← message_stop (stop_reason=tool_use)  → 状态: TOOL_EXECUTING (等待工具结果)
  ← error (type=error, error.rate_limit) → 状态: RATE_LIMITED
```

### OpenAI Chat Completions (`/v1/chat/completions`, SSE streaming)

```
POST /v1/chat/completions  → 状态: API_CALLING
  ← delta.content (非空)  → 状态: GENERATING_TEXT
  ← delta.tool_calls (非空)  → 状态: GENERATING_TOOL
  ← [DONE]  + finish_reason=stop  → 状态: IDLE
  ← [DONE]  + finish_reason=tool_calls  → 状态: TOOL_EXECUTING
```

### 状态机（7 个可推断状态）

```
         ┌──────────────────────────────────────────┐
         │                                          │
         ▼                                          │
    ┌─────────┐   HTTP POST   ┌─────────────┐      │
    │  IDLE   │──────────────▶│ API_CALLING │      │
    └─────────┘               └──────┬──────┘      │
         ▲                          │ first byte    │
         │                          ▼               │
    stop_reason=              ┌─────────────┐      │
    end_turn                  │  THINKING   │ (TTFB │
         │                    │ (or TTFB)   │  gap) │
         │                    └──────┬──────┘      │
         │                           │ content      │
         │                           ▼              │
         │                    ┌─────────────┐      │
         │                    │ GENERATING  │──────┘
         │                    │ {text|tool} │  (stream ends)
         │                    └──────┬──────┘
         │                           │
         │                    stop_reason?
         │                   ↙        ↘
         │            end_turn      tool_use
         │               │             │
         │               ▼             ▼
         │           IDLE      ┌──────────────┐
         │                     │ TOOL_EXEC    │
         │                     └──────┬───────┘
         │                            │ next POST
         └────────────────────────────┘

  异常路径:
    HTTP 429  → RATE_LIMITED (自动重试后退化为 THINKING)
    HTTP 5xx  → API_ERROR
    超时无响应 → API_TIMEOUT
    连接失败   → NETWORK_ERROR
```

## 实现架构

```
┌─────────────────────────────────────────────────────────────┐
│  ergatai-api                                                 │
│                                                              │
│  ┌─────────────────────┐    ┌──────────────────────────┐    │
│  │  AgentSpawner        │    │  LlmProxyManager         │    │
│  │                      │    │                            │    │
│  │  启动 agent 时:       │    │  每个 workspace 一个代理:   │    │
│  │  1. 分配随机端口      │    │  1. 生成自签名 CA 证书     │    │
│  │  2. 启动 MITM proxy  │    │  2. 启动 hyper MITM server │    │
│  │  3. 注入环境变量:     │───▶│  3. 转发到真实 LLM API     │    │
│  │     HTTP_PROXY=      │    │  4. 解析 SSE 流            │    │
│  │      localhost:PORT  │    │  5. 发布 ApiEvent 到 NATS  │    │
│  │     SSL_CERT_FILE=   │    │                            │    │
│  │      /tmp/ca.pem     │    └──────────┬───────────────┘    │
│  │     NODE_EXTRA_CA_   │               │                     │
│  │      CERTS=...       │               ▼                     │
│  └─────────────────────┘    ┌──────────────────────────┐    │
│                              │  AgentStateInference      │    │
│                              │                            │    │
│                              │  订阅 ApiEvent 流:         │    │
│                              │  - 运行状态机              │    │
│                              │  - 推断语义状态            │    │
│                              │  - 更新 AgentLifecycleState│    │
│                              │  - 计算 TTFB/延迟/token    │    │
│                              └──────────┬───────────────┘    │
│                                         │                     │
│                                         ▼                     │
│                              ┌──────────────────────────┐    │
│                              │  NATS event bus           │    │
│                              │  ergatai.agent.api.{uuid} │    │
│                              │  ergatai.agent.state.{uuid}│   │
│                              └──────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## 关键实现细节

### 1. MITM 代理（Rust）

```rust
// 依赖: hyper + rustls + rcgen (CA 证书生成)
// 参考: https://crates.io/crates/http-mitm-proxy

struct LlmProxy {
    listen_port: u16,
    ca_cert: rcgen::Certificate,  // 自签名 CA
    api_events_tx: mpsc::Sender<ApiEvent>,
}

// 对每个 HTTPS CONNECT 请求:
// 1. 用 CA 签发目标域名的叶证书
// 2. 用叶证书与 client 建立 TLS
// 3. 解密 → 解析 HTTP 请求/响应 → 加密转发
```

### 2. SSE 流解析器

```rust
enum LlmProtocol {
    Anthropic,  // /v1/messages
    OpenAI,     // /v1/chat/completions
    Unknown,
}

struct SseParser {
    protocol: LlmProtocol,
    // 解析 SSE event → ApiEvent
}

enum ApiEvent {
    RequestStarted { model: String, stream: bool, has_tools: bool },
    FirstToken { latency_ms: u64 },  // TTFB
    ContentDelta { delta_type: ContentDeltaType, bytes: usize },
    StreamEnd { stop_reason: StopReason, total_tokens: Option<u64> },
    Error { status: u16, message: String },
}
```

### 3. 与现有系统集成

```rust
// AgentLifecycleState 扩展（新状态）
enum AgentLifecycleState {
    // ... 现有状态 ...
    
    // 新增：从 API 流量推断的语义状态
    ApiCalling { started_at: Instant, model: String },
    StreamingResponse { started_at: Instant, model: String, phase: StreamPhase },
    ToolExecuting { tool_name: String, started_at: Instant },
    RateLimited { retry_after: Option<Duration>, since: Instant },
}

// PtyBackend::spawn_agent() 集成
async fn spawn_agent(&self, ...) {
    let proxy = self.proxy_manager.start_proxy(workspace_id).await?;
    let env = proxy.inject_env_vars();  // HTTP_PROXY, SSL_CERT_FILE, etc.
    let process = PtyProcess::spawn(cmd, args, env)?;
    // proxy 生命周期绑定到 agent — agent 退出时 proxy 也关闭
}
```

### 4. 环境变量注入

```rust
fn proxy_env_vars(proxy_port: u16, ca_cert_path: &Path) -> Vec<(String, String)> {
    vec![
        ("HTTP_PROXY".into(), format!("http://127.0.0.1:{}", proxy_port)),
        ("HTTPS_PROXY".into(), format!("http://127.0.0.1:{}", proxy_port)),
        ("SSL_CERT_FILE".into(), ca_cert_path.display().to_string()),
        ("NODE_EXTRA_CA_CERTS".into(), ca_cert_path.display().to_string()),  // Node.js
        ("REQUESTS_CA_BUNDLE".into(), ca_cert_path.display().to_string()),   // Python
        ("CURL_CA_BUNDLE".into(), ca_cert_path.display().to_string()),       // curl
    ]
}
```

## 可观测性收益

| 指标 | 来源 | 价值 |
|------|------|------|
| **TTFB** (Time To First Byte) | 请求开始 → 第一个 SSE 事件 | 衡量 LLM 响应速度 |
| **Token 用量** | SSE content_block_delta 累计 | 成本核算 |
| **API 延迟** | 请求开始 → message_stop | 性能瓶颈定位 |
| **错误率** | HTTP 4xx/5xx 计数 | 可靠性监控 |
| **限流次数** | HTTP 429 计数 | 容量规划 |
| **工具调用频率** | stop_reason=tool_use 计数 | agent 行为分析 |
| **空闲时间占比** | IDLE 状态时长 / 总时长 | 资源利用率 |
| **每轮对话耗时** | 两个 IDLE 之间 | 效率评估 |

## 工程风险与缓解

| 风险 | 缓解 |
|------|------|
| agent 忽略 HTTP_PROXY | 同时注入 NODE_EXTRA_CA_CERTS 等运行时特定变量；fallback 到 PTY 解析 |
| 自签名证书被拒绝 | 提供 ca.pem 路径 + 多种 CA 环境变量覆盖 |
| 性能开销 | MITM 在同一台机器 localhost，延迟 < 1ms；解析 SSE 是纯 CPU |
| 非 HTTP 代理的 agent | PTY 输出语义解析作为补充方案 |
| 多 API provider 支持 | 按 URL path 自动识别协议（/v1/messages → Anthropic, /v1/chat/completions → OpenAI） |

## 分阶段实施建议

### Phase 1: 基础代理（1-2 周）
- [ ] 实现最小 MITM proxy（仅转发 + 日志）
- [ ] 环境变量注入到 PtyProcess
- [ ] CA 证书自动生成 + 临时文件管理

### Phase 2: SSE 解析（1 周）
- [ ] Anthropic Messages SSE 解析器
- [ ] OpenAI Chat Completions SSE 解析器
- [ ] ApiEvent 定义 + NATS 发布

### Phase 3: 状态推断（1 周）
- [ ] 状态机实现（7 状态）
- [ ] 与 AgentLifecycleState 融合
- [ ] TTFB / token / 延迟指标计算

### Phase 4: 可观测性（1 周）
- [ ] REST API 暴露 agent 语义状态
- [ ] CLI `ergatai status` 显示语义状态
- [ ] Prometheus 指标导出

## 替代方案：PTY 语义解析（补充）

如果 MITM 代理无法覆盖某些 agent（如硬编码了 API endpoint 不走代理），
可以用 PTY 输出作为 fallback：

```rust
// 在 OutputBuffer 的 reader loop 后链式解析
// 匹配常见 coding agent 的输出模式:
// - "Thinking..." / "Analyzing..." → THINKING
// - "Reading file: xxx" → TOOL_EXECUTING (file_read)
// - "Writing to: xxx" → TOOL_EXECUTING (file_write)
// - "$ command" → TOOL_EXECUTING (shell)
```

但这很脆弱（依赖 agent 的 UI 输出格式），所以 MITM 代理是主力。

## 参考

- [AgentSight eBPF 论文](https://arxiv.org/html/2508.02736v1) — eBPF 方案的学术研究
- [Helicone](https://helicone.ai) — 商业 LLM 可观测性平台（代理模式）
- [LLM Interceptor](https://github.com/chouzz/llm-interceptor) — 开源 MITM 拦截器
- [Rust HTTPS Proxy for AI Agents](https://dev.to/jonathanfishner/building-a-rust-https-proxy-for-ai-agents-2e3i) — Rust 实现参考
- [Anthropic Streaming Docs](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [OpenAI Streaming Guide](https://developers.openai.com/api/docs/guides/streaming-responses)
