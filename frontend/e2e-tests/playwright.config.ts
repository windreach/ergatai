import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,  // Electron 应用只能串行
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,  // Electron 只能 1 个 worker
  reporter: [
    ['html', { output: './reports/html-report' }],
    ['list'],
    ['json', { outputFile: './reports/test-results.json' }]
  ],
  timeout: 60000,
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10000,
    navigationTimeout: 30000,
  },
  globalSetup: './global-setup.ts',  // 设置环境变量，默认使用 Xvfb
  projects: [
    {
      name: 'electron',
      testMatch: /.*\.test\.ts/,  // 匹配 .test.ts 文件
    },
  ],
});
