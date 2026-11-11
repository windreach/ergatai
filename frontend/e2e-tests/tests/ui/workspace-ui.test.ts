// spec: specs/ergatai-electron-ui-test-plan.md
// scenarios: UI-WS-001, UI-WS-002

import { test, expect, type Page } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"

test.describe.serial("Workspace UI (Ergatai Electron UI)", () => {
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

  async function clickNewWorkspace() {
    const btn = page.getByRole("button", { name: "New Workspace" }).first()
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await btn.focus()
    await page.keyboard.press("Enter")
  }

  test("UI-WS-001 Default view shows workspace chooser @smoke @ui", async () => {
    await clickNewWorkspace()
    await expect(
      page.getByText("Choose a workspace to start multi-agent collaboration").first(),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByRole("button", { name: "Select workspace" }).first(),
    ).toBeVisible()
  })

  test("UI-WS-002 Select Default Workspace @smoke @ui", async () => {
    const selectButton = page.getByRole("button", { name: "Select workspace" }).first()
    await expect(selectButton).toBeVisible({ timeout: 10_000 })
    await selectButton.click()

    const defaultWorkspace = page
      .getByRole("button", { name: "Default Workspace" })
      .or(page.getByText("Default Workspace"))
      .first()
    await expect(defaultWorkspace).toBeVisible({ timeout: 5_000 })
    await defaultWorkspace.click()

    const chatInput = page.locator('textarea, [contenteditable="true"]').first()
    await expect(chatInput).toBeVisible({ timeout: 15_000 })

    const sendButton = page
      .locator('[data-testid="send-button"]')
      .or(page.getByRole("button", { name: /send/i }))
      .first()
    await expect(sendButton).toBeVisible({ timeout: 10_000 })
  })
})
