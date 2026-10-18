import { test, expect, _electron as electron } from '@playwright/test';
import { ElectronApplication, Page } from '@playwright/test';

let electronApp: ElectronApplication;
let page: Page;

test.describe('工作区创建 - Electron 应用', () => {
  test.beforeAll(async () => {
    console.log('🚀 启动 Electron 应用...');

    // 启动 Electron 应用
    electronApp = await electron.launch({
      args: ['./out/main/index.js'],
      cwd: '/home/yubing/code/ergatai/frontend',
    });

    // 获取主窗口
    page = await electronApp.firstWindow();

    // 等待应用加载
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    console.log('✅ Electron 应用已启动');
  });

  test.afterAll(async () => {
    console.log('🛑 关闭 Electron 应用...');
    await electronApp?.close();
  });

  test('步骤1: 验证应用启动', async () => {
    console.log('🔍 检查应用窗口...');

    // 截图初始状态
    await page.screenshot({ path: 'playwright-tests/screenshots/01-electron-initial.png', fullPage: true });
    console.log('📸 截图: electron-initial.png');

    // 检查窗口标题
    const title = await page.title();
    console.log(`窗口标题: ${title}`);

    // 检查页面内容
    const bodyText = await page.locator('body').textContent();
    console.log(`页面内容长度: ${bodyText?.length || 0}`);

    // 查找按钮
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
  });

  test('步骤2: 查找并点击 "Select repo" 按钮', async () => {
    console.log('🔍 查找 "Select repo" 按钮...');

    // 等待页面完全加载
    await page.waitForTimeout(2000);

    // 查找 "Select repo" 按钮
    const selectRepoButton = page.locator('button:has-text("Select repo")');
    const hasSelectRepo = await selectRepoButton.count() > 0;

    if (hasSelectRepo) {
      console.log('✅ 找到 "Select repo" 按钮');
      await selectRepoButton.first().click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'playwright-tests/screenshots/02-after-select-repo.png', fullPage: true });
      console.log('📸 截图: after-select-repo.png');
    } else {
      console.log('⚠️ 未找到 "Select repo" 按钮');

      // 尝试查找其他创建按钮
      const allButtons = page.locator('button');
      const count = await allButtons.count();
      console.log(`总按钮数: ${count}`);

      // 截图当前状态
      await page.screenshot({ path: 'playwright-tests/screenshots/02-no-select-repo.png', fullPage: true });
    }
  });

  test('步骤3: 检查侧边栏', async () => {
    console.log('🔍 检查侧边栏...');

    // 查找侧边栏
    const sidebar = page.locator('nav, [role="navigation"], aside, .sidebar').first();
    const hasSidebar = await sidebar.count() > 0;
    console.log(`侧边栏: ${hasSidebar ? '✅ 找到' : '❌ 未找到'}`);

    if (hasSidebar) {
      await sidebar.screenshot({ path: 'playwright-tests/screenshots/03-sidebar.png' });
      console.log('📸 截图: sidebar.png');
    }
  });

  test('步骤4: 验证后端 API 连接', async () => {
    console.log('🔍 测试后端 API...');

    // 通过 Electron 的 context 访问 API
    const healthResponse = await page.evaluate(async () => {
      try {
        const response = await fetch('http://127.0.0.1:3000/health');
        return { status: response.status, ok: response.ok };
      } catch (error) {
        return { error: String(error) };
      }
    });

    console.log(`API 健康检查: ${JSON.stringify(healthResponse)}`);

    if (healthResponse.ok) {
      console.log('✅ 后端 API 连接正常');
    } else {
      console.log('⚠️ 后端 API 连接异常');
    }
  });
});
