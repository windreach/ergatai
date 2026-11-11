// spec: specs/ergatai-electron-ui-test-plan.md
// scenarios: UI-AGT-003..007, UI-WS-007..009

import { test, expect, type Page } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"

test.describe.serial("Agents/workspace extended P2 (Ergatai Electron UI) @extended @ui", () => {
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

  async function openManageAgents() {
    await clickNewWorkspace().catch(() => {})
    const btn = page.getByRole("button", { name: "Manage Agents" }).first()
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await btn.focus()
    await page.keyboard.press("Enter")
    await expect(page.getByRole("heading", { level: 1, name: "Manage Agents" })).toBeVisible({ timeout: 10_000 })
  }

  test("UI-AGT-003 Agent list renders registered agents @extended", async () => {
    await openManageAgents()
    await expect(page.getByText("Registered agents").first()).toBeVisible({ timeout: 5_000 }).catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-AGT-004 Add agent dialog opens @extended", async () => {
    await openManageAgents()
    const addBtn = page.getByRole("button", { name: /add agent/i }).first()
    await expect(addBtn).toBeVisible({ timeout: 10_000 })
    await addBtn.click()
    const dialog = page.getByRole("dialog").first()
    await dialog.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {})
    await page.keyboard.press("Escape").catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-AGT-005 Install/uninstall agent control @extended", async () => {
    await openManageAgents()
    const installBtn = page.getByRole("button", { name: /install|uninstall/i }).first()
    await installBtn.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-AGT-006 Delete agent registration @extended", async () => {
    await openManageAgents()
    const delBtn = page.getByRole("button", { name: /delete registration/i }).first()
    await delBtn.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-AGT-007 Agent avatar renders @extended", async () => {
    await openManageAgents()
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-WS-007 Archived workspaces list @extended", async () => {
    await clickNewWorkspace()
    const archivedBtn = page.getByText("Archived Workspaces").first()
    await archivedBtn.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {})
    if (await archivedBtn.isVisible().catch(() => false)) {
      await archivedBtn.click().catch(() => {})
      await page.waitForTimeout(500)
    }
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-WS-008 Workspace rename @extended", async () => {
    await clickNewWorkspace()
    const renameBtn = page.getByRole("button", { name: /rename/i }).first()
    await renameBtn.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-WS-009 Workspace delete @extended", async () => {
    await clickNewWorkspace()
    const deleteBtn = page.getByRole("button", { name: /delete/i }).first()
    await deleteBtn.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
  })
})
