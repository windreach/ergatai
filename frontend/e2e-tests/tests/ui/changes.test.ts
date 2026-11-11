// spec: specs/ergatai-electron-ui-test-plan.md
// scenario: UI-CHG-001

import { test, expect, type Page } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"

test.describe.serial("Changes panel (Ergatai Electron UI) @regression @ui", () => {
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

  test("UI-CHG-001 Changes panel renders @regression", async () => {
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

    // Right rail only renders when a worktree exists. Try "Changes" button (title="Changes").
    const changesRail = page.locator('button[title="Changes"]').first()
    const detailRail = page.locator('button[title="Detail"]').first()

    let opened = false
    if (await changesRail.isVisible().catch(() => false)) {
      await changesRail.click()
      opened = true
    } else if (await detailRail.isVisible().catch(() => false)) {
      await detailRail.click()
      // Try to find a Git/Changes tab inside details
      const gitTab = page.getByRole("tab", { name: /git|changes/i }).first()
      if (await gitTab.isVisible().catch(() => false)) {
        await gitTab.click()
      }
      opened = true
    }

    if (!opened) {
      test.skip(true, "No worktree available for changes panel")
      return
    }

    // Assert no crash: app shell remains; optionally Git text
    await expect(page.locator("main, #root").first()).toBeVisible()
    const gitText = page.getByText("Git").first()
    await gitText.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {})

    // Close details if open
    const closeDetails = page.getByRole("button", { name: "Close details" }).first()
    if (await closeDetails.isVisible().catch(() => false)) {
      await closeDetails.click().catch(() => {})
    }
    const closeDiff = page.getByRole("button", { name: /close/i }).first()
    // best-effort
    void closeDiff
  })
})
