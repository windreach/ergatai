# E2E 测试策略

本项目采用**分级测试策略**，平衡测试覆盖率、执行速度和稳定性。

## 测试层级

### 第一层：IPC 测试（tests/ipc/）

**目的**：快速验证核心业务逻辑

**特点**：
- ✅ 通过 test router 直接调用 API
- ✅ 不依赖 UI，执行快速（< 1s/测试）
- ✅ 稳定可靠，无 UI 渲染问题
- ✅ 覆盖核心功能和边界情况

**示例**：
```typescript
const result = await page.evaluate(async () => {
  return await window.trpc.test.agents.create.mutate({
    name: 'test-agent',
    description: 'Test',
    prompt: 'Test prompt',
    source: 'user'
  })
})
expect(result.name).toBe('test-agent')
```

**运行**：
```bash
npm run test:ipc
```

---

### 第二层：E2E UI 测试（tests/e2e/）

**目的**：验证真实用户交互流程

**特点**：
- ✅ 模拟真实用户操作（点击、输入、导航）
- ✅ 验证 UI 渲染和状态管理
- ✅ 覆盖关键业务流程
- ⚠️ 执行较慢（5-15s/测试）
- ⚠️ 可能因 UI 变化而失败

**示例**：
```typescript
// 点击创建按钮
const createButton = await page.waitForSelector('[data-testid="create-button"]')
await createButton.click()

// 填写表单
const nameInput = await page.waitForSelector('input[name="name"]')
await nameInput.fill('test-workspace')

// 提交并验证
await page.click('button[type="submit"]')
await page.waitForSelector('[data-testid="workspace-item"]:has-text("test-workspace")')
```

**运行**：
```bash
npm run test:e2e
```

---

## 测试覆盖原则

### IPC 测试覆盖

- ✅ 所有 CRUD 操作
- ✅ 边界情况（空值、无效输入、并发）
- ✅ 错误处理（异常、超时）
- ✅ 数据一致性

### E2E 测试覆盖

只覆盖**关键用户流程**，避免重复 IPC 测试：

1. **Workspace 创建流程**
   - 点击创建按钮 → 填写表单 → 提交 → 验证 UI 显示

2. **Agent 生命周期**
   - 选择 workspace → 选择 agent → 启动 → 发送消息 → 查看响应 → 停止

3. **对话流程**
   - 创建对话 → 发送消息 → 查看响应 → 多轮对话

4. **错误恢复**
   - 网络失败 → 显示错误提示 → 重试

---

## 为什么需要两层测试？

### 只有 IPC 测试的问题

❌ 无法发现 UI 渲染问题
❌ 无法发现状态管理问题
❌ 无法发现用户交互问题
❌ 无法发现 CSS/布局问题

### 只有 E2E 测试的问题

❌ 执行缓慢（每个测试 5-15s）
❌ 不稳定（UI 变化导致失败）
❌ 调试困难
❌ 编码成本高

### 两层测试的优势

✅ **快速反馈**：IPC 测试 1-2 分钟内完成
✅ **稳定可靠**：核心逻辑由 IPC 测试保证
✅ **真实验证**：E2E 测试验证用户实际体验
✅ **成本优化**：E2E 只覆盖关键路径

---

## 编写测试指南

### IPC 测试

```typescript
// tests/ipc/my-feature.test.ts
describe('IPC: My Feature', () => {
  const ctx = createTestContext()

  test('应该正确处理业务逻辑', async () => {
    const result = await ctx.page.evaluate(async () => {
      return await window.trpc.test.myFeature.doSomething.mutate({
        param: 'value'
      })
    })
    expect(result).toBeDefined()
  })
})
```

### E2E UI 测试

```typescript
// tests/e2e/my-feature-flow.test.ts
describe('E2E: My Feature Flow', () => {
  const ctx = createTestContext()

  test('完整用户流程', async () => {
    // 1. 导航到页面
    await ctx.page.waitForLoadState('networkidle')

    // 2. 触发操作
    await ctx.page.click('[data-testid="start-button"]')

    // 3. 填写表单
    await ctx.page.fill('input[name="field"]', 'value')
    await ctx.page.click('button[type="submit"]')

    // 4. 验证结果
    await ctx.page.waitForSelector('[data-testid="result"]')
    const text = await ctx.page.textContent('[data-testid="result"]')
    expect(text).toContain('expected value')
  })
})
```

---

## 测试数据管理

- **IPC 测试**：使用 test router 的 cleanup 方法
- **E2E 测试**：使用 beforeAll/afterAll 清理临时文件
- **共享数据**：避免测试间依赖，每个测试独立

---

## 常见问题

### Q: 为什么不把所有测试都改成 E2E？

A: E2E 测试执行慢（5-15s vs <1s）、不稳定、调试困难。IPC 测试已经覆盖了核心逻辑，E2E 只需要验证关键用户流程。

### Q: 什么时候应该写 E2E 测试？

A: 
- ✅ 新的用户交互流程
- ✅ UI 状态变化
- ✅ 跨组件交互
- ❌ 纯业务逻辑（用 IPC 测试）
- ❌ API 接口验证（用 IPC 测试）

### Q: E2E 测试失败了怎么办？

A: 
1. 检查是否是 UI 变化导致的（更新选择器）
2. 检查是否是真实 bug（查看控制台错误）
3. 检查是否是测试数据问题（清理后重试）

---

## 当前测试状态

### IPC 测试（tests/ipc/）
- ✅ 21 个测试文件
- ✅ 覆盖核心 CRUD 操作
- ✅ 执行时间：< 30s

### E2E UI 测试（tests/e2e/）
- ⚠️ 2 个示例文件（需要扩展）
- ⚠️ 覆盖关键流程
- ⚠️ 执行时间：~2min

### 假的 UI 测试（tests/ui/）
- ❌ 531 个 page.evaluate 调用
- ❌ 0 个真正的 UI 交互
- ❌ 应该删除或重命名为 "API 集成测试"

---

## 下一步

1. ✅ 删除或重命名 tests/ui/ 中的假测试
2. ✅ 补充更多 E2E 测试（覆盖关键流程）
3. ✅ 添加 CI 配置，自动运行两层测试
4. ✅ 添加测试覆盖率报告
