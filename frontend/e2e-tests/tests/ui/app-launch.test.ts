// spec: specs/ergatai-electron-ui-test-plan.md
// scenarios: UI-NAV-001

import { test, expect, type Page } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"

test.describe.serial("App launch (Ergatai Electron UI)", () => {
  let electron!: Awaited<ReturnType<typeof launchElectron>>
  let page!: Page

  test.beforeAll(async () => {
    electron = await launchElectron({
      extraEnv: { NODE_ENV: "test", ELECTRON_TEST_MODE: "true" },
    })
    page = electron.page
  })

  test.afterAll(async () => {
    await electron?.close()
  })

  test.beforeEach(async () => {
    await page.waitForLoadState("networkidle").catch(() => {})
  })

  test("UI-NAV-001 App launches and renders main content @smoke @ui", async () => {
    await page.waitForLoadState("networkidle")
    const root = page.locator("#root").first()
    await expect(root).toBeVisible({ timeout: 15_000 })
  })
})
