# Ergatai Agent 快速启动指南

## 🚀 立即可用（已配置完成）

### 1. OpenAI Codex CLI

**前置条件**：
```bash
export CODEX_API_KEY=sk-xxx  # 你的 OpenAI API key
```

**启动命令**：
```bash
# 创建 workspace（如果还没有）
ergatai workspace create my-project

# 启动 Codex agent
ergatai agent spawn my-project \
  --command "node /root/ergatai/adapters/codex-acp/dist/index.js" \
  --instruction "分析这个代码库并建议改进"
```

**验证**：
```bash
ergatai agent list  # 应该看到 agent 在运行
```

---

### 2. Anthropic Claude

**前置条件**：
```bash
export ANTHROPIC_API_KEY=sk-ant-xxx  # 你的 Anthropic API key
```

**启动命令**：
```bash
# 启动 Claude agent
ergatai agent spawn my-project \
  --command "node /root/ergatai/adapters/claude-agent-acp/dist/acp-agent.js" \
  --instruction "审查最近的代码变更"
```

---

## 📋 多 Agent 协作示例

### 示例 1：代码审查流水线

```bash
# 1. 创建 workspace
ergatai workspace create code-review

# 2. 启动 Codex 进行安全分析
export CODEX_API_KEY=sk-xxx
ergatai agent spawn code-review \
  --command "node /root/ergatai/adapters/codex-acp/dist/index.js" \
  --instruction "扫描 src/ 目录的安全漏洞"

# 3. 启动 Claude 进行代码质量审查
export ANTHROPIC_API_KEY=sk-ant-xxx
ergatai agent spawn code-review \
  --command "node /root/ergatai/adapters/claude-agent-acp/dist/acp-agent.js" \
  --instruction "评估代码质量和最佳实践"

# 4. 查看运行中的 agent
ergatai agent list
```

### 示例 2：使用 DAG 工作流

创建 `workflow.yaml`：
```yaml
name: code-analysis
description: 多 agent 代码分析
priority: high
communication: open

tasks:
  - name: security-scan
    agent: codex
    task: "扫描安全漏洞"
    complexity: medium
    timeout: 600

  - name: quality-review
    agent: claude
    task: "审查代码质量"
    complexity: medium
    depends_on:
      - security-scan
    timeout: 600
```

提交工作流：
```bash
ergatai dag submit workflow.yaml
ergatai dag list  # 查看状态
```

---

## 🔧 常用管理命令

```bash
# 系统状态
ergatai status

# 列出所有 workspace
ergatai workspace list

# 列出所有 agent
ergatai agent list

# 查看 agent 详情
curl http://localhost:3000/api/v1/agents | jq .

# 停止 API 服务器
pkill -f ergatai-server

# 启动 API 服务器
cargo run -p ergatai-api -- --port 3000
```

---

## 📚 其他 Agent（需要安装）

以下 agent 原生支持 ACP，但需要先安装：

### OpenCode（推荐）
```bash
# 安装
npm install -g opencode

# 启动（待验证）
ergatai agent spawn my-project \
  --command "opencode acp" \
  --instruction "帮助重构代码"
```

### Gemini CLI
```bash
# 安装
npm install -g @google/gemini-cli

# 启动（待验证）
export GEMINI_API_KEY=xxx
ergatai agent spawn my-project \
  --command "gemini --acp" \
  --instruction "分析架构"
```

---

## ⚠️ 故障排查

### Agent 无法启动

1. **检查 API 服务器**：
   ```bash
   curl http://localhost:3000/health
   ```

2. **检查 API keys**：
   ```bash
   echo $CODEX_API_KEY
   echo $ANTHROPIC_API_KEY
   ```

3. **查看日志**：
   ```bash
   # 启用 debug 日志
   RUST_LOG=debug ergatai agent spawn ...
   ```

### 适配器问题

```bash
# 重新构建适配器
cd /root/ergatai/adapters/codex-acp
npm install && npm run build

cd /root/ergatai/adapters/claude-agent-acp
npm install && npm run build
```

---

## 📖 完整文档

- **适配器使用指南**：`adapters/README.md`
- **所有 Agent 命令参考**：`adapters/agent-commands.md`
- **配置脚本**：`adapters/setup.sh`
