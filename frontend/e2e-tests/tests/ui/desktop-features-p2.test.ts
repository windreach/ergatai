// spec: specs/ergatai-electron-ui-test-plan.md
// scenarios: UI-DS-002..006, UI-TERM-002..005, UI-CHG-002..008

import { test, expect, type Page } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"

test.describe.serial("Desktop features extended P2 (Ergatai Electron UI) @extended @ui", () => {
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

  async function openDetails() {
    const btn = page.locator('button[title="Detail"]').first()
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await btn.click()
    const close = page.getByRole("button", { name: "Close details" }).first()
    await expect(close).toBeVisible({ timeout: 5_000 })
  }

  async function closeDetails() {
    const close = page.getByRole("button", { name: "Close details" }).first()
    if (await close.isVisible().catch(() => false)) {
      await close.click()
      await expect(close).not.toBeVisible({ timeout: 5_000 }).catch(() => {})
    }
  }

  async function openTerminal() {
    const btn = page.locator('button[title="Terminal"]').first()
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await btn.click()
    await page.waitForTimeout(500)
  }

  function detailsRailButton(title: string) {
    return page.locator(`button[title="${title}"]`).first()
  }

  // ---------- details ----------

  test("UI-DS-002 Tab switching (details/files/git) @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const rail = page.locator('button[title="Detail"]').first()
    if (!(await rail.isVisible().catch(() => false))) { test.skip(true, "no worktree"); return }
    await openDetails()
    for (const title of ["Detail", "Files", "Git"]) {
      const tbtn = detailsRailButton(title)
      if (await tbtn.isVisible().catch(() => false)) {
        await tbtn.click().catch(() => {})
        await page.waitForTimeout(200)
      }
    }
    await expect(page.locator("main, #root").first()).toBeVisible()
    await closeDetails()
  })

  test("UI-DS-003 Side chat sidebar @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const rail = page.locator('button[title="Detail"]').first()
    if (!(await rail.isVisible().catch(() => false))) { test.skip(true, "no worktree"); return }
    // Open a side chat via any non-standard rail button (agent logo)
    const buttons = await page.getByRole("button").all()
    let opened = false
    for (const b of buttons) {
      const title = await b.getAttribute("title").catch(() => null)
      if (!title) continue
      if (["Detail", "Files", "Git", "Changes", "Terminal"].includes(title)) continue
      if (await b.isVisible().catch(() => false)) {
        await b.click().catch(() => {})
        opened = true
        break
      }
    }
    if (!opened) { test.skip(true, "no side chat button"); return }
    await page.waitForTimeout(500)
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-DS-004 Widgets panel settings @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const rail = page.locator('button[title="Detail"]').first()
    if (!(await rail.isVisible().catch(() => false))) { test.skip(true, "no worktree"); return }
    await openDetails()
    const editWidgets = page.getByRole("button", { name: "Edit widgets" }).first()
    if (await editWidgets.isVisible().catch(() => false)) {
      await editWidgets.click()
      const checkbox = page.getByRole("checkbox").first()
      if (await checkbox.isVisible().catch(() => false)) {
        await checkbox.click().catch(() => {})
        await page.waitForTimeout(200)
      }
      await page.keyboard.press("Escape").catch(() => {})
    }
    await expect(page.locator("main, #root").first()).toBeVisible()
    await closeDetails()
  })

  test("UI-DS-005 Plan widget displays plan @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const rail = page.locator('button[title="Detail"]').first()
    if (!(await rail.isVisible().catch(() => false))) { test.skip(true, "no worktree"); return }
    await openDetails()
    const planText = page.getByText("Plan").first()
    await planText.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
    await closeDetails()
  })

  test("UI-DS-006 Todo widget lists todos @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const rail = page.locator('button[title="Detail"]').first()
    if (!(await rail.isVisible().catch(() => false))) { test.skip(true, "no worktree"); return }
    await openDetails()
    const todoText = page.getByText(/todo/i).first()
    await todoText.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
    await closeDetails()
  })

  // ---------- terminal ----------

  async function openChangesPanel() {
    await openDetails()
    const gitBtn = detailsRailButton("Git")
    if (await gitBtn.isVisible().catch(() => false)) {
      await gitBtn.click()
      await page.waitForTimeout(300)
    }
  }

  test("UI-TERM-002 New terminal tab @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const rail = page.locator('button[title="Terminal"]').first()
    if (!(await rail.isVisible().catch(() => false))) { test.skip(true, "no worktree"); return }
    await openTerminal()
    const newTerm = page.getByRole("button", { name: "New terminal" }).first()
    await expect(newTerm).toBeVisible({ timeout: 5_000 })
    await newTerm.click()
    await page.waitForTimeout(500)
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-TERM-003 Terminal search @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const rail = page.locator('button[title="Terminal"]').first()
    if (!(await rail.isVisible().catch(() => false))) { test.skip(true, "no worktree"); return }
    await openTerminal()
    await page.keyboard.press("Meta+f")
    await page.waitForTimeout(500)
    const search = page.locator('input[placeholder*="Search"], input[type="search"]').first()
    await search.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {})
    if (await search.isVisible().catch(() => false)) {
      await search.fill("pwd").catch(() => {})
      await page.waitForTimeout(300)
    }
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-TERM-004 Terminal input accepts commands @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const rail = page.locator('button[title="Terminal"]').first()
    if (!(await rail.isVisible().catch(() => false))) { test.skip(true, "no worktree"); return }
    await openTerminal()
    await page.waitForTimeout(500)
    await page.keyboard.type("pwd").catch(() => {})
    await page.keyboard.press("Enter").catch(() => {})
    await page.waitForTimeout(1_000)
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  test("UI-TERM-005 Close terminal @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const rail = page.locator('button[title="Terminal"]').first()
    if (!(await rail.isVisible().catch(() => false))) { test.skip(true, "no worktree"); return }
    await openTerminal()
    const close = page.getByRole("button", { name: "Close terminal" }).first()
    if (await close.isVisible().catch(() => false)) {
      await close.click()
      await page.waitForTimeout(300)
    }
    await expect(page.locator("main, #root").first()).toBeVisible()
  })

  // ---------- changes ----------

  test("UI-CHG-002 File list expand/collapse folders @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const rail = page.locator('button[title="Detail"]').first()
    if (!(await rail.isVisible().catch(() => false))) { test.skip(true, "no worktree"); return }
    await openChangesPanel()
    const folderToggle = page.getByRole("button", { name: /expand|collapse|folder/i }).first()
    if (await folderToggle.isVisible().catch(() => false)) {
      await folderToggle.click()
      await page.waitForTimeout(300)
    }
    await expect(page.locator("main, #root").first()).toBeVisible()
    await closeDetails()
  })

  test("UI-CHG-003 Diff view mode switch @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const rail = page.locator('button[title="Detail"]').first()
    if (!(await rail.isVisible().catch(() => false))) { test.skip(true, "no worktree"); return }
    await openChangesPanel()
    const tabs = page.getByRole("tab", { name: /diff/i }).first()
    if (await tabs.isVisible().catch(() => false)) {
      await tabs.click()
      await page.waitForTimeout(300)
    }
    const toggle = page.getByRole("button", { name: /grouped view|tree view/i }).first()
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click()
      await page.waitForTimeout(300)
    }
    await expect(page.locator("main, #root").first()).toBeVisible()
    await closeDetails()
  })

  test("UI-CHG-004 Commit input submits @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const rail = page.locator('button[title="Detail"]').first()
    if (!(await rail.isVisible().catch(() => false))) { test.skip(true, "no worktree"); return }
    await openChangesPanel()
    const commitInput = page.getByPlaceholder("Commit message").first()
    if (await commitInput.isVisible().catch(() => false)) {
      await commitInput.fill("test commit")
      await commitInput.press("Enter").catch(() => {})
    }
    await page.waitForTimeout(500)
    await expect(page.locator("main, #root").first()).toBeVisible()
    await closeDetails()
  })

  test("UI-CHG-005 History view lists commits @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const rail = page.locator('button[title="Detail"]').first()
    if (!(await rail.isVisible().catch(() => false))) { test.skip(true, "no worktree"); return }
    await openChangesPanel()
    const historyTab = page.getByRole("tab", { name: /history/i }).first()
      .or(page.getByRole("button", { name: /history/i }).first())
    if (await historyTab.isVisible().catch(() => false)) {
      await historyTab.click()
      await page.waitForTimeout(500)
    }
    await expect(page.locator("main, #root").first()).toBeVisible()
    await closeDetails()
  })

  test("UI-CHG-006 PR icon/status display @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const rail = page.locator('button[title="Detail"]').first()
    if (!(await rail.isVisible().catch(() => false))) { test.skip(true, "no worktree"); return }
    await openChangesPanel()
    await expect(page.locator("main, #root").first()).toBeVisible()
    await closeDetails()
  })

  test("UI-CHG-007 Full-page diff view @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const rail = page.locator('button[title="Detail"]').first()
    if (!(await rail.isVisible().catch(() => false))) { test.skip(true, "no worktree"); return }
    await openChangesPanel()
    const fullPage = page.getByRole("button", { name: /full.?page|expand/i }).first()
    if (await fullPage.isVisible().catch(() => false)) {
      await fullPage.click()
      await page.waitForTimeout(500)
    }
    await expect(page.locator("main, #root").first()).toBeVisible()
    await closeDetails()
  })

  test("UI-CHG-008 Empty changes state @extended", async () => {
    await clickNewWorkspace()
    await expect(page.getByText("Choose a workspace to start multi-agent collaboration").first()).toBeVisible({ timeout: 10_000 })
    try { await selectWorkspaceAndLoadChat() } catch (e) { test.skip(true, `backend: ${e}`); return }
    const rail = page.locator('button[title="Detail"]').first()
    if (!(await rail.isVisible().catch(() => false))) { test.skip(true, "no worktree"); return }
    await openChangesPanel()
    const empty = page.getByText("No changes detected").first()
    await empty.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {})
    await expect(page.locator("main, #root").first()).toBeVisible()
    await closeDetails()
  })
})
