# ACP Agent 启动命令参考

本文档包含所有支持的 ACP agent 的启动命令，分为两类：
- **原生 ACP agent**：无需适配器，直接启动
- **需要适配器的 agent**：通过 ACP 适配器转换

---

## 🟢 原生 ACP Agent（无需适配器）

这些 agent 原生支持 ACP 协议，可以直接通过 `ergatai agent spawn` 启动。

### OpenCode

**安装**: 
```bash
npm install -g opencode
# 或
go install github.com/opencode-ai/opencode@latest
```

**启动命令**:
```bash
ergatai agent spawn my-workspace \
  --command "opencode acp" \
  --instruction "Help me refactor this code"
```

**环境变量**:
- `OPENCODE_MODEL` - 使用的模型（默认：claude-3.5-sonnet）
- `OPENCODE_API_KEY` - API key

**文档**: https://opencode.ai/docs/acp/

---

### Cursor

**安装**: 从 https://cursor.sh 下载

**启动命令**:
```bash
# Cursor 作为 ACP server 运行
ergatai agent spawn my-workspace \
  --command "cursor --acp" \
  --instruction "Review the recent changes"
```

**注意**: Cursor 需要在 GUI 中配置 ACP 支持

---

### Gemini CLI (Google)

**安装**:
```bash
npm install -g @google/gemini-cli
```

**启动命令**:
```bash
ergatai agent spawn my-workspace \
  --command "gemini --acp" \
  --instruction "Analyze the architecture"
```

**环境变量**:
- `GEMINI_API_KEY` - Google AI API key

---

### GitHub Copilot

**状态**: 公共预览中

**安装**: 需要 GitHub Copilot 订阅

**启动命令**:
```bash
ergatai agent spawn my-workspace \
  --command "copilot --acp" \
  --instruction "Suggest improvements"
```

**环境变量**:
- `GITHUB_TOKEN` - GitHub personal access token

---

### JetBrains Junie

**安装**: 内置于 JetBrains IDE

**启动命令**:
```bash
# 通过 JetBrains IDE 启动 ACP
ergatai agent spawn my-workspace \
  --command "junie-acp --project /path/to/project" \
  --instruction "Fix the failing tests"
```

---

### Cline (VS Code)

**安装**: VS Code 扩展市场搜索 "Cline"

**启动命令**:
```bash
ergatai agent spawn my-workspace \
  --command "cline --acp --workspace /path/to/workspace" \
  --instruction "Implement the feature"
```

**环境变量**:
- `OPENAI_API_KEY` 或其他 LLM provider key

---

### Goose (Block)

**安装**:
```bash
npm install -g @block/goose
```

**启动命令**:
```bash
ergatai agent spawn my-workspace \
  --command "goose acp" \
  --instruction "Optimize the database queries"
```

---

### Qwen Code (阿里云通义)

**安装**:
```bash
npm install -g @alibaba/qwen-code
```

**启动命令**:
```bash
ergatai agent spawn my-workspace \
  --command "qwen acp" \
  --instruction "重构认证模块"
```

**环境变量**:
- `DASHSCOPE_API_KEY` - 阿里云 API key

---

### Kiro CLI (AWS)

**安装**:
```bash
npm install -g @aws/kiro-cli
```

**启动命令**:
```bash
ergatai agent spawn my-workspace \
  --command "kiro acp" \
  --instruction "Review security vulnerabilities"
```

**环境变量**:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

---

### Kimi CLI (Moonshot)

**安装**:
```bash
npm install -g @moonshot/kimi-cli
```

**启动命令**:
```bash
ergatai agent spawn my-workspace \
  --command "kimi acp" \
  --instruction "分析代码质量"
```

**环境变量**:
- `MOONSHOT_API_KEY` - Moonshot API key

---

## 🟡 需要适配器的 Agent

这些 agent 不原生支持 ACP，需要通过适配器转换。

### OpenAI Codex CLI

**适配器位置**: `adapters/codex-acp/`

**安装适配器**:
```bash
cd adapters/codex-acp
npm install
npm run build
```

**启动命令**:
```bash
export CODEX_API_KEY=sk-xxx
ergatai agent spawn my-workspace \
  --command "node /root/ergatai/adapters/codex-acp/dist/index.js" \
  --instruction "Fix the bug in main.rs"
```

**环境变量**:
- `CODEX_API_KEY` - OpenAI API key（优先）
- `OPENAI_API_KEY` - OpenAI API key（备用）
- `MODEL_PROVIDER` - 模型提供商
- `INITIAL_AGENT_MODE` - `read-only` | `agent` | `agent-full-access`

**文档**: adapters/codex-acp/README.md

---

### Claude Agent (Anthropic)

**适配器位置**: `adapters/claude-agent-acp/`

**安装适配器**:
```bash
cd adapters/claude-agent-acp
npm install
npm run build
```

**启动命令**:
```bash
export ANTHROPIC_API_KEY=sk-ant-xxx
ergatai agent spawn my-workspace \
  --command "node /root/ergatai/adapters/claude-agent-acp/dist/acp-agent.js" \
  --instruction "Review the code quality"
```

**环境变量**:
- `ANTHROPIC_API_KEY` - Anthropic API key（必需）

**注意**: 需要 Node.js >= 22

**文档**: adapters/claude-agent-acp/README.md

---

### Pi

**适配器位置**: 需要单独安装

**安装适配器**:
```bash
git clone https://github.com/svkozak/pi-acp.git
cd pi-acp
npm install
npm run build
```

**启动命令**:
```bash
ergatai agent spawn my-workspace \
  --command "node /path/to/pi-acp/dist/index.js" \
  --instruction "Help with the task"
```

**GitHub**: https://github.com/svkozak/pi-acp

---

### Bub

**适配器位置**: 需要单独安装

**安装适配器**:
```bash
git clone https://github.com/bubbuild/bub-contrib.git
cd bub-contrib/packages/bub-acp-server
npm install
npm run build
```

**启动命令**:
```bash
ergatai agent spawn my-workspace \
  --command "node /path/to/bub-acp-server/dist/index.js" \
  --instruction "Analyze the code"
```

**GitHub**: https://github.com/bubbuild/bub-contrib

---

## 📋 完整示例：多 Agent 协作

### 示例 1：代码审查流水线

```bash
# 启动 workspace
ergatai workspace create code-review

# 启动 Codex 进行安全分析
export CODEX_API_KEY=sk-xxx
ergatai agent spawn code-review \
  --command "node /root/ergatai/adapters/codex-acp/dist/index.js" \
  --instruction "Analyze src/auth for security vulnerabilities"

# 启动 Claude 进行代码质量审查
export ANTHROPIC_API_KEY=sk-ant-xxx
ergatai agent spawn code-review \
  --command "node /root/ergatai/adapters/claude-agent-acp/dist/acp-agent.js" \
  --instruction "Review code quality and suggest improvements"

# 启动 OpenCode 进行重构
ergatai agent spawn code-review \
  --command "opencode acp" \
  --instruction "Refactor based on analysis results"
```

### 示例 2：DAG 工作流

创建 `workflow.yaml`:
```yaml
name: multi-agent-pipeline
description: 多 agent 协作流程
priority: high
communication: open

tasks:
  - name: security-scan
    agent: codex
    task: "Scan for security vulnerabilities"
    complexity: medium
    timeout: 600

  - name: code-review
    agent: claude
    task: "Review code quality and best practices"
    complexity: medium
    depends_on:
      - security-scan
    timeout: 600

  - name: refactor
    agent: opencode
    task: "Implement improvements"
    complexity: high
    depends_on:
      - security-scan
      - code-review
    timeout: 900
```

提交工作流:
```bash
ergatai dag submit workflow.yaml
```

---

## 🔍 查看可用 Agent

```bash
# 列出所有已注册的 agent
ergatai agent list

# 查看系统状态
ergatai status

# 查看运行中的 agent
curl http://localhost:3000/api/v1/agents | jq .
```

---

## 🛠️ 故障排查

### Agent 无法启动

1. **检查命令是否存在**:
   ```bash
   which opencode
   which gemini
   node --version
   ```

2. **检查 API keys**:
   ```bash
   echo $CODEX_API_KEY
   echo $ANTHROPIC_API_KEY
   echo $OPENAI_API_KEY
   ```

3. **查看 agent 日志**:
   ```bash
   # 启用详细日志
   ERGATAI_LOG_LEVEL=debug ergatai agent spawn ...
   ```

### ACP 连接失败

1. **确认 API 服务器运行中**:
   ```bash
   curl http://localhost:3000/health
   ```

2. **检查 NATS 状态**:
   ```bash
   curl http://localhost:3000/api/v1/status
   ```

3. **重启 API 服务器**:
   ```bash
   pkill -f ergatai-server
   cargo run -p ergatai-api -- --port 3000
   ```

---

## 📚 参考资源

- [ACP 官方文档](https://agentclientprotocol.com/)
- [ACP Agent 列表](https://agentclientprotocol.com/get-started/agents)
- [Ergatai 主文档](../../CLAUDE.md)
- [适配器文档](./README.md)

---

## 💡 提示

1. **优先使用原生 ACP agent**：性能更好，功能更完整
2. **合理分配任务**：根据 agent 特长分配不同类型的任务
3. **设置超时**：为每个 agent 设置合理的超时时间
4. **使用 DAG 工作流**：复杂任务使用 DAG 编排多个 agent
5. **监控通信**：通过 MCP 工具监控 agent 间通信
