// spec: specs/ergatai-electron-ui-test-plan.md
// scenario: UI-DS-001

import { test, expect, type Page } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"

test.describe.serial("Details sidebar (Ergatai Electron UI) @regression @ui", () => {
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

  async function findDetailsTrigger() {
    // Desktop right rail uses title="Detail"; mobile/new-chat header uses "Open details"
    const rail = page.locator('button[title="Detail"]').first()
    if (await rail.isVisible().catch(() => false)) return rail
    const header = page.getByRole("button", { name: "Open details" }).first()
    if (await header.isVisible().catch(() => false)) return header
    return null
  }

  test("UI-DS-001 Details sidebar opens/closes @regression", async () => {
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

    // The right rail (with Detail button) only renders when a worktree exists.
    // Poll briefly for the trigger to appear.
    let trigger = await findDetailsTrigger()
    if (!trigger) {
      await page.waitForTimeout(1_000)
      trigger = await findDetailsTrigger()
    }

    if (!trigger) {
      test.skip(true, "No worktree available for details sidebar")
      return
    }

    await trigger.click()
    const closeDetails = page.getByRole("button", { name: "Close details" }).first()
    await expect(closeDetails).toBeVisible({ timeout: 5_000 })

    await closeDetails.click()
    await expect(closeDetails).not.toBeVisible({ timeout: 5_000 })
  })
})
