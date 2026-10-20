# CI/CD 集成指南 - Headless 模式

## 为什么 Headless 模式适合 CI/CD？

### ✅ 核心优势

1. **零依赖**：不需要安装 Xvfb、X11 或其他显示服务
2. **快速启动**：无需等待虚拟显示初始化
3. **资源高效**：内存占用减少 30-50%
4. **稳定可靠**：避免 X11 相关的随机错误
5. **易于并行**：可以同时运行多个测试实例
6. **简化配置**：无需设置 DISPLAY 环境变量

### 📊 性能对比

| 场景 | Headless | XVFB | 改进 |
|------|----------|------|------|
| 测试启动时间 | 2-3s | 5-8s | ✅ 60% 快 |
| 内存占用 | ~300MB | ~500MB | ✅ 40% 少 |
| CPU 使用率 | 低 | 中 | ✅ 更高效 |
| 失败率 | <1% | ~5% | ✅ 更稳定 |

---

## GitHub Actions 配置

### 基础配置（推荐）

```yaml
name: E2E Tests

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main ]

jobs:
  test:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v4
    
    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '20'
        cache: 'npm'
        cache-dependency-path: frontend/package.json
    
    - name: Install dependencies
      working-directory: frontend
      run: npm ci
    
    - name: Build frontend
      working-directory: frontend
      run: npm run build
    
    - name: Run E2E tests
      working-directory: frontend
      run: npx playwright test e2e-tests/tests/ipc/
      env:
        CI: true  # Playwright 会自动使用 headless 模式
```

### 高级配置（带后端）

完整的后端 + 前端测试流程，参见 `.github/workflows/e2e-tests.yml`

### 并行测试（加速）

```yaml
jobs:
  test-ipc:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        test-group: [agents, chats, files, ergatai]
    steps:
      # ... 前置步骤 ...
      - name: Run tests
        run: npx playwright test e2e-tests/tests/ipc/${{ matrix.test-group }}*.test.ts
```

---

## GitLab CI 配置

```yaml
stages:
  - test

e2e-tests:
  stage: test
  image: node:20
  
  variables:
    CI: "true"
  
  before_script:
    - cd frontend
    - npm ci
    - npm run build
  
  script:
    - npx playwright test e2e-tests/tests/ipc/
  
  artifacts:
    when: always
    paths:
      - frontend/playwright-report/
      - frontend/test-results/
    expire_in: 7 days
  
  cache:
    key:
      files:
        - frontend/package-lock.json
    paths:
      - frontend/node_modules/
```

---

## Jenkins 配置

```groovy
pipeline {
    agent {
        docker {
            image 'node:20'
        }
    }
    
    environment {
        CI = 'true'
    }
    
    stages {
        stage('Install') {
            steps {
                dir('frontend') {
                    sh 'npm ci'
                }
            }
        }
        
        stage('Build') {
            steps {
                dir('frontend') {
                    sh 'npm run build'
                }
            }
        }
        
        stage('Test') {
            steps {
                dir('frontend') {
                    sh 'npx playwright test e2e-tests/tests/ipc/'
                }
            }
            post {
                always {
                    archiveArtifacts artifacts: 'frontend/playwright-report/**', allowEmptyArchive: true
                }
            }
        }
    }
}
```

---

## Docker 配置

### 自定义 Docker 镜像

```dockerfile
FROM node:20-bullseye

# 安装 Playwright 依赖
RUN npx playwright install-deps chromium

# 安装 Chrome（可选）
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list \
    && apt-get update && apt-get install -y google-chrome-stable

WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# 默认使用 headless 模式
CMD ["npx", "playwright", "test", "e2e-tests/tests/ipc/"]
```

### Docker Compose（测试环境）

```yaml
version: '3.8'

services:
  backend:
    build:
      context: .
      dockerfile: Dockerfile.backend
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 5s
      timeout: 10s
      retries: 5

  e2e-tests:
    build:
      context: ./frontend
      dockerfile: Dockerfile.e2e
    depends_on:
      backend:
        condition: service_healthy
    environment:
      - CI=true
      - BACKEND_URL=http://backend:3000
    volumes:
      - ./test-results:/app/test-results
```

---

## 最佳实践

### ✅ 推荐做法

1. **始终使用 Headless 模式**
   ```bash
   # CI 环境中默认就是 headless
   npx playwright test
   ```

2. **设置合理的超时**
   ```javascript
   // playwright.config.ts
   export default defineConfig({
     timeout: 60000,  // 单个测试超时
     globalTimeout: 600000,  // 总超时
   });
   ```

3. **使用重试机制**
   ```javascript
   export default defineConfig({
     retries: process.env.CI ? 2 : 0,  // CI 环境重试 2 次
   });
   ```

4. **缓存依赖**
   ```yaml
   # GitHub Actions
   - uses: actions/cache@v3
     with:
       path: ~/.npm
       key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
   ```

5. **并行执行**
   ```yaml
   strategy:
     matrix:
       shard: [1/4, 2/4, 3/4, 4/4]
   ```

### ❌ 避免做法

1. ❌ 不要在 CI 中使用 `headed` 模式
2. ❌ 不要禁用并行（除非必要）
3. ❌ 不要硬编码路径
4. ❌ 不要忘记上传测试报告
5. ❌ 不要忽略失败测试

---

## 故障排查

### 常见问题

#### 1. 测试超时
```bash
# 增加超时时间
PLAYWRIGHT_TIMEOUT=120000 npx playwright test
```

#### 2. 内存不足
```bash
# 限制浏览器实例数
npx playwright test --workers=1
```

#### 3. 截图失败
```javascript
// 确保输出目录存在
beforeEach(async () => {
  if (!fs.existsSync('test-results')) {
    fs.mkdirSync('test-results', { recursive: true });
  }
});
```

#### 4. 网络请求失败
```javascript
// 增加重试次数
export default defineConfig({
  use: {
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
});
```

---

## 性能优化

### 1. 使用 Web Server
```javascript
// playwright.config.ts
export default defineConfig({
  webServer: {
    command: 'npm run dev',
    port: 3000,
    timeout: 120000,
    reuseExistingServer: !process.env.CI,
  },
});
```

### 2. 缓存浏览器
```yaml
- name: Cache browsers
  uses: actions/cache@v3
  with:
    path: ~/.cache/ms-playwright
    key: ${{ runner.os }}-playwright-${{ hashFiles('**/package-lock.json') }}
```

### 3. 分片测试
```bash
# 分成 4 个分片并行运行
npx playwright test --shard=1/4
npx playwright test --shard=2/4
npx playwright test --shard=3/4
npx playwright test --shard=4/4
```

---

## 监控和报告

### 测试报告
```yaml
# 上传 HTML 报告
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: playwright-report
    path: playwright-report/
```

### Slack 通知
```yaml
- name: Notify Slack
  if: failure()
  uses: 8398a7/action-slack@v3
  with:
    status: ${{ job.status }}
    text: 'E2E tests failed!'
```

---

## 总结

Headless 模式是 CI/CD 的**最佳选择**：

✅ **零配置** - 开箱即用  
✅ **快速** - 启动和运行更快  
✅ **稳定** - 避免显示相关问题  
✅ **高效** - 资源占用更少  
✅ **可靠** - 测试结果更一致  

**立即集成到你的 CI/CD 流程中！** 🚀
