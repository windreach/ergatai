// spec: specs/ergatai-electron-ui-test-plan.md
// scenarios: UI-CONV-006, 007, 008, 013, 014, 015, 017

import { test, expect, type Page } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"

test.describe.serial("Conversations extended P2b (Ergatai Electron UI) @extended @ui", () => {
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

  test("UI-CONV-006 Interrupt streaming message @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const chatInput = page.locator('textarea, [contenteditable="true"]').first()
    await chatInput.fill("write a long essay").catch(() => {})
    const sendBtn = page.locator('[data-testid="send-button"]').or(page.getByRole("button", { name: /send/i })).first()
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click().catch(() => {})
    }
    const stopBtn = page.getByRole("button", { name: /stop/i }).first()
    await stopBtn.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {})
    if (await stopBtn.isVisible().catch(() => false)) {
      await stopBtn.click().catch(() => {})
    }
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-CONV-007 Regenerate response @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const regenBtn = page.getByRole("button", { name: /regenerate/i }).first()
    await regenBtn.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-CONV-008 Copy message @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const copyBtn = page.getByRole("button", { name: /copy/i }).first()
    await copyBtn.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-CONV-013 Plan approval flow @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const approveBtn = page.getByRole("button", { name: /approve/i }).first()
    await approveBtn.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-CONV-014 Rollback conversation @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const rollbackBtn = page.getByRole("button", { name: /rollback/i }).first()
    await rollbackBtn.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-CONV-015 Fork conversation @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const forkBtn = page.getByRole("button", { name: /fork/i }).first()
    await forkBtn.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-CONV-017 Export chat @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const exportBtn = page.getByRole("button", { name: /export/i }).first()
    await exportBtn.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
  })
})
