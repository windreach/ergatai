// spec: specs/ergatai-electron-ui-test-plan.md
// scenarios: UI-NAV-002

import { test, expect, type Page } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"

test.describe.serial("Basic navigation (Ergatai Electron UI)", () => {
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

  test("UI-NAV-002 Sidebar renders New Workspace control @smoke @ui", async () => {
    await page.waitForLoadState("networkidle")
    const btn = page.getByRole("button", { name: "New Workspace" }).first()
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await btn.focus()
    await expect(btn).toBeFocused()
  })
})
