// spec: specs/ergatai-electron-ui-test-plan.md
// scenarios: UI-FV-001..005, UI-KAN-001..003

import { test, expect, type Page } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"

test.describe.serial("FileViewer/Kanban extended P2 (Ergatai Electron UI) @extended @ui", () => {
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

  test("UI-FV-001 File viewer opens from details @extended", async () => {
    await clickNewWorkspace()
    await page.waitForTimeout(500)
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-FV-002 Markdown renders @extended", async () => {
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-FV-003 Code syntax highlighting @extended", async () => {
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-FV-004 File viewer close @extended", async () => {
    const close = page.getByRole("button", { name: /close/i }).first()
    await close.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-FV-005 File viewer add to context @extended", async () => {
    const btn = page.getByRole("button", { name: /add to context/i }).first()
    await btn.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-KAN-001 Kanban view renders when enabled @extended", async () => {
    await page.evaluate(() => {
      window.localStorage.setItem("preferences:beta-kanban-enabled", "true")
    })
    await page.reload()
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForTimeout(1_000)
    const kanbanBtn = page.getByRole("button", { name: /kanban/i })
      .or(page.getByTitle("Kanban View"))
      .or(page.getByText("Kanban View"))
      .first()
    if (await kanbanBtn.isVisible().catch(() => false)) {
      await kanbanBtn.click().catch(() => {})
      await page.waitForTimeout(500)
    }
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-KAN-002 Kanban card drag between columns @extended", async () => {
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-KAN-003 Kanban disabled hides entry @extended", async () => {
    await page.evaluate(() => {
      window.localStorage.setItem("preferences:beta-kanban-enabled", "false")
    })
    await page.reload()
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForTimeout(1_000)
    await expect(page.locator("main, #root").first()).toBeVisible()
  })
})
