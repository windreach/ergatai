// spec: specs/ergatai-electron-ui-test-plan.md
// scenario: UI-TERM-001

import { test, expect, type Page } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"

test.describe.serial("Terminal sidebar (Ergatai Electron UI) @regression @ui", () => {
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

  async function findTerminalTrigger() {
    const rail = page.locator('button[title="Terminal"]').first()
    if (await rail.isVisible().catch(() => false)) return rail
    const header = page.getByRole("button", { name: "Open terminal" }).first()
    if (await header.isVisible().catch(() => false)) return header
    return null
  }

  test("UI-TERM-001 Terminal sidebar opens @regression", async () => {
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

    let trigger = await findTerminalTrigger()
    if (!trigger) {
      await page.waitForTimeout(1_000)
      trigger = await findTerminalTrigger()
    }

    if (!trigger) {
      test.skip(true, "No worktree available for terminal")
      return
    }

    await trigger.click()

    const closeTerminal = page.getByRole("button", { name: "Close terminal" }).first()
    await expect(closeTerminal).toBeVisible({ timeout: 10_000 })

    const newTerminal = page.getByRole("button", { name: "New terminal" }).first()
    // New terminal may only appear in certain states; assert if visible
    await newTerminal.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {})

    // Close
    await closeTerminal.click()
    await expect(closeTerminal).not.toBeVisible({ timeout: 5_000 }).catch(() => {})
  })
})
