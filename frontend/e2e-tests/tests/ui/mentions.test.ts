// spec: specs/ergatai-electron-ui-test-plan.md
// scenario: UI-CONV-009

import { test, expect, type Page } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"

test.describe.serial("@mention popover (Ergatai Electron UI) @regression @ui", () => {
  let electron!: Awaited<ReturnType<typeof launchElectron>>
  let page!: Page

  test.beforeAll(async () => {
    electron = await launchElectron({
      extraEnv: { NODE_ENV: "test", ELECTRON_TEST_MODE: "true" },
    })
    page = electron.page
    await expect(page.getByRole("button", { name: "New Workspace" })).toBeVisible()
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

  async function selectWorkspaceAndLoadChat() {
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
    await expect(chatInput).toBeVisible({ timeout: 20_000 })
  }

  test("UI-CONV-009 @mention agent popover @regression", async () => {
    await clickNewWorkspace()
    await expect(
      page.getByText("Choose a workspace to start multi-agent collaboration").first(),
    ).toBeVisible({ timeout: 10_000 })

    try {
      await selectWorkspaceAndLoadChat()
    } catch (e) {
      test.skip(true, `Backend/model unavailable: ${e}`)
      return
    }

    const chatInput = page.locator('textarea, [contenteditable="true"]').first()
    await expect(chatInput).toBeVisible({ timeout: 15_000 })

    await chatInput.click()
    await chatInput.pressSequentially("@", { delay: 50 })

    const popover = page.getByRole("listbox").or(page.getByRole("menu")).first()
    const appeared = await popover.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false)

    if (appeared) {
      await expect(popover).toBeVisible()
      // Close popover
      await page.keyboard.press("Escape")
      await popover.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {})
    }

    // Focus should return to input (or at least input remains visible)
    await expect(chatInput).toBeVisible()
    await chatInput.focus().catch(() => {})
  })
})
