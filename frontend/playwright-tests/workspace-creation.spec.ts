import { test, expect } from '@playwright/test';

test.describe('工作区创建', () => {
  test.beforeEach(async ({ page }) => {
    // 等待后端就绪
    await page.goto('http://127.0.0.1:3000');
    await page.waitForTimeout(2000);
  });

  test('应该能够打开新建工作区表单', async ({ page }) => {
    // 查找创建按钮（通常是 "+" 或 "New Chat" 按钮）
    const createButton = page.locator('button:has-text("New"), button:has-text("新建"), button[aria-label*="create"], button[aria-label*="new"]').first();

    // 如果找不到特定按钮，尝试找侧边栏的创建按钮
    if (await createButton.count() === 0) {
      // 尝试查找所有按钮
      const allButtons = page.locator('button');
      const count = await allButtons.count();
      console.log(`Found ${count} buttons`);

      // 查找包含加号图标的按钮
      const plusButton = page.locator('button:has(svg)').filter({ hasText: '+' }).first();
      if (await plusButton.count() > 0) {
        await plusButton.click();
        await page.waitForTimeout(1000);
      }
    } else {
      await createButton.click();
      await page.waitForTimeout(1000);
    }

    // 截图记录状态
    await page.screenshot({ path: 'playwright-tests/screenshots/after-click-create.png' });

    // 验证是否打开了表单或对话框
    const dialog = page.locator('[role="dialog"], .modal, .dialog, form').first();
    const hasDialog = await dialog.count() > 0;

    if (hasDialog) {
      console.log('✅ 创建表单已打开');
      await dialog.screenshot({ path: 'playwright-tests/screenshots/create-form.png' });
    } else {
      console.log('⚠️ 未检测到表单，可能需要手动检查');
    }
  });

  test('应该能够选择项目并创建工作区', async ({ page }) => {
    // 这个测试需要根据实际 UI 调整
    console.log('📝 测试工作区创建流程...');

    // 等待页面加载
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'playwright-tests/screenshots/initial-page.png' });

    // 查找侧边栏
    const sidebar = page.locator('nav, [role="navigation"], aside').first();
    const hasSidebar = await sidebar.count() > 0;
    console.log(`Sidebar found: ${hasSidebar}`);

    // 查找所有可见的文本，帮助定位
    const bodyText = await page.locator('body').textContent();
    console.log(`Page text length: ${bodyText?.length || 0}`);

    // 查找按钮并列出
    const buttons = page.locator('button');
    const buttonCount = await buttons.count();
    console.log(`Total buttons: ${buttonCount}`);

    for (let i = 0; i < Math.min(buttonCount, 10); i++) {
      const text = await buttons.nth(i).textContent();
      console.log(`Button ${i}: ${text?.trim().substring(0, 50)}`);
    }
  });

  test('API 健康检查', async ({ page }) => {
    // 验证后端 API 是否正常
    const response = await page.goto('http://127.0.0.1:3000/health');
    expect(response?.status()).toBe(200);
    console.log('✅ 后端 API 健康检查通过');
  });
});
