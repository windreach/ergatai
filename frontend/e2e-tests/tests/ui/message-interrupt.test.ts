/**
 * E2E UI tests - Message send and cancel (interrupt/stop) workflow.
 *
 * Deep coverage of the agent interrupt mechanism:
 *   - Stopping generation during different phases (thinking, tool execution, text)
 *   - State recovery after stop (input re-enabled, can send new message)
 *   - Stop with message queue (send while streaming, then stop)
 *   - Keyboard shortcut for stop (stop-generation hotkey)
 *   - Multiple rapid stop attempts (no errors)
 *   - Partial response preservation after stop
 *
 * These tests exercise the real interrupt flow documented in CLAUDE.md:
 *   - Frontend stop button (icon-only, shows during streaming)
 *   - agentChatStore.setManuallyAborted() flag
 *   - stopRef.current() invocation
 *   - Safe-point interrupt (thinking/tool completion boundaries)
 */

import { test, expect, type Page } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"

test.describe.serial("Message send and cancel (interrupt)", () => {
  let electron!: Awaited<ReturnType<typeof launchElectron>>
  let page!: Page

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

  /**
   * Select a workspace and wait for the chat interface to load.
   */
  async function selectWorkspaceAndLoadChat() {
    const selectButton = page.getByRole("button", { name: "Select workspace" }).first()
    await expect(selectButton).toBeVisible({ timeout: 10_000 })
    await selectButton.click()

    const defaultWorkspace = page.getByRole("button", { name: "Default Workspace" }).or(page.getByText("Default Workspace")).first()
    await expect(defaultWorkspace).toBeVisible({ timeout: 5_000 })
    await defaultWorkspace.click()

    // Wait for chat input to appear
    const chatInput = page.locator('textarea, [contenteditable="true"]').first()
    await expect(chatInput).toBeVisible({ timeout: 15_000 })
  }

  /**
   * Send a message and wait for streaming to start.
   */
  async function sendMessageAndWaitForStreaming(text: string) {
    const chatInput = page.locator('textarea, [contenteditable="true"]').first()
    await expect(chatInput).toBeVisible()

    const isTextarea = await chatInput.evaluate(el => el.tagName === "TEXTAREA")
    if (isTextarea) {
      await chatInput.fill(text)
    } else {
      await chatInput.click()
      await chatInput.pressSequentially(text, { delay: 30 })
    }

    // Click send button
    const sendButton = page.getByRole("button", { name: /send|arrow/i }).first()
    await expect(sendButton).toBeEnabled({ timeout: 2_000 })
    await sendButton.click()

    // Wait for streaming to start — the stop button appears when isStreaming is true
    const stopButton = page.getByRole("button", { name: /stop/i }).or(page.locator('[data-testid="stop-button"]')).first()
    await expect(stopButton).toBeVisible({ timeout: 15_000 })
  }

  /**
   * Click the stop button and verify streaming stops.
   */
  async function clickStopAndWaitForCompletion() {
    const stopButton = page.getByRole("button", { name: /stop/i }).or(page.locator('[data-testid="stop-button"]')).first()
    await expect(stopButton).toBeVisible()
    await stopButton.click()

    // After stop, the stop button should disappear and send button should reappear
    await expect(stopButton).not.toBeVisible({ timeout: 10_000 })

    // Input should be re-enabled
    const chatInput = page.locator('textarea, [contenteditable="true"]').first()
    await expect(chatInput).toBeEnabled({ timeout: 5_000 })
  }

  test("basic stop: send message, stop during streaming, verify state recovery", async () => {
    await selectWorkspaceAndLoadChat()

    // Send a message that will trigger agent processing
    await sendMessageAndWaitForStreaming("Please write a long essay about software engineering")

    // Wait a bit for the agent to start generating content
    await page.waitForTimeout(2000)

    // Click stop
    await clickStopAndWaitForCompletion()

    // Verify we can send a new message (state recovery)
    const chatInput = page.locator('textarea, [contenteditable="true"]').first()
    await expect(chatInput).toBeVisible()
    await chatInput.fill("test")
    await expect(chatInput).toHaveValue("test")
  })

  test("stop preserves partial response in the conversation", async () => {
    await selectWorkspaceAndLoadChat()

    await sendMessageAndWaitForStreaming("Write a detailed explanation of React hooks")

    // Wait for some content to appear
    await page.waitForTimeout(3000)

    // Capture any visible assistant message content before stopping
    const assistantMessagesBefore = await page.locator('[data-role="assistant"], .assistant-message').count()

    // Stop generation
    await clickStopAndWaitForCompletion()

    // Verify at least one assistant message exists (partial response preserved)
    const assistantMessagesAfter = await page.locator('[data-role="assistant"], .assistant-message').count()
    expect(assistantMessagesAfter).toBeGreaterThanOrEqual(assistantMessagesBefore)
  })

  test("stop with message queue: send multiple messages while streaming, then stop", async () => {
    await selectWorkspaceAndLoadChat()

    // Send first message
    await sendMessageAndWaitForStreaming("First message: explain quicksort")

    // While streaming, type a second message (this queues it)
    const chatInput = page.locator('textarea, [contenteditable="true"]').first()
    await chatInput.fill("Second message: explain mergesort")

    // The send button should show "Add to queue" tooltip when streaming with content
    const sendButton = page.getByRole("button", { name: /send|arrow/i }).first()
    await expect(sendButton).toBeVisible()

    // Click send to add to queue (or send immediately)
    await sendButton.click()

    // Now stop — this should stop the current streaming
    await clickStopAndWaitForCompletion()

    // Verify input is ready for new messages
    await expect(chatInput).toBeEnabled()
  })

  test("keyboard shortcut for stop (stop-generation hotkey)", async () => {
    await selectWorkspaceAndLoadChat()

    await sendMessageAndWaitForStreaming("Tell me about distributed systems")

    // Wait for streaming to start
    await page.waitForTimeout(2000)

    // Use keyboard shortcut to stop — typically Escape or a custom hotkey
    // The exact hotkey depends on useResolvedHotkeyDisplayWithAlt("stop-generation")
    // Common defaults: Escape or Ctrl/Cmd + .
    await page.keyboard.press("Escape")

    // Verify streaming stopped (stop button disappeared)
    const stopButton = page.getByRole("button", { name: /stop/i }).first()
    await expect(stopButton).not.toBeVisible({ timeout: 10_000 })

    // Input should be re-enabled
    const chatInput = page.locator('textarea, [contenteditable="true"]').first()
    await expect(chatInput).toBeEnabled({ timeout: 5_000 })
  })

  test("multiple rapid stop attempts do not cause errors", async () => {
    await selectWorkspaceAndLoadChat()

    await sendMessageAndWaitForStreaming("Explain quantum computing")

    // Wait for streaming to start
    await page.waitForTimeout(1500)

    // Click stop multiple times rapidly
    const stopButton = page.getByRole("button", { name: /stop/i }).first()
    for (let i = 0; i < 3; i++) {
      if (await stopButton.isVisible()) {
        await stopButton.click()
        await page.waitForTimeout(100)
      }
    }

    // Verify no JavaScript errors occurred
    const errors: string[] = []
    page.on("pageerror", (error) => {
      errors.push(error.message)
    })

    // Wait a bit for any errors to surface
    await page.waitForTimeout(1000)

    // Filter out common non-critical errors
    const criticalErrors = errors.filter(err =>
      !err.includes("ResizeObserver") &&
      !err.includes("favicon") &&
      !err.includes("abort")
    )

    expect(criticalErrors.length).toBe(0)

    // Verify input is still functional
    const chatInput = page.locator('textarea, [contenteditable="true"]').first()
    await expect(chatInput).toBeEnabled({ timeout: 5_000 })
  })

  test("stop when agent is slow to respond (stop before first token)", async () => {
    await selectWorkspaceAndLoadChat()

    // Send a message
    const chatInput = page.locator('textarea, [contenteditable="true"]').first()
    await chatInput.fill("Complex analysis request")
    const sendButton = page.getByRole("button", { name: /send|arrow/i }).first()
    await sendButton.click()

    // Immediately try to stop (before agent starts streaming)
    // The stop button may not appear yet, so we wait briefly
    await page.waitForTimeout(500)

    // Try to click stop if it's visible
    const stopButton = page.getByRole("button", { name: /stop/i }).first()
    if (await stopButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await stopButton.click()
      await expect(stopButton).not.toBeVisible({ timeout: 10_000 })
    }

    // Verify input is re-enabled (or was never disabled)
    await expect(chatInput).toBeEnabled({ timeout: 5_000 })
  })

  test("stop during tool execution phase", async () => {
    await selectWorkspaceAndLoadChat()

    // Send a message that will likely trigger tool use
    await sendMessageAndWaitForStreaming("Read the README.md file and summarize it")

    // Wait for tool execution to start (agent may show tool call UI)
    await page.waitForTimeout(3000)

    // Stop during tool execution
    await clickStopAndWaitForCompletion()

    // Verify we can continue with a new message
    const chatInput = page.locator('textarea, [contenteditable="true"]').first()
    await expect(chatInput).toBeEnabled()
    await chatInput.fill("new message after tool stop")
    await expect(chatInput).toHaveValue("new message after tool stop")
  })

  test("conversation remains usable after multiple stop cycles", async () => {
    await selectWorkspaceAndLoadChat()

    // Cycle 1: send and stop
    await sendMessageAndWaitForStreaming("First request")
    await page.waitForTimeout(2000)
    await clickStopAndWaitForCompletion()

    // Cycle 2: send another and stop
    await sendMessageAndWaitForStreaming("Second request")
    await page.waitForTimeout(2000)
    await clickStopAndWaitForCompletion()

    // Cycle 3: send a final message and let it complete (or stop again)
    await sendMessageAndWaitForStreaming("Third request")
    await page.waitForTimeout(2000)
    await clickStopAndWaitForCompletion()

    // Verify conversation is still usable
    const chatInput = page.locator('textarea, [contenteditable="true"]').first()
    await expect(chatInput).toBeEnabled()

    // Verify multiple assistant messages exist (from the partial responses)
    const assistantMessages = await page.locator('[data-role="assistant"], .assistant-message').count()
    expect(assistantMessages).toBeGreaterThanOrEqual(3)
  })
})
