# ACP Adapters for Ergatai

本目录包含 ACP (Agent Client Protocol) 适配器，用于将不支持原生 ACP 的 AI coding agent 集成到 Ergatai 多 agent 协作平台。

## 已安装的适配器

### 1. Codex CLI Adapter (OpenAI)

**位置**: `adapters/codex-acp/`  
**版本**: 1.10.0  
**GitHub**: https://github.com/agentclientprotocol/codex-acp

**功能**:
- 将 OpenAI Codex CLI 转换为 ACP agent
- 支持 ChatGPT 登录、API key 认证
- 支持模型配置、推理强度、快速模式
- 支持文件编辑、shell 命令、MCP 工具调用
- 支持子 agent 会话和后台任务

**使用方法**:
```bash
# 直接启动
cd adapters/codex-acp
node dist/index.js

# 或通过 Ergatai CLI 启动
ergatai agent spawn my-workspace \
  --command "node /root/ergatai/adapters/codex-acp/dist/index.js" \
  --instruction "Fix the bug in main.rs"

# 设置 API key
export CODEX_API_KEY=your-api-key-here
# 或
export OPENAI_API_KEY=your-api-key-here
```

**环境变量**:
- `CODEX_API_KEY` - OpenAI API key（优先）
- `OPENAI_API_KEY` - OpenAI API key（备用）
- `CODEX_PATH` - 自定义 Codex 可执行文件路径
- `MODEL_PROVIDER` - 模型提供商
- `INITIAL_AGENT_MODE` - 初始模式：`read-only`, `agent`, `agent-full-access`
- `NO_BROWSER` - 禁用浏览器认证（远程环境）

---

### 2. Claude Agent Adapter (Anthropic)

**位置**: `adapters/claude-agent-acp/`  
**版本**: 0.75.1  
**GitHub**: https://github.com/zed-industries/claude-agent-acp

**功能**:
- 将 Claude Agent SDK 转换为 ACP agent
- 支持 Context @-mentions
- 支持图片、工具调用、权限请求
- 支持子 agent 事务
- 支持交互式终端和后台终端
- 支持自定义 Slash 命令

**使用方法**:
```bash
# 直接启动
cd adapters/claude-agent-acp
node dist/acp-agent.js

# 或通过 Ergatai CLI 启动
ergatai agent spawn my-workspace \
  --command "node /root/ergatai/adapters/claude-agent-acp/dist/acp-agent.js" \
  --instruction "Refactor the authentication module"

# 设置 API key
export ANTHROPIC_API_KEY=your-api-key-here
```

**环境变量**:
- `ANTHROPIC_API_KEY` - Anthropic API key（必需）

**注意**: 此适配器需要 Node.js >= 22，当前系统版本为 Node.js 20.20.2。虽然可以构建和运行，但建议升级到 Node.js 22+ 以获得最佳兼容性。

---

## 快速开始

### 1. 启动 Ergatai API 服务器

```bash
cargo run -p ergatai-api -- --port 3000
```

### 2. 创建 Workspace

```bash
ergatai workspace create my-project
```

### 3. 启动 Codex Agent

```bash
export CODEX_API_KEY=your-openai-api-key
ergatai agent spawn my-project \
  --command "node /root/ergatai/adapters/codex-acp/dist/index.js" \
  --instruction "Analyze the codebase and suggest improvements"
```

### 4. 启动 Claude Agent

```bash
export ANTHROPIC_API_KEY=your-anthropic-api-key
ergatai agent spawn my-project \
  --command "node /root/ergatai/adapters/claude-agent-acp/dist/acp-agent.js" \
  --instruction "Review the recent changes and provide feedback"
```

### 5. Agent 间通信

通过 MCP 协议发送消息：

```bash
curl -X POST http://localhost:3000/mcp/agent-1 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "send_message",
      "arguments": {
        "target_agent_id": "agent-2",
        "message": "Please review my changes",
        "message_type": "request"
      }
    }
  }'
```

---

## 提交 DAG 工作流

创建多 agent 协作工作流：

```yaml
# workflow.yaml
name: code-review-pipeline
description: 多 agent 代码审查流程
priority: high
communication: open

parameters:
  - name: target_module
    default: "src/auth"

tasks:
  - name: analyze
    agent: codex
    task: "Analyze {{target_module}} for security vulnerabilities and performance issues"
    complexity: medium
    timeout: 600

  - name: review
    agent: claude
    task: "Review the code quality and suggest improvements for {{target_module}}"
    complexity: medium
    depends_on:
      - analyze
    timeout: 600

  - name: fix
    agent: codex
    task: "Implement the fixes based on analysis and review results"
    complexity: high
    depends_on:
      - analyze
      - review
    timeout: 900
```

提交工作流：

```bash
ergatai dag submit workflow.yaml
```

---

## 原生 ACP Agent（推荐）

如果可能，建议使用原生支持 ACP 的 agent，无需适配器：

- **OpenCode**: `opencode acp`
- **Cursor**: 内置支持
- **Gemini CLI**: 原生 ACP
- **GitHub Copilot**: 公共预览中

示例：
```bash
# OpenCode（原生支持）
ergatai agent spawn my-workspace \
  --command "opencode acp" \
  --instruction "Help me refactor this code"
```

---

## 故障排查

### Codex Adapter 无法启动

1. 检查 API key 是否设置：
   ```bash
   echo $CODEX_API_KEY
   ```

2. 查看适配器日志：
   ```bash
   APP_SERVER_LOGS=/tmp/codex-logs node adapters/codex-acp/dist/index.js
   ```

3. 检查 Node.js 版本（建议 >= 18）：
   ```bash
   node --version
   ```

### Claude Adapter 无法启动

1. 检查 API key：
   ```bash
   echo $ANTHROPIC_API_KEY
   ```

2. 升级 Node.js 到 22+（推荐）：
   ```bash
   # 使用 nvm
   nvm install 22
   nvm use 22
   ```

3. 检查依赖：
   ```bash
   cd adapters/claude-agent-acp
   npm install
   npm run build
   ```

### Agent 无法通信

1. 确认 API 服务器运行中：
   ```bash
   curl http://localhost:3000/health
   ```

2. 检查 agent 列表：
   ```bash
   ergatai agent list
   ```

3. 查看 NATS 状态：
   ```bash
   curl http://localhost:3000/api/v1/status
   ```

---

## 更新适配器

```bash
# 更新 Codex adapter
cd adapters/codex-acp
git pull
npm install
npm run build

# 更新 Claude adapter
cd adapters/claude-agent-acp
git pull
npm install
npm run build
```

---

## 参考文档

- [ACP 官方网站](https://agentclientprotocol.com/)
- [Codex Adapter GitHub](https://github.com/agentclientprotocol/codex-acp)
- [Claude Adapter GitHub](https://github.com/zed-industries/claude-agent-acp)
- [Ergatai 文档](../../CLAUDE.md)

---

## 许可证

- Codex Adapter: 见 `adapters/codex-acp/LICENSE`
- Claude Adapter: Apache 2.0 - 见 `adapters/claude-agent-acp/LICENSE`
