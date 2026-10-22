/**
 * Real UI interaction tests.
 *
 * These tests deliberately avoid calling tRPC from the test process/renderer.
 * All user actions go through Playwright's DOM-level APIs so React event
 * handlers, popovers, keyboard handling, and button state are exercised.
 */

import { test, expect, type Locator, type Page } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"

test.describe.serial("UI interactions", () => {
  let electron!: Awaited<ReturnType<typeof launchElectron>>
  let page!: Page

  async function pressEnterOn(locator: Locator) {
    await locator.focus()
    await page.keyboard.press("Enter")
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

  test("switches collaboration mode from the sidebar", async () => {
    const modeTabs = page.getByRole("tablist", { name: "Collaboration mode" })
    const supervisorTab = modeTabs.getByRole("tab", { name: "Supervisor" })
    const groupTab = modeTabs.getByRole("tab", { name: "Group" })

    await expect(supervisorTab).toBeVisible()
    await expect(groupTab).toBeVisible()

    const initialMode = await supervisorTab.getAttribute("aria-selected")
    const targetTab = initialMode === "true" ? groupTab : supervisorTab
    const otherTab = initialMode === "true" ? supervisorTab : groupTab

    // The animated mode indicator overlays the button, so use keyboard
    // activation instead of a coordinate-sensitive mouse click.
    await targetTab.focus()
    await page.keyboard.press("Enter")
    await expect(targetTab).toHaveAttribute("aria-selected", "true")
    await expect(otherTab).toHaveAttribute("aria-selected", "false")

    // Restore the original mode so the following tests start deterministically.
    await otherTab.focus()
    await page.keyboard.press("Enter")
    await expect(supervisorTab).toHaveAttribute(
      "aria-selected",
      initialMode === "true" ? "true" : "false",
    )
    await expect(groupTab).toHaveAttribute(
      "aria-selected",
      initialMode === "true" ? "false" : "true",
    )
  })

  test("opens Task Board from the sidebar", async () => {
    await pressEnterOn(page.getByRole("button", { name: "Task Board" }))
    await expect(page.getByRole("heading", { level: 1, name: "Task Board" })).toBeVisible()
  })

  test("opens Add Agent from the sidebar", async () => {
    await pressEnterOn(page.getByRole("button", { name: "Add Agent" }))
    await expect(page.getByRole("heading", { level: 1, name: "Add Agent" })).toBeVisible()
  })

  test("workspace search accepts input and Escape returns focus away from it", async () => {
    const searchInput = page.getByPlaceholder("Search workspaces...")
    await expect(searchInput).toBeVisible()

    await searchInput.focus()
    await page.keyboard.type("e2e-ui-search")
    await expect(searchInput).toHaveValue("e2e-ui-search")

    await searchInput.press("Escape")
    await expect(searchInput).toHaveValue("e2e-ui-search")
    await expect(searchInput).not.toBeFocused()
  })

  test("selects Default Workspace and types into the prompt with the keyboard", async () => {
    // "New Workspace" resets the selected workspace through its real button handler.
    await pressEnterOn(page.getByRole("button", { name: "New Workspace" }))
    await expect(
      page
        .getByText("Choose a workspace to start multi-agent collaboration")
        .first(),
    ).toBeVisible()

    const workspaceTrigger = page
      .getByRole("button", { name: "Select workspace" })
      .first()
    await pressEnterOn(workspaceTrigger)

    const defaultWorkspaceButton = page
      .getByRole("button", { name: "Default Workspace" })
      .or(page.getByText("Default Workspace"))
    await expect(defaultWorkspaceButton.first()).toBeVisible()
    await pressEnterOn(defaultWorkspaceButton.first())

    const promptEditor = page.locator('div[contenteditable="true"]').first()
    await expect(promptEditor).toBeVisible()

    const promptText = "Typed through the real UI"
    await promptEditor.focus()
    await page.keyboard.type(promptText)
    await expect(promptEditor).toContainText(promptText)

    // The send affordance reacts to editor content; do not submit the message.
    const sendButton = page.getByRole("button", { name: "Send message" }).first()
    await expect(sendButton).toBeVisible()
    await expect(sendButton).toBeEnabled()

    // Clear with keyboard instead of mutating DOM directly.
    await promptEditor.focus()
    await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "ControlOrMeta+a")
    await page.keyboard.press("Backspace")
    await expect(promptEditor).toHaveText("")
  })
})
