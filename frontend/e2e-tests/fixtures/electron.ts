/**
 * Playwright Electron 测试 fixtures
 * 提供 Electron 应用的标准初始化和清理
 */

import { test as base, _electron, ElectronApplication, Page } from '@playwright/test';

export const test = base.extend<{
  electronApp: ElectronApplication;
  page: Page;
}>({
  electronApp: async ({}, use) => {
    // 启动 Electron 应用
    const electronApp = await _electron.launch({
      executablePath: process.env.ELECTRON_PATH || '/root/ergatai/frontend/node_modules/electron/dist/electron',
      args: [
        process.env.FRONTEND_DIR || '/root/ergatai/frontend',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
      ],
      env: {
        ...process.env,
        'DISPLAY': process.env.DISPLAY || ':99',
        'ELECTRON_DISABLE_SANDBOX': 'true',
      },
    });

    await use(electronApp);

    // 清理
    await electronApp.close();
  },

  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();

    // 等待应用完全加载
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    await page.waitForTimeout(1000); // 额外等待渲染完成

    await use(page);
  },
});

export { expect } from '@playwright/test';
