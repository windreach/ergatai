/**
 * E2E UI tests - Settings dialog navigation.
 *
 * Exercises the Settings dialog accessible from the sidebar:
 *   - opening via the sidebar Settings button
 *   - verifying the tab list renders with expected tabs
 *   - switching tabs and confirming the active tab updates
 *   - closing the dialog via Escape
 *
 * These tests deliberately avoid tRPC and only drive the UI through
 * Playwright's DOM-level APIs so button state, focus, and keyboard
 * handling are exercised end-to-end.
 */

import { test, expect, type Page } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"

test.describe.serial("Settings dialog", () => {
  let electron!: Awaited<ReturnType<typeof launchElectron>>
  let page!: Page

  const EXPECTED_TABS = [
    "Preferences",
    "Account",
    "Appearance",
    "Keyboard",
    "Projects",
    "Worktrees",
  ] as const

  async function openSettings() {
    // The Settings button is icon-only (no aria-label), wrapped in a Tooltip.
    // Strategy: find the sidebar footer area, hover to trigger the tooltip,
    // then click the button beneath it.
    //
    // The sidebar footer contains the Settings button near the bottom. We
    // locate it by finding the footer container and hovering the Settings
    // icon area.
    const sidebar = page.locator('[data-sidebar="sidebar"]').first()
    await expect(sidebar).toBeVisible({ timeout: 10_000 })

    // Hover near the bottom of the sidebar to trigger the Settings tooltip.
    const sidebarBox = await sidebar.boundingBox()
    if (!sidebarBox) throw new Error("Sidebar not found")
    await page.mouse.move(sidebarBox.x + sidebarBox.width / 2, sidebarBox.y + sidebarBox.height - 50)

    // Wait for the tooltip to appear — it contains the text "Settings".
    const settingsTooltip = page.getByText("Settings").first()
    await expect(settingsTooltip).toBeVisible({ timeout: 3_000 })

    // Click the tooltip to activate the button beneath it (the tooltip is
    // positioned over the button, so clicking it triggers the button).
    await settingsTooltip.click()

    // The dialog should appear — wait for any of the known tab labels to
    // confirm the settings UI actually rendered.
    await expect(
      page.getByRole("button", { name: "Preferences" }).first(),
    ).toBeVisible({ timeout: 5_000 })
  }

  async function closeSettings() {
    // Escape is the universal dialog dismissal; it works whether the dialog
    // uses a dedicated close button or relies on overlay click.
    await page.keyboard.press("Escape")
    await expect(
      page.getByRole("button", { name: "Preferences" }).first(),
    ).not.toBeVisible({ timeout: 3_000 })
  }

  test.beforeAll(async () => {
    electron = await launchElectron({
      extraEnv: {
        NODE_ENV: "test",
        ELECTRON_TEST_MODE: "true",
      },
    })
    page = electron.page
    await expect(page.getByRole("button", { name: "New Workspace" })).toBeVisible()
  })

  test.afterAll(async () => {
    await electron?.close()
  })

  test("opens the settings dialog from the sidebar", async () => {
    await openSettings()
    await closeSettings()
  })

  test("renders the expected tab buttons", async () => {
    await openSettings()

    for (const tabName of EXPECTED_TABS) {
      await expect(
        page.getByRole("button", { name: tabName }).first(),
      ).toBeVisible()
    }

    await closeSettings()
  })

  test("switches the active tab when a tab button is pressed", async () => {
    await openSettings()

    const appearanceTab = page.getByRole("button", { name: "Appearance" }).first()
    const keyboardTab = page.getByRole("button", { name: "Keyboard" }).first()

    // Click Appearance and verify it becomes the active tab.
    await appearanceTab.click()
    await expect(appearanceTab).toHaveAttribute("aria-selected", "true")
    await expect(keyboardTab).toHaveAttribute("aria-selected", "false")

    // Click Keyboard and verify the active state follows.
    await keyboardTab.click()
    await expect(keyboardTab).toHaveAttribute("aria-selected", "true")
    await expect(appearanceTab).toHaveAttribute("aria-selected", "false")

    await closeSettings()
  })

  test("re-opens with Preferences tab selected by default", async () => {
    await openSettings()
    await closeSettings()

    // Re-open and confirm the default tab is Preferences (the sidebar click
    // handler explicitly sets the active tab to "preferences").
    await openSettings()
    await expect(
      page.getByRole("button", { name: "Preferences" }).first(),
    ).toHaveAttribute("aria-selected", "true")
    await closeSettings()
  })
})
