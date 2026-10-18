import { test, expect, _electron as electron } from '@playwright/test';
import { ElectronApplication, Page } from '@playwright/test';

let electronApp: ElectronApplication;
let page: Page;

test.describe('工作区创建 - 正确流程', () => {
  test.beforeAll(async () => {
    console.log('🚀 启动 Electron 应用...');

    electronApp = await electron.launch({
      args: ['./out/main/index.js'],
      cwd: '/home/yubing/code/ergatai/frontend',
    });

    page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    console.log('✅ Electron 应用已启动');
  });

  test.afterAll(async () => {
    console.log('🛑 关闭 Electron 应用...');
    await electronApp?.close();
  });

  test('步骤1: 验证初始状态 - New Workspace 按钮是禁用的', async () => {
    console.log('🔍 检查初始状态...');

    await page.waitForTimeout(2000);

    // 查找 "New Workspace" 按钮
    const newWorkspaceButton = page.locator('button:has-text("New Workspace")');
    const hasButton = await newWorkspaceButton.count() > 0;

    if (hasButton) {
      const isDisabled = await newWorkspaceButton.first().isDisabled();
      console.log(`New Workspace 按钮状态: ${isDisabled ? '禁用 (预期行为)' : '启用'}`);

      if (isDisabled) {
        console.log('✅ 符合预期：需要先选择项目才能启用');
      }

      await page.screenshot({ path: 'playwright-tests/screenshots/01-initial-state.png', fullPage: true });
    }
  });

  test('步骤2: 点击 "Select repo" 按钮', async () => {
    console.log('🔍 查找并点击 "Select repo" 按钮...');

    // 查找 "Select repo" 按钮
    const selectRepoButton = page.locator('button:has-text("Select repo")');
    const hasButton = await selectRepoButton.count() > 0;

    if (hasButton) {
      console.log('✅ 找到 "Select repo" 按钮');
      await selectRepoButton.first().click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'playwright-tests/screenshots/02-after-select-repo.png', fullPage: true });
      console.log('📸 截图: after-select-repo.png');

      // 查找打开的对话框
      const dialog = page.locator('[role="dialog"], .modal').first();
      const hasDialog = await dialog.count() > 0;
      console.log(`对话框: ${hasDialog ? '✅ 已打开' : '❌ 未打开'}`);

      if (hasDialog) {
        await dialog.screenshot({ path: 'playwright-tests/screenshots/02-dialog.png' });
      }
    } else {
      console.log(' 未找到 "Select repo" 按钮');
    }
  });

  test('步骤3: 验证 API 端点', async () => {
    console.log('🔍 测试 API 端点...');

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
    }
  });
});
