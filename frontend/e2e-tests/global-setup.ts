/**
 * Global setup for E2E tests
 * Sets default environment variables for Electron testing
 */
export default async function globalSetup() {
  // UI 测试使用 Xvfb 而不是 headless（headless 模式窗口会立即关闭）
  process.env.USE_HEADLESS = process.env.USE_HEADLESS || 'false';
  process.env.USE_XVFB = process.env.USE_XVFB || 'true';
}
