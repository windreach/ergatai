# Ergatai API 自动化测试框架

完整的 API 自动化测试解决方案，支持矩阵测试、多 Agent 协作场景模拟和 DAG 工作流测试。

## 🚀 快速开始

### 前置要求

1. **启动 API 服务器**

```bash
# 终端 1: 启动 API 服务器
cargo run -p ergatai-api -- --port 3000
```

2. **安装依赖工具**

```bash
# 安装 jq (JSON 处理)
sudo apt-get install jq  # Ubuntu/Debian
brew install jq          # macOS

# 安装 curl (通常已预装)
sudo apt-get install curl
```

### 运行测试

```bash
# 运行所有测试
./scripts/api-test.sh

# 或指定 API URL
API_URL=http://localhost:3000 ./scripts/api-test.sh
```

## 📋 测试分类

### 1. 基础 API 测试 (basic)

验证核心 API 端点的可用性：

```bash
./scripts/api-test.sh basic
```

**测试内容**：
- ✅ 健康检查 (`GET /health`)
- ✅ 列出 Workspaces (`GET /api/v1/workspaces`)
- ✅ 列出 Agents (`GET /api/v1/agents`)
- ✅ 获取系统状态 (`GET /api/v1/status`)

**适用场景**：
- 快速验证 API 服务器是否正常运行
- CI/CD 冒烟测试
- 开发环境基本功能检查

### 2. 生命周期测试 (lifecycle)

测试 Workspace 和 Agent 的完整生命周期：

```bash
./scripts/api-test.sh lifecycle
```

**测试内容**：
- ✅ Workspace 创建、查询、删除
- ✅ Agent 启动、状态检查、消息发送、停止
- ✅ 资源清理验证

**适用场景**：
- 验证核心资源管理功能
- 测试资源泄漏
- 验证清理逻辑

### 3. 矩阵测试 (matrix)

多配置组合测试，模拟不同使用场景：

```bash
./scripts/api-test.sh matrix
```

**测试内容**：
- ✅ 协作模式矩阵 (supervisor/group × low/medium/high)
- ✅ Agent 数量矩阵 (1/3/5 个 agent 并发)
- ✅ 资源竞争和并发控制

**适用场景**：
- 压力测试
- 并发场景验证
- 性能基准测试

### 4. 多 Agent 协作测试 (multi)

模拟真实的多 Agent 协作场景：

```bash
./scripts/api-test.sh multi
```

**测试场景**：

#### 场景 1: Supervisor 模式
- 1 个 supervisor agent 协调 2 个 worker agent
- 验证任务分配和协调机制
- 测试 hierarchical 通信模式

#### 场景 2: Group 模式
- 3 个平等 peer agent 协作
- 验证消息广播和同步
- 测试 decentralized 协作

#### 场景 3: Agent 间消息传递
- Agent 之间的直接消息通信
- 验证消息队列和投递机制
- 测试 request/response 模式

**适用场景**：
- 验证协作功能
- 测试通信策略
- 模拟真实工作负载

### 5. DAG 工作流测试 (dag)

测试 DAG 工作流编排功能：

```bash
./scripts/api-test.sh dag
```

**测试内容**：
- ✅ 创建多阶段 DAG 工作流
- ✅ 验证任务依赖关系
- ✅ 测试 DAG 执行和状态跟踪
- ✅ 验证星型通信模式 (star:planner)

**示例 DAG**：
```yaml
name: test-workflow
parameters:
  - name: task
    default: "实现一个简单功能"
tasks:
  - name: planning
    agent: planner
    task: "规划 {{task}}"
  - name: coding
    agent: coder
    task: "实现代码"
    depends_on:
      - planning
  - name: review
    agent: reviewer
    task: "代码审查"
    depends_on:
      - coding
communication: star:planner
```

**适用场景**：
- 验证工作流编排
- 测试任务调度
- 验证依赖解析

## 📊 测试报告

测试完成后生成 JSON 格式的详细报告：

```bash
# 报告位置
./test-results/test-report-YYYYMMDD-HHMMSS.json
```

**报告内容**：
```json
[
  {
    "name": "健康检查",
    "status": "passed",
    "timestamp": "2026-10-13T10:30:45Z"
  },
  {
    "name": "Workspace 生命周期",
    "status": "passed",
    "timestamp": "2026-10-13T10:30:46Z"
  }
]
```

**状态说明**：
- `passed` - 测试通过 ✅
- `failed` - 测试失败 ❌
- `skipped` - 测试跳过 ⚠️

## 🔧 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `API_URL` | `http://localhost:3000` | API 服务器 URL |
| `TEST_DIR` | `./test-results` | 测试结果目录 |

**示例**：
```bash
API_URL=http://192.168.1.100:3000 ./scripts/api-test.sh
```

## 🧪 自定义测试

### 添加新测试用例

在 `scripts/api-test.sh` 中添加测试函数：

```bash
test_my_custom_scenario() {
    log_info "测试我的自定义场景"
    
    # 创建测试资源
    local workspace_id=$(create_test_workspace)
    
    # 执行测试逻辑
    # ...
    
    # 清理
    cleanup_test_workspace "$workspace_id"
    
    return 0
}
```

然后在 `run_all_tests()` 或相应的 `case` 分支中调用：

```bash
run_test "我的自定义场景" test_my_custom_scenario
```

### 辅助函数

脚本提供了以下辅助函数：

```bash
# 创建测试 workspace
create_test_workspace

# 清理测试 workspace
cleanup_test_workspace $workspace_id

# 启动测试 agent
spawn_test_agent $workspace_id "agent-name"

# 清理多个 agent
cleanup_agents $agent1_id $agent2_id $agent3_id

# HTTP 请求（带状态码验证）
http_request GET "/api/v1/endpoint"
http_request POST "/api/v1/endpoint" "$json_data" 201
```

## 🔄 CI/CD 集成

### GitHub Actions

```yaml
name: API Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Rust
        uses: actions-rs/toolchain@v1
        with:
          toolchain: stable
      
      - name: Install dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y jq curl
      
      - name: Build API
        run: cargo build -p ergatai-api
      
      - name: Start API Server
        run: |
          cargo run -p ergatai-api -- --port 3000 &
          echo $! > api.pid
          sleep 10
      
      - name: Run Basic Tests
        run: ./scripts/api-test.sh basic
      
      - name: Run Lifecycle Tests
        run: ./scripts/api-test.sh lifecycle
      
      - name: Run Matrix Tests
        run: ./scripts/api-test.sh matrix
      
      - name: Stop API Server
        if: always()
        run: kill $(cat api.pid) || true
      
      - name: Upload Test Results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: test-results
          path: test-results/
```

### GitLab CI

```yaml
stages:
  - test

api-tests:
  stage: test
  image: rust:latest
  before_script:
    - apt-get update && apt-get install -y jq curl
    - cargo build -p ergatai-api
    - cargo run -p ergatai-api -- --port 3000 &
    - sleep 10
  script:
    - ./scripts/api-test.sh all
  artifacts:
    paths:
      - test-results/
    when: always
```

## 📈 测试最佳实践

### 1. 分层测试策略

```bash
# 快速冒烟测试（每次提交）
./scripts/api-test.sh basic

# 功能验证（每次 PR）
./scripts/api-test.sh basic
./scripts/api-test.sh lifecycle

# 完整测试（发布前）
./scripts/api-test.sh all
```

### 2. 性能测试

```bash
# 测试不同 agent 数量
for i in 1 5 10 20; do
  echo "Testing $i agents..."
  # 修改 test_matrix_agent_counts 中的数量
  ./scripts/api-test.sh matrix
done
```

### 3. 压力测试

```bash
# 并发运行多个测试实例
for i in {1..5}; do
  ./scripts/api-test.sh multi &
done
wait
```

### 4. 监控和日志

```bash
# 将测试输出保存到文件
./scripts/api-test.sh all 2>&1 | tee test-run-$(date +%Y%m%d).log

# 分析测试结果
jq '.[] | select(.status == "failed")' test-results/test-report-*.json
```

## 🐛 故障排除

### 问题 1: API 服务器连接失败

```bash
# 检查服务器是否运行
curl http://localhost:3000/health

# 检查端口占用
lsof -i :3000

# 重启服务器
pkill -f ergatai-api
cargo run -p ergatai-api -- --port 3000
```

### 问题 2: jq 命令未找到

```bash
# Ubuntu/Debian
sudo apt-get install jq

# macOS
brew install jq

# CentOS/RHEL
sudo yum install jq
```

### 问题 3: 测试超时

```bash
# 增加等待时间（编辑脚本）
sleep 5  # 改为 sleep 10

# 或跳过某些测试
./scripts/api-test.sh basic lifecycle
```

### 问题 4: 权限错误

```bash
# 确保脚本可执行
chmod +x scripts/api-test.sh

# 检查临时目录权限
ls -ld /tmp/ergatai-test-*
```

## 📚 相关文档

- [API 文档](../API_DOCS.md) - OpenAPI 规范和使用指南
- [API 文档工具](./api-docs.sh) - 文档生成和可视化
- [CLAUDE.md](../CLAUDE.md) - 项目架构和 API 说明

## 🤝 贡献

添加新的测试场景时：

1. 在相应的测试分类下添加测试函数
2. 使用 `run_test` 包装测试调用
3. 确保测试后清理所有资源
4. 更新此文档说明新测试
5. 运行测试验证功能

## 📝 许可证

与主项目相同。
