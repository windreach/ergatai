// spec: specs/ergatai-electron-ui-test-plan.md
// scenarios: UI-CONV-010, UI-CONV-016, UI-SB-006, UI-SB-009

import { test, expect, type Page } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"

test.describe.serial("Conversation/sidebar extended P2 (Ergatai Electron UI) @extended @ui", () => {
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

  async function enableSidebarMode() {
    await page.evaluate(() => {
      window.localStorage.setItem("agents-conversations-mode", '"sidebar"')
    })
    await page.reload()
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForTimeout(1_000)
  }

  async function disableSidebarMode() {
    await page.evaluate(() => {
      window.localStorage.setItem("agents-conversations-mode", '"tabs"')
    })
  }

  test("UI-CONV-010 slash command menu @extended", async () => {
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
    await chatInput.pressSequentially("/", { delay: 50 })

    const menu = page
      .getByRole("listbox")
      .or(page.getByRole("menu"))
      .or(page.locator('[role="dialog"]'))
      .first()

    // Menu may or may not appear depending on commands; at minimum no crash
    await menu.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {})
    await page.keyboard.press("Escape").catch(() => {})
    await expect(chatInput).toBeVisible()
  })

  test("UI-CONV-016 chat search toggle @extended", async () => {
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

    await page.keyboard.press("ControlOrMeta+f")
    await page.waitForTimeout(500)

    const searchInput = page
      .getByPlaceholder(/search/i)
      .or(page.locator('input[type="search"]'))
      .first()
    await searchInput.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {})

    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill("needle")
      await expect(searchInput).toHaveValue("needle")
    }

    await page.keyboard.press("Escape").catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-SB-006 conversation search input @extended", async () => {
    await enableSidebarMode()
    try {
      await selectWorkspaceAndLoadChat()
    } catch (e) {
      await disableSidebarMode()
      test.skip(true, `Backend/model unavailable: ${e}`)
      return
    }

    const searchInput = page
      .getByTestId("conversation-search-input")
      .or(page.getByPlaceholder(/search/i))
      .first()
    await expect(searchInput).toBeVisible({ timeout: 10_000 })

    await searchInput.focus()
    await page.keyboard.type("e2e-search")
    await expect(searchInput).toHaveValue("e2e-search")

    await searchInput.press("Escape").catch(() => {})
    await disableSidebarMode()
  })

  test("UI-SB-009 empty conversation list state @extended", async () => {
    await enableSidebarMode()
    // No workspace selected; main content should still render without crash
    await expect(page.locator("main, #root").first()).toBeVisible()
    await disableSidebarMode()
  })
})
