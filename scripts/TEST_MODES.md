# Ergatai API 测试框架使用指南

## 📋 三种测试模式

我们提供三种不同的测试方式，适用于不同场景：

### 1️⃣ Mock 测试 (`api-test-mock.sh`)

**特点**：
- ❌ 不启动真实 agent
- ❌ 不启动 API 服务器
- ✅ 使用预设的 JSON 响应
- ✅ 最快，无需任何依赖

**适用场景**：
- 验证测试框架逻辑
- CI/CD 快速冒烟测试
- 离线环境测试
- 单元测试

**运行方式**：
```bash
./scripts/api-test-mock.sh
```

**测试内容**：
- API 响应格式验证
- 测试逻辑正确性
- JSON 数据结构

---

### 2️⃣ ACP 测试 (`api-test-acp.sh`)

**特点**：
- ✅ 启动真实 API 服务器
- ✅ 使用简易 ACP Mock Agent (Python)
- ✅ 测试真实的 ACP 协议交互
- ✅ 验证 agent 生命周期

**适用场景**：
- 集成测试
- ACP 协议验证
- Agent 生命周期测试
- 多 agent 协作测试

**前置要求**：
```bash
# 1. 启动 API 服务器
cargo run -p ergatai-api -- --port 3000

# 2. 确保 Python 3 已安装
python3 --version
```

**运行方式**：
```bash
./scripts/api-test-acp.sh
```

**测试内容**：
- ACP 协议交互
- Agent 启动/停止
- 消息传递
- 多 agent 协作

---

### 3️⃣ 真实测试 (`api-test.sh`)

**特点**：
- ✅ 启动真实 API 服务器
- ✅ 使用真实的 agent (claude/cursor 等)
- ✅ 完整的端到端测试
- ⚠️ 需要配置 agent profile

**适用场景**：
- 端到端测试
- 生产环境验证
- 完整功能测试
- 性能测试

**前置要求**：
```bash
# 1. 启动 API 服务器
cargo run -p ergatai-api -- --port 3000

# 2. 注册 agent profile（例如 claude-code）
curl -X POST http://localhost:3000/api/v1/agent-profiles \
  -H "Content-Type: application/json" \
  -d '{
    "name": "default",
    "command": "claude",
    "args": ["--acp"],
    "instruction": "You are a helpful coding assistant."
  }'
```

**运行方式**：
```bash
./scripts/api-test.sh
```

**测试内容**：
- 完整的 API 功能
- 真实的 agent 交互
- DAG 工作流编排
- 文件锁管理

---

## 🎯 选择指南

| 需求 | 推荐模式 | 原因 |
|------|---------|------|
| 快速验证代码改动 | Mock | 最快，无需启动服务 |
| CI/CD 流水线 | Mock + ACP | 快速 + 集成验证 |
| ACP 协议开发 | ACP | 验证协议实现 |
| 功能完整测试 | 真实 | 端到端验证 |
| 性能压力测试 | 真实 | 真实负载 |
| 离线开发 | Mock | 无需网络和服务 |

---

## 🚀 快速开始

### 场景 1: 开发者快速验证

```bash
# 改完代码后快速验证
./scripts/api-test-mock.sh basic

# 输出：
# [PASS] 健康检查
# [PASS] 列出 Workspaces
# [PASS] 列出 Agents
# [PASS] 获取状态
```

### 场景 2: 集成测试

```bash
# 终端 1: 启动 API 服务器
cargo run -p ergatai-api -- --port 3000

# 终端 2: 运行 ACP 测试
./scripts/api-test-acp.sh

# 输出：
# [PASS] ACP Agent 生命周期
# [PASS] 多 ACP Agent 协作
# [PASS] ACP Agent 消息传递
```

### 场景 3: 完整端到端测试

```bash
# 终端 1: 启动 API 服务器
cargo run -p ergatai-api -- --port 3000

# 终端 2: 运行真实测试（需要先注册 agent profile）
./scripts/api-test.sh all
```

---

## 📊 测试报告

所有测试都会生成 JSON 格式的报告：

```bash
# Mock 测试报告
./test-results/mock-test-report-YYYYMMDD-HHMMSS.json

# ACP 测试报告
./test-results/acp-test-report-YYYYMMDD-HHMMSS.json

# 真实测试报告
./test-results/test-report-YYYYMMDD-HHMMSS.json
```

**报告格式**：
```json
[
  {
    "name": "健康检查",
    "status": "passed",
    "timestamp": "2026-10-13T10:30:45Z"
  }
]
```

---

## 🔧 ACP Mock Agent

`scripts/mock-acp-agent.py` 是一个简易的 ACP 协议实现：

**功能**：
- ✅ 处理 `initialize` 请求
- ✅ 处理 `session/start` 请求
- ✅ 处理 `session/prompt` 请求（接收消息）
- ✅ 处理 `tools/list` 请求
- ✅ 处理 `tools/call` 请求
- ✅ 发送通知 (`session/thinking`, `session/started`)
- ✅ 生成模拟响应

**使用**：
```bash
# 直接运行
python3 scripts/mock-acp-agent.py my-agent

# 通过 API 启动
curl -X POST http://localhost:3000/api/v1/agents \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_id": "ws_xxx",
    "agent_name": "test",
    "profile": "mock-acp-agent"
  }'
```

**注册 Profile**：
```bash
curl -X POST http://localhost:3000/api/v1/agent-profiles \
  -H "Content-Type: application/json" \
  -d '{
    "name": "mock-acp-agent",
    "command": "python3",
    "args": ["./scripts/mock-acp-agent.py", "{agent_name}"],
    "instruction": "You are a mock ACP agent for testing."
  }'
```

---

## 🔄 CI/CD 集成

### GitHub Actions

```yaml
name: API Tests

on: [push, pull_request]

jobs:
  mock-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Install dependencies
        run: sudo apt-get install -y jq curl
      
      - name: Run Mock Tests
        run: ./scripts/api-test-mock.sh all
  
  acp-test:
    runs-on: ubuntu-latest
    needs: mock-test
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Rust
        uses: actions-rs/toolchain@v1
        with:
          toolchain: stable
      
      - name: Install dependencies
        run: sudo apt-get install -y jq curl python3
      
      - name: Build and Start API
        run: |
          cargo build -p ergatai-api
          cargo run -p ergatai-api -- --port 3000 &
          echo $! > api.pid
          sleep 10
      
      - name: Run ACP Tests
        run: ./scripts/api-test-acp.sh all
      
      - name: Stop API
        if: always()
        run: kill $(cat api.pid) || true
```

---

## 📚 相关文档

- [API 文档](../API_DOCS.md) - OpenAPI 规范
- [测试框架详细指南](./TESTING_GUIDE.md)
- [项目架构](../CLAUDE.md)

---

## 💡 总结

| 测试类型 | 速度 | 真实性 | 依赖 | 用途 |
|---------|------|--------|------|------|
| Mock | ⚡⚡⚡ | ❌ | 无 | 快速验证 |
| ACP | ⚡⚡ | ✅ | API + Python | 集成测试 |
| 真实 | ⚡ | ✅✅ | API + Agent | 端到端测试 |

**推荐工作流**：
1. 开发时：Mock 测试快速验证
2. 提交前：ACP 测试集成验证
3. 发布前：真实测试完整验证
