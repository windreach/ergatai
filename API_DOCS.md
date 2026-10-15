# Ergatai API 文档

本项目已完全集成 OpenAPI，所有 API 端点都已标注并可通过自动化工具生成文档和测试。

## 📋 OpenAPI 规范

### 获取 OpenAPI JSON

启动 API 服务器后，访问以下端点获取 OpenAPI 规范：

```bash
# 启动服务器
cargo run -p ergatai-api -- --port 3000

# 获取 OpenAPI 规范
curl http://localhost:3000/api/v1/openapi.json > openapi.json
```

### 统计信息

- **端点数**: 133 个 API 端点
- **Schema 数**: 100+ 个数据结构
- **规范版本**: OpenAPI 3.0

## 🚀 快速开始

### 使用脚本工具

我们提供了便捷的脚本工具来生成文档和测试：

```bash
# 生成 OpenAPI JSON
./scripts/api-docs.sh generate

# 启动 Swagger UI（需要 Docker）
./scripts/api-docs.sh swagger

# 生成静态 HTML 文档
./scripts/api-docs.sh html

# 验证 OpenAPI 规范
./scripts/api-docs.sh validate

# 生成测试客户端代码
./scripts/api-docs.sh tests
```

## 🎨 可视化工具

### 1. Swagger UI（推荐）

使用 Docker 快速启动 Swagger UI：

```bash
# 使用脚本
./scripts/api-docs.sh swagger

# 或手动启动
docker run --rm -p 8080:8080 \
  -e SWAGGER_JSON=/spec/openapi.json \
  -v $(pwd):/spec \
  swaggerapi/swagger-ui
```

访问 http://localhost:8080 查看交互式 API 文档。

### 2. Redoc（静态 HTML）

生成独立的 HTML 文档：

```bash
./scripts/api-docs.sh html
# 然后在浏览器中打开 api-docs.html
```

### 3. 在线工具

将 `openapi.json` 上传到以下在线工具：

- [Swagger Editor](https://editor.swagger.io/)
- [Redocly](https://redocly.com/redoc)
- [Stoplight Studio](https://stoplight.io/)

## 🧪 测试工具

### 1. 生成 Rust 测试客户端

```bash
# 安装 openapi-generator
npm install -g @openapitools/openapi-generator-cli

# 生成 Rust 客户端
./scripts/api-docs.sh tests
```

生成的代码在 `./generated-tests` 目录，包含：
- 所有 API 的类型定义
- 请求/响应结构体
- 客户端方法

### 2. Mock 服务器（Prism）

使用 Prism 创建 Mock 服务器进行测试：

```bash
# 安装 Prism
npm install -g @stoplight/prism-cli

# 启动 Mock 服务器
prism mock openapi.json
```

Mock 服务器会在 http://localhost:4010 启动，返回示例响应。

### 3. 契约测试

使用 OpenAPI 规范进行契约测试：

```bash
# 安装 Dredd
npm install -g dredd

# 运行契约测试
dredd openapi.json http://localhost:3000
```

## 🔍 验证规范

验证 OpenAPI 规范的有效性：

```bash
# 使用脚本
./scripts/api-docs.sh validate

# 或使用 swagger-cli
npm install -g @apidevtools/swagger-cli
swagger-cli validate openapi.json
```

## 📚 API 端点分类

### 核心功能

- **Agent 管理** (24 个端点): `/api/v1/agents/*`
  - 启动、停止、暂停、恢复 agent
  - 发送消息、提示、命令
  - 查询状态、输出、工具调用

- **Workspace 管理** (12 个端点): `/api/v1/workspaces/*`
  - 创建、删除、更新 workspace
  - 持久化 workspace 管理

- **Conversation 管理** (10 个端点): `/api/v1/conversations/*`
  - 消息查询、文件变更追踪
  - Agent 输出查看

### 协作功能

- **Collaboration Session** (18 个端点): `/api/v1/collaboration-sessions/*`
  - DAG 工作流编排
  - 计划管理、审批流程
  - 状态转换、事件流

### 基础设施

- **Terminal Session** (10 个端点): `/api/v1/terminal-sessions/*`
  - PTY 终端管理
  - 输入/输出流
  - 审计日志

- **Permissions** (5 个端点): `/api/v1/permissions/*`
  - 权限请求审批
  - 模式切换

- **Locks** (3 个端点): `/api/v1/locks/*`
  - 文件锁管理
  - 审计日志

- **Agent Profiles** (7 个端点): `/api/v1/agent-profiles/*`
  - Agent 模板注册
  - 安装/卸载

- **Activity** (2 个端点): `/api/v1/activity/*`
  - 活动事件查询
  - SSE 实时流

- **Status** (2 个端点): `/api/v1/status/*`
  - 系统状态
  - 后端配置

## 🛠️ 集成到 CI/CD

### GitHub Actions 示例

```yaml
name: API Documentation

on:
  push:
    branches: [main]

jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Rust
        uses: actions-rs/toolchain@v1
        with:
          toolchain: stable
      
      - name: Build API
        run: cargo build -p ergatai-api
      
      - name: Start API Server
        run: |
          cargo run -p ergatai-api -- --port 3000 &
          sleep 5
      
      - name: Generate OpenAPI Spec
        run: ./scripts/api-docs.sh generate
      
      - name: Validate Spec
        run: ./scripts/api-docs.sh validate
      
      - name: Generate HTML Docs
        run: ./scripts/api-docs.sh html
      
      - name: Upload Artifacts
        uses: actions/upload-artifact@v3
        with:
          name: api-docs
          path: |
            openapi.json
            api-docs.html
```

## 📖 参考资源

- [OpenAPI 规范](https://spec.openapis.org/oas/latest.html)
- [utoipa 文档](https://docs.rs/utoipa/latest/utoipa/)
- [Swagger UI](https://swagger.io/tools/swagger-ui/)
- [Redoc](https://redocly.com/redoc)
- [OpenAPI Generator](https://openapi-generator.tech/)

## 🤝 贡献

添加新 API 端点时，请确保：

1. 在 handler 函数上添加 `#[utoipa::path]` 注解
2. 在 `crates/ergatai-api/src/api/openapi.rs` 中注册端点
3. 将请求/响应结构体添加到 `components(schemas(...))` 列表
4. 运行 `cargo test` 确保规范有效

## 📝 许可证

与主项目相同。
