import { test, expect, _electron as electron } from '@playwright/test';
import { ElectronApplication, Page } from '@playwright/test';

let electronApp: ElectronApplication;
let page: Page;

test.describe('工作区创建 - 完整流程', () => {
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

  test('步骤1: 点击 "New Workspace" 按钮', async () => {
    console.log('🔍 查找 "New Workspace" 按钮...');

    await page.waitForTimeout(2000);

    // 查找 "New Workspace" 按钮
    const newWorkspaceButton = page.locator('button:has-text("New Workspace")');
    const hasButton = await newWorkspaceButton.count() > 0;

    if (hasButton) {
      console.log('✅ 找到 "New Workspace" 按钮');
      await newWorkspaceButton.first().click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'playwright-tests/screenshots/01-after-new-workspace.png', fullPage: true });
      console.log('📸 截图: after-new-workspace.png');

      // 查找表单或对话框
      const dialog = page.locator('[role="dialog"], .modal, form').first();
      const hasDialog = await dialog.count() > 0;
      console.log(`表单/对话框: ${hasDialog ? '✅ 已打开' : '❌ 未打开'}`);

      if (hasDialog) {
        await dialog.screenshot({ path: 'playwright-tests/screenshots/01-dialog.png' });
      }
    } else {
      console.log('❌ 未找到 "New Workspace" 按钮');
    }
  });

  test('步骤2: 检查表单字段', async () => {
    console.log('🔍 检查表单字段...');

    // 查找输入框
    const inputs = page.locator('input, textarea, select');
    const inputCount = await inputs.count();
    console.log(`📊 找到 ${inputCount} 个输入框`);

    // 查找标签
    const labels = page.locator('label');
    const labelCount = await labels.count();
    console.log(`📊 找到 ${labelCount} 个标签`);

    // 打印标签文本
    for (let i = 0; i < Math.min(labelCount, 10); i++) {
      const text = await labels.nth(i).textContent();
      if (text) {
        console.log(`  标签 ${i}: "${text.trim().substring(0, 50)}"`);
      }
    }

    await page.screenshot({ path: 'playwright-tests/screenshots/02-form-fields.png', fullPage: true });
  });

  test('步骤3: 查找项目选择器', async () => {
    console.log('🔍 查找项目选择器...');

    // 查找 "Select repo" 或项目选择相关按钮
    const selectRepoButton = page.locator('button:has-text("Select repo"), button:has-text("Select project"), button:has-text("Browse")');
    const hasSelectRepo = await selectRepoButton.count() > 0;

    if (hasSelectRepo) {
      console.log('✅ 找到项目选择按钮');
      const text = await selectRepoButton.first().textContent();
      console.log(`按钮文本: ${text}`);
    } else {
      console.log('⚠️ 未找到项目选择按钮，查找其他选择器...');

      // 查找下拉菜单或选择框
      const selects = page.locator('select, [role="combobox"], [role="listbox"]');
      const selectCount = await selects.count();
      console.log(`选择器数量: ${selectCount}`);
    }
  });

  test('步骤4: 查找提交按钮', async () => {
    console.log('🔍 查找提交按钮...');

    // 查找提交按钮
    const submitButton = page.locator('button[type="submit"], button:has-text("Create"), button:has-text("Submit"), button:has-text("Save")');
    const hasSubmit = await submitButton.count() > 0;

    if (hasSubmit) {
      console.log('✅ 找到提交按钮');
      const text = await submitButton.first().textContent();
      console.log(`按钮文本: ${text}`);

      // 检查按钮是否禁用
      const isDisabled = await submitButton.first().isDisabled();
      console.log(`按钮状态: ${isDisabled ? '禁用' : '可用'}`);
    } else {
      console.log('⚠️ 未找到提交按钮');
    }

    await page.screenshot({ path: 'playwright-tests/screenshots/04-submit-button.png', fullPage: true });
  });

  test('步骤5: 验证 API 端点', async () => {
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
