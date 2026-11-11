# Ergatai Electron Desktop App — End-to-End UI Test Plan (Updated)

**Target app:** Ergatai multi-agent collaboration workbench (Electron + React + Vite)  
**Renderer entry:** `frontend/src/renderer/App.tsx` → `AgentsLayout`  
**Plan scope:** Renderer/UI flows only. Backend/TRPC integration is assumed available unless a scenario is explicitly backend-dependent.  
**Primary test project:** `frontend/e2e-tests` (Playwright, Electron project, serial execution)  
**Updated:** 2026-11-10  

---

## 1. Purpose of this revision

This revision updates the original scenario index with:

1. **Concrete selectors** verified against the current renderer source (roles, accessible names, placeholders, `data-testid`s, titles, and ARIA attributes).
2. **Realistic DOM interactions** that match the actual application behavior, especially:
   - “New Workspace” resets selection to the workspace chooser instead of opening a create dialog.
   - “Select workspace” opens a `WorkspaceSelector` popover, not a modal.
   - Desktop details/terminal are opened from the right rail via `button[title="Detail"]` / `button[title="Terminal"]`, not `aria-label="Open details"`.
   - Settings is opened by hovering the sidebar footer and clicking the “Settings” tooltip.
3. **File assignments** aligned with the existing consolidated suites (`smoke-p0`, `regression-p1`, etc.) plus recommended feature-focused targets.
4. **P0/P1 gap analysis** for scenarios that are currently implemented as loose/conditional assertions and need strengthening.

---

## 2. Test Environment & Prerequisites

| Item | Requirement |
|---|---|
| Runtime | Node 20+, Electron binary at `frontend/node_modules/electron/dist/electron` |
| Display | Xvfb (`USE_XVFB=true`) or headless (`--headless`, default) |
| Backend | Ergatai backend reachable; health check passes (`tests/integration/backend-health.test.ts`) |
| DB/State | Fresh profile; no persisted `selectedWorkspaceId` unless a test seeds it |
| Fixtures | `launchElectron()` from `frontend/e2e-tests/fixtures/electron-launcher.js` |
| Env | `NODE_ENV=test`, `ELECTRON_TEST_MODE=true` |
| Concurrency | `workers: 1`, `fullyParallel: false` |
| Timeouts | Test 60s, action 10s, navigation 30s |

### Launch pattern (preferred)

```ts
const electron = await launchElectron({
  extraEnv: { NODE_ENV: "test", ELECTRON_TEST_MODE: "true" }
})
const page = electron.page
await expect(page.getByRole("button", { name: "New Workspace" })).toBeVisible()
```

### Data seeding

- Agent files: write markdown to `~/.claude/agents/<name>.md` in `beforeAll`, clean in `afterAll`.
- Workspaces: use `/tmp/ergatai-e2e-*` paths and clean after.
- localStorage seeding is allowed only for UI state:
  - `agents-conversations-mode`
  - `agents:selectedWorkspaceIdsByMode`
  - `ergatai:desktop-view`
- Reset these keys in teardown.

---

## 3. Selector catalog (verified)

### App shell

| Purpose | Selector |
|---|---|
| Root container | `#root` |
| Sidebar (shadcn) | `[data-sidebar="sidebar"]` |
| Agents/conversations sidebar | `[data-testid="conversation-sidebar"]` |
| New Workspace button | `getByRole("button", { name: "New Workspace" })` |
| Task Board button | `getByRole("button", { name: "Task Board" })` |
| Manage Agents button | `getByRole("button", { name: "Manage Agents" })` |
| Workspace search (sidebar) | `getByPlaceholder("Search workspaces...")` |
| Collaboration mode tablist | `getByRole("tablist", { name: "Collaboration mode" })` |
| Supervisor/Group tabs | `getByRole("tab", { name: "Supervisor" })`, `getByRole("tab", { name: "Group" })` |

### Workspace chooser / selector

| Purpose | Selector |
|---|---|
| Chooser heading text | `getByText("Choose a workspace to start multi-agent collaboration")` |
| Select workspace trigger | `getByRole("button", { name: "Select workspace" })` |
| Workspace selector popover trigger | `button` containing text `"Select workspace"` (fallback: `.getByText("Select workspace")`) |
| Workspace selector search | `getByPlaceholder("Search workspaces...")` (inside popover) |
| Default Workspace item | `getByRole("button", { name: "Default Workspace" })` / `getByText("Default Workspace")` |
| Add repository item | `getByText("Add repository")` |
| Add from GitHub item | `getByText("Add from GitHub")` |

### Chat

| Purpose | Selector |
|---|---|
| Chat input | `locator('textarea, [contenteditable="true"]')` |
| Contenteditable editor | `locator('div[contenteditable="true"]')` |
| Send button | `[data-testid="send-button"]` or `getByRole("button", { name: /Send message|Stop generation|Add to queue/ })` |
| Stop generation | `getByRole("button", { name: "Stop generation" })` or `[data-testid="stop-button"]` |
| User message | `[data-testid="user-message"]` |
| Assistant message | `[data-testid="agent-message"]` |
| @mention popover | `getByRole("listbox")` / `getByRole("menu")` |
| New chat/conversation button | `[data-testid="new-conversation-button"]` or `getByRole("button", { name: /new (chat|conversation)/i })` |
| Conversation search input | `[data-testid="conversation-search-input"]` |
| Conversation item | `[data-testid^="conversation-item-"]` |
| Open chats pane (tabs mode) | `getByRole("button", { name: "Open chats pane" })` |

### Settings

| Purpose | Selector |
|---|---|
| Settings entry (hover footer) | sidebar `[data-sidebar="sidebar"]`, hover bottom, click `getByText("Settings")` |
| Settings tabs | `getByRole("button", { name: "Preferences" \| "Account" \| "Appearance" \| "Keyboard" \| "Projects" \| "Worktrees" })` |
| Active tab state | `toHaveAttribute("aria-selected", "true")` |

### Task Board

| Purpose | Selector |
|---|---|
| Open button | `getByRole("button", { name: "Task Board" })` |
| Heading | `getByRole("heading", { level: 1, name: "Task Board" })` |
| Back button | `getByRole("button", { name: "Back to Task Board" })` |

### Details / terminal (desktop)

| Purpose | Selector |
|---|---|
| Open details (desktop rail) | `page.locator('button[title="Detail"]')` |
| Open details (mobile/new-chat header) | `getByRole("button", { name: "Open details" })` |
| Close details | `getByRole("button", { name: "Close details" })` |
| Open terminal (desktop rail) | `page.locator('button[title="Terminal"]')` |
| Open terminal (header) | `getByRole("button", { name: "Open terminal" })` |
| Close terminal | `getByRole("button", { name: "Close terminal" })` |
| New terminal tab | `getByRole("button", { name: "New terminal" })` |
| Terminal sidebar root | `getByRole("button", { name: "Close terminal" })` ancestor or `locator('.terminal-sidebar, [data-testid="terminal-sidebar"]')` (testid recommended) |

### Sidebar collapse

| Purpose | Selector |
|---|---|
| Toggle sidebar (title bar) | `getByRole("button", { name: "Toggle sidebar" })` |
| Close sidebar | `getByRole("button", { name: "Close sidebar" })` |

---

## 4. P0/P1 coverage status and gaps

Legend: **Strong** = deterministic assertions; **Partial** = conditional/skip-heavy; **Weak** = existence-only.

| ID | Current implementation | Status | Main gap |
|---|---|---|---|
| UI-NAV-001 | `smoke-p0` | Strong | None |
| UI-NAV-002 | `smoke-p0`, `interactive-workflows` | Strong | None |
| UI-WS-001 | `smoke-p0` | Strong | None |
| UI-WS-002 | `smoke-p0`, `regression-p1` | Strong | None |
| UI-CONV-001 | `smoke-p0` | Strong | None |
| UI-CONV-002 | `smoke-p0` | Partial | Backend/model dependent; skip allowed |
| UI-CONV-005 | `smoke-p0`, `message-interrupt` | Strong | None |
| UI-SB-003 | `smoke-p0`, `settings-dialog` | Strong | None |
| UI-SET-001 | `smoke-p0`, `settings-dialog` | Strong | None |
| UI-SET-002 | `smoke-p0`, `settings-dialog` | Strong | None |
| UI-TB-001 | `smoke-p0`, `interactive-workflows` | Strong | None |
| UI-NAV-004 | `regression-p1` | Strong | None |
| UI-NAV-008 | `regression-p1`, `interactive-workflows` | Strong | Restore mode at end |
| UI-WS-003 | `regression-p1` | Weak | Currently asserts chooser, not a reset flow; rename/redefine |
| UI-WS-004 | `regression-p1` | Weak | No real validation; should test selector filtering |
| UI-WS-005 | `regression-p1` | Partial | Backend-dependent workspace creation |
| UI-WS-006 | `regression-p1`, `interactive-workflows` | Strong | None |
| UI-AGT-001 | `regression-p1`, `interactive-workflows` | Strong | None |
| UI-AGT-002 | `regression-p1` | Partial | “Add Agent” button exists; dialog/assertions loose |
| UI-CONV-003 | `regression-p1` | Partial | Backend-dependent; input-clear assertion soft |
| UI-CONV-004 | `regression-p1` | Partial | Send button may not render as disabled; needs stable assertion |
| UI-CONV-009 | `regression-p1` | Weak | Popover is optional; no agent-selection assertion |
| UI-SB-001 | `regression-p1` | Weak | Only button count; should assert key controls |
| UI-SB-002 | `regression-p1` | Weak | Platform-dependent; optional assertions |
| UI-SB-004 | `regression-p1` | Partial | Tabs mode assertion soft |
| UI-SB-005 | `regression-p1` | Strong | Reset mode afterward |
| UI-SB-007 | `regression-p1` | Partial | New conversation button conditional |
| UI-SET-003 | `regression-p1`, `settings-dialog` | Strong | None |
| UI-TB-002 | `regression-p1` | Partial | Back button conditional |
| UI-CHG-001 | `regression-p1` | Weak | Requires worktree; selectors differ by platform |
| UI-TERM-001 | `regression-p1` | Weak | Requires worktree; selectors differ by platform |
| UI-DS-001 | `regression-p1` | Weak | Uses `Open details`, which is not the desktop selector |

---

## 5. P0 scenario table (smoke)

| ID | Title | Preconditions | Steps | Expected | Priority | Tags | Key selectors | Suggested file |
|---|---|---|---|---|---|---|---|---|
| UI-NAV-001 | App launches and renders main content | Fresh state | 1. Launch Electron. 2. `waitForLoadState("networkidle")`. 3. Assert `#root` visible. | Root visible; no critical page errors; load < 15s | P0 | `@smoke @ui` | `#root` | `tests/ui/smoke-p0.test.ts` |
| UI-NAV-002 | Sidebar renders New Workspace control | Launched | 1. Wait networkidle. 2. Assert button visible. 3. Focus button. | Button visible and focusable | P0 | `@smoke @ui` | `getByRole("button", { name: "New Workspace" })` | `tests/ui/smoke-p0.test.ts` |
| UI-WS-001 | Default view shows workspace chooser | No workspace selected | 1. Click New Workspace (keyboard). 2. Wait chooser. | Chooser text and Select workspace button visible | P0 | `@smoke @ui` | `getByText("Choose a workspace...")`, `getByRole("button", { name: "Select workspace" })` | `tests/ui/smoke-p0.test.ts` |
| UI-WS-002 | Select Default Workspace | Chooser visible | 1. Click Select workspace. 2. Click Default Workspace. 3. Wait chat input. | Chat input and send button visible | P0 | `@smoke @ui` | `getByRole("button", { name: "Select workspace" })`, `getByText("Default Workspace")`, `textarea, [contenteditable="true"]`, `[data-testid="send-button"]` | `tests/ui/smoke-p0.test.ts` |
| UI-CONV-001 | New chat form renders after workspace select | Workspace selected | 1. Select workspace. 2. Wait input. 3. Focus input. | Chat input visible/focused; send button visible | P0 | `@smoke @ui` | `textarea, [contenteditable="true"]`, `[data-testid="send-button"]` | `tests/ui/smoke-p0.test.ts` |
| UI-CONV-002 | Send message and receive reply | Agent available | 1. Type message. 2. Click send. 3. Wait assistant message. | User and assistant bubbles; non-empty reply | P0 | `@smoke @ui @slow` | `[data-testid="send-button"]`, `[data-testid="agent-message"]` | `tests/ui/smoke-p0.test.ts` |
| UI-CONV-005 | Stop streaming and recover | Streaming response | 1. Send long prompt. 2. Wait stop button. 3. Click stop. 4. Type “test”. | Stop disappears; input enabled; typed text retained | P0 | `@smoke @ui @slow` | `getByRole("button", { name: "Stop generation" })`, `textarea, [contenteditable="true"]` | `tests/ui/smoke-p0.test.ts` / `tests/ui/message-interrupt.test.ts` |
| UI-SB-003 | Settings button opens settings | Sidebar visible | 1. Hover sidebar footer. 2. Click “Settings” tooltip. 3. Assert Preferences tab. | Settings dialog opens | P0 | `@smoke @ui` | `[data-sidebar="sidebar"]`, `getByText("Settings")`, `getByRole("button", { name: "Preferences" })` | `tests/ui/smoke-p0.test.ts` / `tests/ui/settings-dialog.test.ts` |
| UI-SET-001 | Opens and closes via Escape | Sidebar visible | 1. Open settings. 2. Press Escape. | Dialog closes | P0 | `@smoke @ui` | `getByRole("button", { name: "Preferences" })` | `tests/ui/smoke-p0.test.ts` / `tests/ui/settings-dialog.test.ts` |
| UI-SET-002 | Renders expected tabs | Settings open | 1. Open settings. 2. Assert all tabs. | Preferences/Account/Appearance/Keyboard/Projects/Worktrees visible | P0 | `@smoke @ui` | `getByRole("button", { name: "Preferences" \| "Account" \| ... })` | `tests/ui/smoke-p0.test.ts` / `tests/ui/settings-dialog.test.ts` |
| UI-TB-001 | Task Board opens from sidebar | Sidebar visible | 1. Focus Task Board button. 2. Press Enter. 3. Assert heading. | Task Board heading visible | P0 | `@smoke @ui` | `getByRole("button", { name: "Task Board" })`, `getByRole("heading", { level: 1, name: "Task Board" })` | `tests/ui/smoke-p0.test.ts` / `tests/ui/interactive-workflows.test.ts` |

---

## 6. P1 scenario table (core regression)

| ID | Title | Preconditions | Steps | Expected | Priority | Tags | Key selectors | Suggested file |
|---|---|---|---|---|---|---|---|---|
| UI-NAV-004 | No critical console errors on idle | Launched | 1. Collect `pageerror`. 2. Wait 1s. 3. Filter ResizeObserver/favicon/404. | 0 critical errors | P1 | `@regression @ui` | `page.on("pageerror")` | `tests/ui/regression-p1.test.ts` |
| UI-NAV-008 | Collaboration mode tabs switch | Sidebar visible | 1. Locate tablist. 2. Activate non-active tab via keyboard. 3. Restore original. | `aria-selected` toggles correctly | P1 | `@regression @ui` | `getByRole("tablist", { name: "Collaboration mode" })`, `getByRole("tab", { name: "Supervisor" })`, `getByRole("tab", { name: "Group" })` | `tests/ui/regression-p1.test.ts` |
| UI-WS-003 | New Workspace resets to chooser | Workspace selected or launched | 1. Click New Workspace (keyboard). 2. Wait chooser. | Chooser text and Select workspace visible | P1 | `@regression @ui` | `getByRole("button", { name: "New Workspace" })`, `getByText("Choose a workspace...")` | `tests/ui/regression-p1.test.ts` |
| UI-WS-004 | Workspace selector opens and filters | Launched | 1. Click Select workspace. 2. Assert popover content. 3. Type query. 4. Press Escape. | Popover opens; list filters or empty state; closes on Escape | P1 | `@regression @ui` | `getByRole("button", { name: "Select workspace" })`, `getByPlaceholder("Search workspaces...")`, `getByText("Default Workspace")`, `getByText("No projects found.")` | `tests/ui/regression-p1.test.ts` (new: `tests/ui/workspace-selector.test.ts`) |
| UI-WS-005 | Selecting Default Workspace loads chat | Chooser visible | 1. Open selector. 2. Click Default Workspace. 3. Wait chat input. | Chat input and send button visible | P1 | `@regression @ui` | `getByText("Default Workspace")`, `textarea, [contenteditable="true"]`, `[data-testid="send-button"]` | `tests/ui/regression-p1.test.ts` |
| UI-WS-006 | Workspace search accepts input and Escape | Sidebar visible | 1. Focus search. 2. Type query. 3. Assert value. 4. Press Escape. | Input retains value and loses focus | P1 | `@regression @ui` | `getByPlaceholder("Search workspaces...")` | `tests/ui/regression-p1.test.ts` / `tests/ui/interactive-workflows.test.ts` |
| UI-AGT-001 | Manage Agents view opens | Sidebar visible | 1. Click Manage Agents (keyboard). 2. Assert heading. | Heading “Manage Agents” visible | P1 | `@regression @ui` | `getByRole("button", { name: "Manage Agents" })`, `getByRole("heading", { level: 1, name: "Manage Agents" })` | `tests/ui/regression-p1.test.ts` / `tests/ui/interactive-workflows.test.ts` |
| UI-AGT-002 | Add Agent control opens creation UI | Manage Agents view | 1. Click Add Agent button. 2. Assert creation UI or dialog. | Add-agent form/panel visible; no crash | P1 | `@regression @ui` | `getByRole("button", { name: "Add Agent" })` | `tests/ui/regression-p1.test.ts` (new: `tests/ui/agents-manage.test.ts`) |
| UI-CONV-003 | Send via Enter key | Chat input focused | 1. Type text. 2. Press Enter. 3. Assert user message or cleared input. | Message sent without explicit send button | P1 | `@regression @ui` | `textarea, [contenteditable="true"]`, `[data-testid="user-message"]` | `tests/ui/regression-p1.test.ts` / `tests/ui/conversation-flow.test.ts` |
| UI-CONV-004 | Empty message not sent | Chat input empty | 1. Ensure input empty. 2. Inspect send button. 3. Click if enabled. | Send disabled or no user-message added | P1 | `@regression @ui` | `[data-testid="send-button"]` (`aria-label="Send message"`), `[data-testid="user-message"]` | `tests/ui/regression-p1.test.ts` |
| UI-CONV-009 | @mention agent popover | Chat input focused | 1. Type “@”. 2. Wait listbox/menu. 3. Select or Escape. | Mention popover appears; closing returns focus to input | P1 | `@regression @ui` | `textarea, [contenteditable="true"]`, `getByRole("listbox")`, `getByRole("menu")` | `tests/ui/regression-p1.test.ts` (new: `tests/ui/mentions.test.ts`) |
| UI-SB-001 | Agents sidebar renders key controls | Launched | 1. Wait main. 2. Assert New Workspace, Task Board, Manage Agents. | All key controls visible | P1 | `@regression @ui` | `getByRole("button", { name: "New Workspace" })`, `getByRole("button", { name: "Task Board" })`, `getByRole("button", { name: "Manage Agents" })` | `tests/ui/regression-p1.test.ts` |
| UI-SB-002 | Sidebar collapse/expand | Sidebar visible | 1. Click Toggle sidebar if available. 2. Click again. 3. Assert app shell remains. | Toggle works or platform gracefully skips | P1 | `@regression @ui` | `getByRole("button", { name: "Toggle sidebar" })`, `getByRole("button", { name: "Close sidebar" })`, `[data-sidebar="sidebar"]` | `tests/ui/regression-p1.test.ts` |
| UI-SB-004 | Conversations sidebar mode (tabs) | Workspace selected | 1. Select workspace. 2. Assert Open chats pane button. | Tabs mode UI visible | P1 | `@regression @ui` | `getByRole("button", { name: "Open chats pane" })` | `tests/ui/regression-p1.test.ts` |
| UI-SB-005 | Conversations sidebar mode (sidebar) via localStorage | Launched | 1. Seed `agents-conversations-mode`. 2. Reload. 3. Assert conversation search input. 4. Reset mode. | Sidebar mode search input visible | P1 | `@regression @ui` | `[data-testid="conversation-search-input"]`, `getByPlaceholder(/search/i)` | `tests/ui/regression-p1.test.ts` / `tests/ui/conversation-sidebar.test.ts` |
| UI-SB-007 | New conversation button | Workspace selected | 1. Click new-conversation button. 2. Wait chat input. | New chat form/input visible | P1 | `@regression @ui` | `[data-testid="new-conversation-button"]`, `getByRole("button", { name: /new (chat|conversation)/i })`, `textarea, [contenteditable="true"]` | `tests/ui/regression-p1.test.ts` |
| UI-SET-003 | Tab switching updates aria-selected | Settings open | 1. Click Appearance. 2. Assert active. 3. Click Keyboard. 4. Assert active. | Active state follows click | P1 | `@regression @ui` | `getByRole("button", { name: "Appearance" })`, `getByRole("button", { name: "Keyboard" })` | `tests/ui/regression-p1.test.ts` / `tests/ui/settings-dialog.test.ts` |
| UI-TB-002 | Task Board back navigation | Task Board open | 1. Open Task Board. 2. Click Back to Task Board. 3. Assert heading hidden. | Returns from Task Board | P1 | `@regression @ui` | `getByRole("button", { name: "Task Board" })`, `getByRole("heading", { level: 1, name: "Task Board" })`, `getByRole("button", { name: "Back to Task Board" })` | `tests/ui/regression-p1.test.ts` |
| UI-CHG-001 | Changes panel renders | Chat with worktree | 1. Select workspace with repo. 2. Open details via desktop rail. 3. If available, open Git/Changes. | Changes/file list or status bar renders; no crash | P1 | `@regression @ui` | `page.locator('button[title="Detail"]')`, `getByRole("button", { name: "Close details" })`, `getByText("Git")` | `tests/ui/regression-p1.test.ts` (new: `tests/ui/changes.test.ts`) |
| UI-TERM-001 | Terminal sidebar opens | Chat with worktree | 1. Select workspace with repo. 2. Open terminal via rail/header. 3. Assert close/new terminal controls. | Terminal visible; cwd context available | P1 | `@regression @ui` | `page.locator('button[title="Terminal"]')`, `getByRole("button", { name: "Open terminal" })`, `getByRole("button", { name: "Close terminal" })`, `getByRole("button", { name: "New terminal" })` | `tests/ui/regression-p1.test.ts` (new: `tests/ui/terminal.test.ts`) |
| UI-DS-001 | Details sidebar opens/closes | Chat/new-chat with project | 1. Open details via rail or header. 2. Assert close button. 3. Close. | Panel toggles | P1 | `@regression @ui` | `page.locator('button[title="Detail"]')`, `getByRole("button", { name: "Open details" })`, `getByRole("button", { name: "Close details" })` | `tests/ui/regression-p1.test.ts` (new: `tests/ui/details-sidebar.test.ts`) |

---

## 7. P2/P3 scenario index (condensed)

All remaining scenario IDs from the original plan remain in scope. Their detailed steps are unchanged except where the selector catalog above supersedes them. They are currently grouped as:

| Group | IDs | Priority | Existing file |
|---|---|---|---|
| App navigation (extended) | UI-NAV-003, UI-NAV-005, UI-NAV-006, UI-NAV-007 | P2/P2/P2/P2 | `tests/ui/remaining-p3.test.ts` |
| Workspace (extended) | UI-WS-007, UI-WS-008, UI-WS-009 | P2 | `tests/ui/remaining-p3.test.ts` |
| Agents (extended) | UI-AGT-003..007 | P2 | `tests/ui/remaining-p3.test.ts` |
| Conversations (extended) | UI-CONV-006..017 | P2/P3 | `tests/ui/remaining-p3.test.ts`, `tests/ui/extended-p2.test.ts` |
| Sidebar (extended) | UI-SB-006, UI-SB-008, UI-SB-009 | P2 | `tests/ui/extended-p2.test.ts` |
| Settings (extended) | UI-SET-004..009 | P2/P3 | `tests/ui/remaining-p3.test.ts` |
| Task Board (extended) | UI-TB-003, UI-TB-004 | P2 | `tests/ui/remaining-p3.test.ts` |
| Kanban | UI-KAN-001..003 | P2/P3 | `tests/ui/extended-p2.test.ts` |
| Changes/Diff | UI-CHG-002..008 | P2/P3 | `tests/ui/extended-p2.test.ts` |
| Terminal | UI-TERM-002..005 | P2 | `tests/ui/extended-p2.test.ts` |
| File Viewer | UI-FV-001..005 | P2/P3 | `tests/ui/extended-p2.test.ts` |
| Details Sidebar | UI-DS-002..006 | P2/P3 | `tests/ui/extended-p2.test.ts` |
| Onboarding | UI-ONB-001..005 | P2/P3 | `tests/ui/extended-p2.test.ts` |
| Error/edge | UI-ERR-001..008 | P2/P3 | `tests/ui/remaining-p3.test.ts`, `tests/ui/extended-p2.test.ts` |

---

## 8. File assignment matrix

### Existing consolidated suites (keep for CI)

| File | Scope | Scenario IDs |
|---|---|---|
| `tests/ui/smoke-p0.test.ts` | P0 smoke | UI-NAV-001, 002; UI-WS-001, 002; UI-CONV-001, 002, 005; UI-SB-003; UI-SET-001, 002; UI-TB-001 |
| `tests/ui/regression-p1.test.ts` | P1 regression | UI-NAV-004, 008; UI-WS-003..006; UI-AGT-001, 002; UI-CONV-003, 004, 009; UI-SB-001, 002, 004, 005, 007; UI-SET-003; UI-TB-002; UI-CHG-001; UI-TERM-001; UI-DS-001 |
| `tests/ui/extended-p2.test.ts` | P2 feature coverage | UI-CONV-010..012, 016; UI-SB-006, 008, 009; UI-CHG-002..008; UI-TERM-002..005; UI-FV-001..005; UI-DS-002..006; UI-KAN-001..003; UI-ONB-001..005; UI-ERR-003..008 |
| `tests/ui/remaining-p3.test.ts` | P3/edge coverage | UI-NAV-003, 005..007; UI-WS-007..009; UI-AGT-003..007; UI-CONV-006, 007, 008, 013..015, 017; UI-SET-004..009; UI-TB-003, 004; UI-ERR-001, 002 |
| `tests/ui/interactive-workflows.test.ts` | Cross-cutting real UI | UI-NAV-008, UI-WS-006, UI-AGT-001, UI-TB-001 |
| `tests/ui/settings-dialog.test.ts` | Settings | UI-SB-003, UI-SET-001..003 |
| `tests/ui/message-interrupt.test.ts` | Interrupt | UI-CONV-005, 006, 007 |
| `tests/ui/conversation-sidebar.test.ts` | Sidebar rendering | UI-SB-004, 005, 006, 009 |
| `tests/ui/conversation-sidebar-mock.test.ts` | Mocked sidebar | UI-SB-005 (mock variant) |

### Recommended feature-focused additions (for stabilization)

Create these when strengthening weak P0/P1 scenarios:

| New file | Scenario IDs | Reason |
|---|---|---|
| `tests/ui/workspace-selector.test.ts` | UI-WS-003, UI-WS-004, UI-WS-005 | Isolate chooser/popover behavior from consolidated suites |
| `tests/ui/agents-manage.test.ts` | UI-AGT-001, UI-AGT-002 | Manage/add agent views are currently only smoke-level |
| `tests/ui/mentions.test.ts` | UI-CONV-009 | Popover behavior needs dedicated coverage |
| `tests/ui/changes.test.ts` | UI-CHG-001 | Requires worktree setup and platform-aware selectors |
| `tests/ui/terminal.test.ts` | UI-TERM-001 | Requires worktree setup and terminal controls |
| `tests/ui/details-sidebar.test.ts` | UI-DS-001 | Desktop rail selector differs from mobile |

---

## 9. Execution order

1. **Smoke (P0):** UI-NAV-001, UI-NAV-002, UI-WS-001, UI-WS-002, UI-CONV-001, UI-CONV-002, UI-CONV-005, UI-SB-003, UI-SET-001, UI-SET-002, UI-TB-001
2. **Core navigation/workspaces:** UI-NAV-004, UI-NAV-008, UI-WS-003..006
3. **Conversations/sidebar:** UI-CONV-003, 004, 009; UI-SB-001, 002, 004, 005, 007
4. **Settings:** UI-SET-003
5. **Advanced desktop features:** UI-TB-002, UI-CHG-001, UI-TERM-001, UI-DS-001
6. **Beta/edge/onboarding:** all P2/P3 groups

### Tagging

- `@smoke` = all P0 scenarios
- `@regression` = all P1 scenarios
- `@extended` = P2/P3 scenarios
- `@slow` = backend/model-dependent streaming tests
- `@ui` = all UI tests
- `@edge` = backend-down/error-boundary scenarios

### CI recommendation

- Run `@smoke` on every PR.
- Run `@regression` on PRs that touch renderer/sidebar/chat/settings.
- Run full `@ui` nightly on Linux Xvfb.
- Retry `@slow` twice.
- Keep `workers: 1`.

---

## 10. Interaction patterns to follow

1. **Keyboard activation first** for animated/overlayed controls:
   ```ts
   await locator.focus()
   await page.keyboard.press("Enter")
   ```
2. **Hover-to-reveal settings** using sidebar footer coordinate hover, then click `getByText("Settings")`.
3. **Prefer roles/text/testids** over CSS selectors.
4. **Avoid fixed waits**; use `toBeVisible({ timeout })` and `waitFor`.
5. **Reset localStorage** after tests that seed sidebar mode.
6. **Platform-aware selectors**:
   - Desktop details: `button[title="Detail"]`
   - Desktop terminal: `button[title="Terminal"]`
   - Mobile/new-chat header: `getByRole("button", { name: "Open details" })` / `getByRole("button", { name: "Open terminal" })`
7. **Backend-dependent tests** must `test.skip()` on backend/model errors rather than fail.
8. **Worktree-dependent tests** (changes/terminal) should skip gracefully when no repo is selected.

---

## 11. Recommended missing testids

Add these to improve stability:

- `stop-button` on the stop generation button
- `main-content` on the root layout container
- `task-board` on the Task Board root
- `changes-panel` on the Changes panel root
- `terminal-sidebar` on the Terminal sidebar root
- `details-sidebar` on the Details sidebar root
- `settings-dialog` on the Settings dialog root

---

## 12. Notes for implementers

- The original plan described “New Workspace dialog” and “workspace creation form” flows. The current app instead resets to a workspace chooser and creates workspaces through `WorkspaceSelector` (including “Default Workspace”). Update any new tests to follow Section 3 selectors.
- Desktop right-rail controls use `title` attributes, not ARIA labels. Do not use `getByRole("button", { name: "Open details" })` on desktop.
- Settings is not a native dialog button in the sidebar; it is tooltip-triggered from the sidebar footer.
- Changes and terminal scenarios require a selected repository/worktree; use the “Default Workspace” path or a seeded `/tmp/ergatai-e2e-*` project.
- Keep tests serial and reset selection with “New Workspace” between scenarios where possible.