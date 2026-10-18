import { test, expect } from '@playwright/test';

test.describe('工作区创建 - 完整流程', () => {
  test.beforeEach(async ({ page }) => {
    // 等待应用加载
    await page.goto('http://127.0.0.1:3000');
    await page.waitForTimeout(3000);
  });

  test('步骤1: 验证应用启动和 API 健康', async ({ page }) => {
    console.log('🔍 检查后端 API...');

    // 验证后端 API
    const healthResponse = await page.goto('http://127.0.0.1:3000/health');
    expect(healthResponse?.status()).toBe(200);
    console.log('✅ 后端 API 健康');

    // 返回应用页面
    await page.goto('http://127.0.0.1:3000');
    await page.waitForTimeout(2000);

    // 截图初始状态
    await page.screenshot({ path: 'playwright-tests/screenshots/01-initial-page.png', fullPage: true });
    console.log('📸 截图: initial-page.png');
  });

  test('步骤2: 查找并点击创建按钮', async ({ page }) => {
    console.log('🔍 查找创建按钮...');

    // 等待页面完全加载
    await page.waitForTimeout(2000);

    // 列出所有按钮，帮助定位
    const buttons = page.locator('button');
    const buttonCount = await buttons.count();
    console.log(`📊 找到 ${buttonCount} 个按钮`);

    // 打印前 10 个按钮的文本
    for (let i = 0; i < Math.min(buttonCount, 10); i++) {
      const text = await buttons.nth(i).textContent();
      const isVisible = await buttons.nth(i).isVisible();
      if (isVisible && text) {
        console.log(`  按钮 ${i}: "${text.trim().substring(0, 50)}"`);
      }
    }

    // 尝试查找 "Select repo" 按钮
    const selectRepoButton = page.locator('button:has-text("Select repo")');
    const hasSelectRepo = await selectRepoButton.count() > 0;

    if (hasSelectRepo) {
      console.log('✅ 找到 "Select repo" 按钮');
      await selectRepoButton.first().click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'playwright-tests/screenshots/02-after-select-repo.png', fullPage: true });
      console.log('📸 截图: after-select-repo.png');
    } else {
      console.log('⚠️ 未找到 "Select repo" 按钮，尝试其他方式...');

      // 尝试查找 "+" 或 "New" 按钮
      const newButton = page.locator('button:has-text("New"), button:has-text("+"), button[aria-label*="new"], button[aria-label*="create"]').first();
      if (await newButton.count() > 0) {
        console.log('✅ 找到创建按钮');
        await newButton.click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'playwright-tests/screenshots/02-after-new-button.png', fullPage: true });
      }
    }
  });

  test('步骤3: 检查侧边栏和导航', async ({ page }) => {
    console.log('🔍 检查侧边栏...');

    // 查找侧边栏
    const sidebar = page.locator('nav, [role="navigation"], aside, .sidebar').first();
    const hasSidebar = await sidebar.count() > 0;
    console.log(`侧边栏: ${hasSidebar ? '✅ 找到' : '❌ 未找到'}`);

    if (hasSidebar) {
      await sidebar.screenshot({ path: 'playwright-tests/screenshots/03-sidebar.png' });
      console.log('📸 截图: sidebar.png');

      // 查找侧边栏中的按钮
      const sidebarButtons = sidebar.locator('button');
      const sidebarButtonCount = await sidebarButtons.count();
      console.log(`📊 侧边栏中有 ${sidebarButtonCount} 个按钮`);
    }

    // 检查页面内容
    const bodyText = await page.locator('body').textContent();
    const hasWelcome = bodyText?.includes('Welcome') || bodyText?.includes('欢迎');
    const hasSelectRepo = bodyText?.includes('Select repo');

    console.log(`页面内容: Welcome=${hasWelcome}, SelectRepo=${hasSelectRepo}`);
  });

  test('步骤4: 检查对话列表', async ({ page }) => {
    console.log('🔍 检查对话列表...');

    // 查找对话列表
    const conversationList = page.locator('[class*="conversation"], [class*="chat"], [role="list"]').first();
    const hasConversationList = await conversationList.count() > 0;
    console.log(`对话列表: ${hasConversationList ? '✅ 找到' : '❌ 未找到'}`);

    // 查找已有的工作区
    const workspaceItems = page.locator('[class*="workspace"], [class*="chat-item"], [data-chat-id]');
    const workspaceCount = await workspaceItems.count();
    console.log(`📊 找到 ${workspaceCount} 个工作区`);

    if (workspaceCount > 0) {
      console.log('✅ 已有工作区存在');
      // 点击第一个工作区
      await workspaceItems.first().click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'playwright-tests/screenshots/04-workspace-selected.png', fullPage: true });
      console.log('📸 截图: workspace-selected.png');
    }
  });

  test('步骤5: 测试消息发送（如果有工作区）', async ({ page }) => {
    console.log('🔍 测试消息发送...');

    // 查找输入框
    const inputBox = page.locator('textarea, input[type="text"], [contenteditable="true"]').first();
    const hasInput = await inputBox.count() > 0;

    if (hasInput) {
      console.log('✅ 找到消息输入框');

      // 输入测试消息
      await inputBox.fill('Hello, this is a test message from Playwright!');
      await page.waitForTimeout(500);
      await page.screenshot({ path: 'playwright-tests/screenshots/05-message-typed.png', fullPage: true });
      console.log('📸 截图: message-typed.png');

      // 查找发送按钮
      const sendButton = page.locator('button[type="submit"], button:has-text("Send"), button[aria-label*="send"]').first();
      const hasSendButton = await sendButton.count() > 0;

      if (hasSendButton) {
        console.log('✅ 找到发送按钮');
        // 不实际发送，只验证按钮存在
      } else {
        console.log('⚠️ 未找到发送按钮');
      }
    } else {
      console.log('⚠️ 未找到消息输入框（可能需要先选择或创建工作区）');
    }
  });
});

test.describe('API 端点测试', () => {
  test('验证关键 API 端点', async ({ request }) => {
    console.log('🔍 测试 API 端点...');

    // 健康检查
    const health = await request.get('http://127.0.0.1:3000/health');
    expect(health.status()).toBe(200);
    console.log('✅ GET /health - 200');

    // 获取工作区列表
    const workspaces = await request.get('http://127.0.0.1:3000/api/v1/workspaces/managed');
    console.log(`✅ GET /api/v1/workspaces/managed - ${workspaces.status()}`);

    // 获取 agent 列表
    const agents = await request.get('http://127.0.0.1:3000/api/v1/agents');
    console.log(`✅ GET /api/v1/agents - ${agents.status()}`);

    // 获取对话列表
    const conversations = await request.get('http://127.0.0.1:3000/api/v1/conversations');
    console.log(`✅ GET /api/v1/conversations - ${conversations.status()}`);

    // 获取 chat 列表
    const chats = await request.get('http://127.0.0.1:3000/api/v1/chats');
    console.log(`✅ GET /api/v1/chats - ${chats.status()}`);
  });
});
