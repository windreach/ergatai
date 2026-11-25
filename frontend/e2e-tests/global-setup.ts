/**
 * Global setup for E2E tests
 * Sets default environment variables for Electron testing
 */
export default async function globalSetup() {
  // Default to headless Electron (Playwright uses --headless=new). Override with
  // USE_HEADLESS=false and USE_XVFB=true when a visible window / Xvfb is required.
  process.env.USE_HEADLESS = process.env.USE_HEADLESS || 'true';
  process.env.USE_XVFB = process.env.USE_XVFB || 'false';
}
