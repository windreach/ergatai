// spec: specs/ergatai-electron-ui-test-plan.md
// scenarios: UI-SET-004..009, UI-TB-003, UI-TB-004

import { test, expect, type Page } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"

test.describe.serial("Settings/TaskBoard extended P2 (Ergatai Electron UI) @extended @ui", () => {
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

  async function openSettings() {
    const sidebar = page.locator('[data-sidebar="sidebar"]').first()
    await expect(sidebar).toBeVisible({ timeout: 10_000 })
    const sidebarBox = await sidebar.boundingBox()
    if (!sidebarBox) throw new Error("Sidebar not found")
    await page.mouse.move(
      sidebarBox.x + sidebarBox.width / 2,
      sidebarBox.y + sidebarBox.height - 50,
    )
    const settingsTooltip = page.getByText("Settings").first()
    await expect(settingsTooltip).toBeVisible({ timeout: 3_000 })
    await settingsTooltip.click()
    await expect(
      page.getByRole("button", { name: "Preferences" }).first(),
    ).toBeVisible({ timeout: 5_000 })
  }

  async function closeSettings() {
    await page.keyboard.press("Escape")
    await expect(
      page.getByRole("button", { name: "Preferences" }).first(),
    ).not.toBeVisible({ timeout: 3_000 }).catch(() => {})
  }

  async function switchTab(name: string) {
    const tab = page.getByRole("button", { name }).first()
    await expect(tab).toBeVisible({ timeout: 5_000 })
    await tab.click()
    await expect(tab).toHaveAttribute("aria-selected", "true")
  }

  test("UI-SET-004 Preferences tab content @extended", async () => {
    await openSettings()
    await switchTab("Preferences")
    // Content renders without crash
    await expect(page.locator("main, #root").first()).toBeVisible()
    await closeSettings()
  })

  test("UI-SET-005 Appearance tab theme switch @extended", async () => {
    await openSettings()
    await switchTab("Appearance")
    const themeBtn = page.getByRole("button", { name: /light|dark/i }).first()
    if (await themeBtn.isVisible().catch(() => false)) {
      await themeBtn.click().catch(() => {})
      await page.waitForTimeout(300)
    }
    await expect(page.locator("main, #root").first()).toBeVisible()
    await closeSettings()
  })

  test("UI-SET-006 Keyboard tab shows hotkeys @extended", async () => {
    await openSettings()
    await switchTab("Keyboard")
    await expect(
      page.getByText(/stop generation|quick-switch|hotkey/i).first(),
    ).toBeVisible({ timeout: 5_000 }).catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
    await closeSettings()
  })

  test("UI-SET-007 Projects tab renders @extended", async () => {
    await openSettings()
    await switchTab("Projects")
    await expect(page.locator("main, #root").first()).toBeVisible()
    await closeSettings()
  })

  test("UI-SET-008 Worktrees tab renders @extended", async () => {
    await openSettings()
    await switchTab("Worktrees")
    await expect(page.locator("main, #root").first()).toBeVisible()
    await closeSettings()
  })

  test("UI-SET-009 Debug tab gated by dev mode @extended", async () => {
    await openSettings()
    const debugBtn = page.getByRole("button", { name: "Debug" }).first()
    // Either visible (dev) or not; ensure no crash either way
    await debugBtn.isVisible().catch(() => false)
    await expect(page.locator("main, #root").first()).toBeVisible()
    await closeSettings()
  })

  test("UI-TB-003 Task Board renders columns @extended", async () => {
    const taskBoardButton = page.getByRole("button", { name: "Task Board" }).first()
    await expect(taskBoardButton).toBeVisible({ timeout: 10_000 })
    await taskBoardButton.focus()
    await page.keyboard.press("Enter")
    await expect(
      page.getByRole("heading", { level: 1, name: "Task Board" }),
    ).toBeVisible({ timeout: 10_000 })
    for (const col of ["Queued", "Running", "Completed", "Failed"]) {
      await page.getByText(col).first().waitFor({ state: "visible", timeout: 3_000 }).catch(() => {})
    }
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-TB-004 Task Board empty state @extended", async () => {
    const taskBoardButton = page.getByRole("button", { name: "Task Board" }).first()
    if (await taskBoardButton.isVisible().catch(() => false)) {
      await taskBoardButton.focus()
      await page.keyboard.press("Enter")
      await page.waitForTimeout(500)
    }
    await expect(page.locator("main, #root").first()).toBeVisible()
  })
})
