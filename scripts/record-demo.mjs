#!/usr/bin/env node
/**
 * Record a short demo of the Ergatai desktop app with Playwright.
 *
 * The recording is produced by Playwright itself (`recordVideo` on the Electron
 * launch), so no Xvfb is needed on a machine with a graphical session. On a
 * headless box run it through `xvfb-run`.
 *
 * Usage:
 *   node scripts/record-demo.mjs --probe
 *   node scripts/record-demo.mjs --gif
 *   node scripts/record-demo.mjs --text "try chatting with Claude Code" \
 *     --agent opencode --side-agent "Claude Code" --gif --trim 1.2
 *
 * Options:
 *   --probe             Launch, print clickable buttons/editables, do not record.
 *   --text <text>       Prompt to type. Default: "Send a message to OpenCode using ergatai mcp sending content: hello".
 *   --agent <name>      Main agent to select. Default: "opencode".
 *   --side-agent <name> Agent logo on the right rail. Default: "Claude Code".
 *   --side-agent-timeout <ms> How long to wait for that logo. Default: 90000.
 *   --add-side-agent    If the logo never appears, add the agent via Details.
 *   --auto-approve      Click Approve on permission panels. Default: false.
 *   --no-auto-approve   Do not click permission panels.
 *   --hold <ms>         Keep recording after clicking the rail logo. Default: 20000.
 *   --lang <locale>     UI language: en, zh-CN, or system. Default: en.
 *   --keep-language     Keep the UI language after recording (default: restore).
 *   --no-send           Type the prompt but do not send it.
 *   (default)          Attach to an already-running Ergatai instance via CDP.
 *   --launch            Launch a new Electron process and record a demo video.
 *   --attach            Attach to an already-running instance (same as default).
 *   --video             In attach mode, record the app window to an MP4 (for editing).
 *   --video-fps <n>     Video frame rate. Default: 30.
 *   --cdp <url>         CDP endpoint for attach. Default: http://127.0.0.1:9222.
 *   --out <dir>         Output directory. Default: demo/videos.
 *   --name <base>       Base name for output files. Default: ergatai-demo.
 *   --width/--height    Video size. Default: 1400x900 (matches BrowserWindow).
 *   --gif               Convert the recording to GIF with ffmpeg.
 *   --trim <seconds>    Skip this many seconds at the start of the GIF.
 *   --fps <n>           GIF frame rate. Default: 12.
 *   --gif-width <px>    GIF width. Default: 1200.
 *   --keep-open <ms>    Keep the final frame on screen before closing. Default: 1200.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const { values: args } = parseArgs({
  options: {
    probe: { type: 'boolean', default: false },
    text: { type: 'string', default: 'Send a message to OpenCode using ergatai mcp sending content: hello' },
    agent: { type: 'string', default: 'Claude Code' },
    'side-agent': { type: 'string', default: 'OpenCode' },
    'side-agent-timeout': { type: 'string', default: '90000' },
    'add-side-agent': { type: 'boolean', default: false },
    'open-side': { type: 'boolean', default: true },
    'no-open-side': { type: 'boolean', default: false },
    'auto-approve': { type: 'boolean', default: false },
    'no-auto-approve': { type: 'boolean', default: false },
    hold: { type: 'string', default: '20000' },
    lang: { type: 'string', default: 'en' },
    'keep-language': { type: 'boolean', default: false },
    'no-send': { type: 'boolean', default: false },
    attach: { type: 'boolean', default: false },
    launch: { type: 'boolean', default: false },
    video: { type: 'boolean', default: false },
    'video-fps': { type: 'string', default: '30' },
    cdp: { type: 'string', default: 'http://127.0.0.1:9222' },
    out: { type: 'string', default: path.join('demo', 'videos') },
    name: { type: 'string', default: 'ergatai-demo' },
    width: { type: 'string', default: '1400' },
    height: { type: 'string', default: '900' },
    gif: { type: 'boolean', default: false },
    trim: { type: 'string', default: '0' },
    fps: { type: 'string', default: '12' },
    'gif-width': { type: 'string', default: '1200' },
    'keep-open': { type: 'string', default: '1200' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (args.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

const width = Number(args.width);
const height = Number(args.height);
const outDir = path.resolve(repoRoot, args.out);
const keepOpenMs = Number(args['keep-open']);
const language = args.lang;
if (!['en', 'zh-CN', 'system'].includes(language)) {
  fail(`--lang must be one of: en, zh-CN, system (got "${language}")`);
}
const languageEnv =
  language === 'zh-CN'
    ? { LANG: 'zh_CN.UTF-8', LANGUAGE: 'zh_CN:zh', LC_ALL: 'zh_CN.UTF-8' }
    : { LANG: 'en_US.UTF-8', LANGUAGE: 'en_US:en', LC_ALL: 'en_US.UTF-8' };
const electronLangArg = language === 'zh-CN' ? ['--lang=zh-CN'] : language === 'en' ? ['--lang=en-US'] : [];
const launchMode = args.launch || args.gif;
const attachMode = args.attach || !launchMode;
const openSideChat = args['open-side'] && !args['no-open-side'];
const frontendDir = process.env.FRONTEND_DIR
  ? path.resolve(process.env.FRONTEND_DIR)
  : path.join(repoRoot, 'frontend');
const electronPath = process.env.ELECTRON_PATH
  ? path.resolve(process.env.ELECTRON_PATH)
  : path.join(frontendDir, 'node_modules', 'electron', 'dist', 'electron');

const log = (...parts) => console.log('[demo]', ...parts);
const warn = (...parts) => console.warn('[demo]', ...parts);

function fail(message) {
  console.error(`[demo] ERROR: ${message}`);
  process.exit(1);
}

if (!attachMode && !fs.existsSync(electronPath)) {
  fail(`Electron binary not found at ${electronPath}. Run "npm install" in frontend/ or set ELECTRON_PATH.`);
}
if (!attachMode && !process.env.DISPLAY) {
  fail(
    'No DISPLAY found. On a headless machine run:\n' +
      '  xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/record-demo.mjs --gif',
  );
}

const { _electron } = await import('@playwright/test');

const launchOptions = {
  executablePath: electronPath,
  args: [
    frontendDir,
    ...electronLangArg,
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
  ],
  env: {
    ...process.env,
    ...(language === 'system' ? {} : languageEnv),
    ELECTRON_DISABLE_SANDBOX: 'true',
  },
  timeout: 60_000,
};

async function launch({ record }) {
  if (record) {
    fs.mkdirSync(outDir, { recursive: true });
    // Only replace this run's outputs; keep other recordings in the folder.
    fs.rmSync(path.join(outDir, `${args.name}.webm`), { force: true });
    fs.rmSync(path.join(outDir, `${args.name}.gif`), { force: true });
    launchOptions.recordVideo = { dir: outDir, size: { width, height } };
  }
  log(`launching ${path.relative(repoRoot, electronPath)}`);
  try {
    return await _electron.launch(launchOptions);
  } catch (error) {
    const text = String(error?.message || error);
    if (/Process failed to launch|electronApplication\.firstWindow|closed/i.test(text)) {
      throw new Error(
        `${text}\n\nHint: another Ergatai instance may be running (single-instance lock), ` +
          'or download the Claude/Codex binaries are missing. Close the app and retry.',
      );
    }
    throw error;
  }
}

async function attach() {
  const { chromium } = await import('@playwright/test');
  log(`attaching to ${args.cdp}`);
  const browser = await chromium.connectOverCDP(args.cdp);
  const contexts = browser.contexts();
  const context = contexts[0];
  if (!context) {
    await browser.close();
    throw new Error(`no browser context found at ${args.cdp}`);
  }
  const pickPage = () => {
    const pages = context.pages();
    return (
      pages.find((p) => /ergatai/i.test(p.url()) && !/devtools/i.test(p.url())) ||
      pages.find((p) => {
        try {
          return /ergatai/i.test(p.url());
        } catch {
          return false;
        }
      }) ||
      pages.find((p) => !/devtools/i.test(p.url())) ||
      pages[0]
    );
  };
  let page = pickPage();
  if (!page) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !page) {
      page = pickPage();
      if (!page) await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!page) {
    await browser.close();
    throw new Error(`no page found at ${args.cdp}; is Ergatai running with --remote-debugging-port?`);
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  log(`attached to page: ${await page.title().catch(() => '')}`);
  return { browser, page };
}

let videoRecordingState = null;

async function startVideoRecording(page) {
  fs.mkdirSync(outDir, { recursive: true });
  const videoPath = path.join(outDir, `${args.name}.mp4`);
  fs.rmSync(videoPath, { force: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ergatai-rec-'));
  const state = { recording: true, frames: [], dir, page, videoPath, done: null };
  state.done = (async () => {
    let i = 0;
    while (state.recording) {
      const t0 = Date.now();
      try {
        const file = path.join(state.dir, `frame_${String(i).padStart(6, '0')}.jpg`);
        await state.page.screenshot({ path: file, type: 'jpeg', quality: 80 });
        state.frames.push({ file, time: t0 });
        i += 1;
      } catch {
        // page may be navigating; skip frame
      }
      // Capture as fast as possible; screenshot itself paces the loop.
      await new Promise((r) => setTimeout(r, 0));
    }
  })();
  videoRecordingState = state;
  await new Promise((resolve) => setTimeout(resolve, 200));
  log(`recording via screenshots (variable frame rate)`);
  return videoPath;
}

async function stopVideoRecording() {
  const state = videoRecordingState;
  videoRecordingState = null;
  if (!state) return;
  state.recording = false;
  if (state.done) await state.done.catch(() => {});

  const fps = Number(args['video-fps'] || 30);
  const videoPath = state.videoPath;
  if (state.frames.length === 0) {
    warn('no frames captured; skipping encode');
    try { fs.rmSync(state.dir, { recursive: true, force: true }); } catch {}
    return;
  }

  // Build a concat demuxer list with per-frame durations so playback speed
  // matches the real capture timing (variable frame rate).
  const listPath = path.join(state.dir, 'frames.txt');
  const lines = [];
  for (let i = 0; i < state.frames.length; i += 1) {
    const f = state.frames[i];
    const next = state.frames[i + 1];
    const dur = next ? Math.max(0.01, (next.time - f.time) / 1000) : 1 / fps;
    lines.push(`file '${f.file}'`);
    lines.push(`duration ${dur.toFixed(3)}`);
  }
  fs.writeFileSync(listPath, lines.join('\n'));

  log(`encoding ${state.frames.length} frames -> ${path.relative(repoRoot, videoPath)}`);
  const result = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-vsync', 'vfr',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      videoPath,
    ],
    { stdio: 'inherit' },
  );
  if (result.error) warn(`ffmpeg failed: ${result.error.message}`);
  if (result.status !== 0) warn(`ffmpeg exited with ${result.status}`);

  try { fs.rmSync(state.dir, { recursive: true, force: true }); } catch {}
}

async function acquire({ record }) {
  if (attachMode) {
    const { browser, page } = await attach();
    return { app: null, browser, page, video: null };
  }
  const app = await launch({ record });
  const page = await getPage(app);
  const video = record ? page.video() : null;
  if (record && !video) warn('Playwright did not return a video handle.');
  return { app, browser: null, page, video };
}

async function getPage(app) {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setDefaultTimeout(15_000);
  return page;
}

async function forceContentSize(app) {
  try {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0];
        win?.setContentSize(size.width, size.height);
      },
      { width, height },
    );
  } catch (error) {
    warn(`could not set content size: ${error.message}`);
  }
}

const LANGUAGE_STORAGE_KEY = 'app-language-preference';

function parseStoredLanguage(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (value === 'en' || value === 'zh-CN' || value === 'system') return value;
  } catch {
    // Older builds stored a plain string.
  }
  return raw === 'en' || raw === 'zh-CN' || raw === 'system' ? raw : null;
}

/**
 * The renderer reads its language from localStorage before React mounts. If the
 * stored preference disagrees with --lang, persist the new value and reload so
 * the recording does not contain Chinese UI (or vice versa).
 */
async function applyLanguage(page, target) {
  if (target === 'system') return null;

  const before = await page.evaluate((key) => localStorage.getItem(key), LANGUAGE_STORAGE_KEY);
  const stored = parseStoredLanguage(before);
  const navigatorLanguage = await page.evaluate(() => navigator.language || '');
  const resolved =
    stored && stored !== 'system'
      ? stored
      : navigatorLanguage.toLowerCase().startsWith('zh')
        ? 'zh-CN'
        : 'en';

  if (resolved === target) {
    log(`UI language: ${target}`);
    return { before, changed: false };
  }

  log(`UI language: ${resolved} -> ${target} (renderer reload)`);
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: LANGUAGE_STORAGE_KEY, value: target },
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  return { before, changed: true };
}

async function restoreLanguage(page, state) {
  if (!state?.changed || args['keep-language']) return;
  await page
    .evaluate(
      ({ key, value }) => {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      },
      { key: LANGUAGE_STORAGE_KEY, value: state.before },
    )
    .catch(() => {});
}

function findEditor(page) {
  return page
    .locator('[contenteditable="true"][role="button"], [contenteditable="true"]')
    .first();
}

async function dumpProbe(page) {
  const snapshot = await page.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };
    return {
      language: {
        storedPreference: localStorage.getItem('app-language-preference'),
        navigatorLanguage: navigator.language,
        documentLanguage: document.documentElement.lang,
      },
      buttons: [...document.querySelectorAll('button')]
        .map((el) => ({
          aria: el.getAttribute('aria-label'),
          title: el.getAttribute('title'),
          text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
          ...rect(el),
        }))
        .filter((b) => b.w > 0 && b.h > 0),
      editables: [...document.querySelectorAll('[contenteditable="true"]')]
        .map((el) => ({
          placeholder: el.previousElementSibling?.textContent?.trim().slice(0, 50) || null,
          text: (el.textContent || '').trim().slice(0, 50),
          ...rect(el),
        }))
        .filter((e) => e.w > 0 && e.h > 0),
    };
  });

  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  const probeFile = path.join(path.dirname(outDir), 'probe.json');
  fs.writeFileSync(probeFile, JSON.stringify(snapshot, null, 2));

  console.log(
    `\nLanguage: stored=${JSON.stringify(snapshot.language.storedPreference)} ` +
      `navigator=${snapshot.language.navigatorLanguage} html=${snapshot.language.documentLanguage}`,
  );
  console.log('\nVisible buttons (aria / title / text / x,y):');
  for (const b of snapshot.buttons) {
    const label = [b.aria && `aria="${b.aria}"`, b.title && `title="${b.title}"`, b.text && `text="${b.text}"`]
      .filter(Boolean)
      .join(' ');
    console.log(`  (${b.x},${b.y}) ${label || '<icon-only>'}`);
  }
  console.log('\nContenteditable elements (placeholder / text / x,y):');
  for (const e of snapshot.editables) {
    console.log(`  (${e.x},${e.y}) placeholder="${e.placeholder || ''}" text="${e.text}"`);
  }
  console.log(`\nSaved to ${path.relative(repoRoot, probeFile)}`);
}

function agentNamePattern(name) {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  return new RegExp(parts.map(escapeRegExp).join('[\\s_-]*'), 'i');
}

async function findAgentTrigger(page) {
  // Both the agent selector and the model selector live in `.model-controls`.
  // The agent selector is the leftmost one; `.first()` is not stable after the
  // app restores a previous chat, so compare positions instead.
  const buttons = page.locator('[class*="model-controls"] button[aria-label]');
  const count = await buttons.count();
  let best = null;
  let bestX = Infinity;
  const modeLabels = new Set(['Ask', 'Auto', 'AutoBash', 'Full Access']);
  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    if (!(await button.isVisible().catch(() => false))) continue;
    const label = await button.getAttribute('aria-label').catch(() => null);
    if (label && modeLabels.has(label)) continue;
    const box = await button.boundingBox().catch(() => null);
    if (!box) continue;
    if (box.x < bestX) {
      bestX = box.x;
      best = button;
    }
  }
  return best;
}

async function goToNewChat(page) {
  const button = page
    .getByRole('button', { name: /^(New Chat|新建对话)$/ })
    .first();
  if (!(await button.isVisible().catch(() => false))) return;
  log('opening New Chat');
  await button.click();
  await page.waitForTimeout(1_000);
}

function startAutoApprover(page) {
  if (!args['auto-approve'] || args['no-auto-approve']) return () => {};
  let stopped = false;
  let busy = false;
  const timer = setInterval(async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      // The permission panel always shows Deny + Approve together. Requiring
      // Deny avoids clicking the plan widget's "Approve" button.
      const deny = page.getByRole('button', { name: /^Deny$/ }).first();
      const approve = page.getByRole('button', { name: /^Approve$/ }).first();
      if (
        (await deny.isVisible().catch(() => false)) &&
        (await approve.isVisible().catch(() => false))
      ) {
        log('permission request detected: approving');
        await approve.click({ timeout: 2_000 });
        await page.waitForTimeout(400);
      }
    } catch {
      // The panel may disappear between the visibility check and the click.
    } finally {
      busy = false;
    }
  }, 700);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function selectAgent(page, agent) {
  const trigger = await findAgentTrigger(page);
  if (!trigger) {
    log(`agent selector not available in this UI; skipping (target "${agent}")`);
    return true;
  }
  log(`agent selector: ${await trigger.getAttribute('aria-label')}`);
  await trigger.click();
  await page.waitForTimeout(350);

  const popover = page.locator('[data-radix-popper-content-wrapper]').last();
  await popover.waitFor({ state: 'visible' });
  const nameRe = agentNamePattern(agent);
  let option = popover.getByRole('button', { name: nameRe });
  if ((await option.count()) === 0) {
    option = popover.getByRole('menuitem', { name: nameRe });
  }
  if ((await option.count()) === 0) {
    warn(`could not find agent "${agent}" in popover. Visible options:`);
    console.warn((await popover.innerText()).trim());
    await page.keyboard.press('Escape');
    return false;
  }
  await option.first().click();
  await page.waitForTimeout(700);
  log(`selected agent "${agent}"`);
  return true;
}

async function setPermissionMode(page, targetLabel = 'AutoBash') {
  const modeLabels = ['Ask', 'Auto', 'AutoBash', 'Full Access'];
  let trigger = null;
  for (const label of modeLabels) {
    const loc = page.getByRole('button', { name: new RegExp(`^${label}$`) }).first();
    if (await loc.count()) {
      trigger = loc;
      break;
    }
  }
  if (!trigger) {
    trigger = page.locator('button:has(svg.lucide-shield)').first();
  }
  if (!trigger || (await trigger.count()) === 0) {
    warn('permission mode selector not found');
    return false;
  }
  const current = await trigger.getAttribute('aria-label').catch(() => null);
  if (current === targetLabel) {
    log(`permission mode already ${targetLabel}`);
    return true;
  }
  await trigger.click();
  await page.waitForTimeout(300);
  const option = page.getByRole('button', { name: new RegExp(`^${targetLabel}\\b`) }).last();
  if (!(await option.isVisible().catch(() => false))) {
    warn(`permission mode option "${targetLabel}" not visible`);
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await option.click();
  await page.waitForTimeout(300);
  log(`permission mode set to ${targetLabel}`);
  return true;
}

async function findRightRailButton(page, nameRe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const buttons = page.locator('button[title]');
    const count = await buttons.count();
    let best = null;
    let bestX = -Infinity;
    for (let i = 0; i < count; i += 1) {
      const button = buttons.nth(i);
      if (!(await button.isVisible().catch(() => false))) continue;
      const title = await button.getAttribute('title');
      if (!title || !nameRe.test(title)) continue;
      const box = await button.boundingBox().catch(() => null);
      if (!box) continue;
      if (box.x > bestX) {
        bestX = box.x;
        best = { locator: button, title, x: Math.round(box.x) };
      }
    }
    if (best) return best;
    await page.waitForTimeout(400);
  }
  return null;
}

const SIDE_CHAT_CLOSE = 'button[aria-label="Close chat"], button[aria-label="关闭对话"]';
const NEW_AGENT = 'button[aria-label="New agent"], button[aria-label="新建 Agent"]';
const DETAILS_RAIL = 'button[title="Detail"], button[title="详情"]';

async function waitForSideChat(page, visible, timeoutMs = 15_000) {
  const close = page.locator(SIDE_CHAT_CLOSE).first();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const isVisible = await close.isVisible().catch(() => false);
    if (isVisible === visible) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/**
 * New chats only bind the primary agent, so a side-agent logo does not exist
 * yet. Add the agent through Details -> Agents -> New agent; this is the same
 * action a user performs and it creates the binding that the rail reads.
 */
async function ensureSideAgent(page, name) {
  let newAgent = page.locator(NEW_AGENT).first();
  if (!(await newAgent.isVisible().catch(() => false))) {
    const details = page.locator(DETAILS_RAIL).first();
    if (await details.isVisible().catch(() => false)) {
      await details.click();
      await page.waitForTimeout(600);
    }
  }

  newAgent = page.locator(NEW_AGENT).first();
  if (!(await newAgent.isVisible().catch(() => false))) {
    warn('could not find the "New agent" button in the Details sidebar');
    return false;
  }
  if (!(await waitForEnabled(newAgent, 8_000))) {
    warn('the "New agent" button stayed disabled');
    return false;
  }

  await newAgent.click();
  await page.waitForTimeout(450);
  const item = page.getByRole('menuitem', { name: agentNamePattern(name) });
  if ((await item.count()) === 0) {
    const labels = await page
      .locator('[role="menuitem"]')
      .evaluateAll((els) => els.map((el) => (el.textContent || '').trim()).filter(Boolean));
    warn(`agent "${name}" is not available in the New agent menu: ${JSON.stringify(labels)}`);
    await page.keyboard.press('Escape');
    return false;
  }

  log(`adding side agent "${name}" (this starts the agent)...`);
  await item.first().click();
  await page.waitForTimeout(3_000);
  return true;
}

async function waitForEnabled(locator, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await locator.isEnabled().catch(() => false)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/**
 * `pressSequentially` drops spaces in this contenteditable on Chromium/Electron.
 * `keyboard.insertText` keeps them and still fires input events, so the editor
 * sees the same text a human would type.
 */
async function typeIntoEditor(page, editor, text, delayMs = 35) {
  await editor.click();
  await page.waitForTimeout(150);
  for (const char of text) {
    await page.keyboard.insertText(char);
    if (delayMs > 0) await page.waitForTimeout(delayMs);
  }
}

async function dismissOnboardingGuide(page) {
  const dismiss = page
    .locator('button[aria-label="Dismiss"], button[aria-label="忽略"]')
    .last();
  if ((await dismiss.count()) === 0) return;
  if (!(await dismiss.isVisible().catch(() => false))) return;
  log('dismissing onboarding card');
  await dismiss.click();
  await page.waitForTimeout(300);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function convertToGif(videoPath, gifPath) {
  const filter =
    `fps=${Number(args.fps)},scale=${Number(args['gif-width'])}:-1:flags=lanczos,` +
    'split[a][b];[a]palettegen=max_colors=160[p];[b][p]paletteuse=dither=bayer:bayer_scale=5';
  const ffmpegArgs = ['-y'];
  if (Number(args.trim) > 0) ffmpegArgs.push('-ss', String(Number(args.trim)));
  ffmpegArgs.push('-i', videoPath, '-vf', filter, '-loop', '0', gifPath);

  log(`ffmpeg ${ffmpegArgs.join(' ')}`);
  const result = spawnSync('ffmpeg', ffmpegArgs, { stdio: 'inherit' });
  if (result.error) {
    warn(`ffmpeg failed: ${result.error.message}`);
    return null;
  }
  if (result.status !== 0) {
    warn(`ffmpeg exited with ${result.status}`);
    return null;
  }
  return gifPath;
}

// ---------------------------------------------------------------------------
// Probe mode: launch, inspect the UI, print selectors, never click anything.
// ---------------------------------------------------------------------------
if (args.probe) {
  const { app, browser, page: initialPage } = await acquire({ record: false });
  let page = initialPage;
  let languageState = null;
  try {
    languageState = await applyLanguage(page, language);
    await goToNewChat(page);
    await page.waitForTimeout(2_500);
    const editor = findEditor(page);
    log(`new-chat editor found: ${await editor.isVisible().catch(() => false)}`);
    await dumpProbe(page);
  } finally {
    if (page) await restoreLanguage(page, languageState);
    if (app) await app.close();
    if (browser) await browser.close();
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Record mode
// ---------------------------------------------------------------------------
let app = null;
let browser = null;
let video = null;
let failed = false;
let page = null;
let recordedVideoPath = null;
let languageState = null;
let stopAutoApprove = () => {};

let manualStopResolve = null;
const manualStopPromise = new Promise((resolve) => {
  manualStopResolve = resolve;
});
let manualStopRequested = false;
process.on('SIGINT', () => {
  if (manualStopRequested) return;
  manualStopRequested = true;
  console.log('\n[demo] Ctrl+C received, finalizing recording...');
  if (manualStopResolve) manualStopResolve();
});
process.on('SIGTERM', () => {
  if (manualStopResolve) manualStopResolve();
});

try {
  const acquired = await acquire({ record: true });
  app = acquired.app;
  browser = acquired.browser;
  page = acquired.page;
  video = acquired.video;
  if (attachMode && args.video) {
    recordedVideoPath = await startVideoRecording(page);
  }
  languageState = await applyLanguage(page, language);
  await goToNewChat(page);
  if (app) await forceContentSize(app);
  await page.waitForTimeout(800);

  const editor = findEditor(page);
  await editor.waitFor({ state: 'visible', timeout: 30_000 });
  log('new-chat input visible');
  await dismissOnboardingGuide(page);
  await editor.fill('').catch(() => {});
  stopAutoApprove = startAutoApprover(page);

  // 1. Focus the composer.
  await editor.click();
  await page.waitForTimeout(500);

  // 2. No agent selection at start; only adjust permission mode to AutoBash.
  log(`main agent: ${args.agent}; side agent: ${args['side-agent']}`);
  await setPermissionMode(page, 'AutoBash');
  // 3. Type the prompt with a visible typing rhythm.
  log(`typing: ${args.text}`);
  await typeIntoEditor(page, editor, args.text, 35);
  await page.waitForTimeout(900);

  // 4. Send unless explicitly disabled.
  if (!args['no-send']) {
    const sendButton = page.getByTestId('send-button');
    await sendButton.waitFor({ state: 'visible' });
    if (await waitForEnabled(sendButton)) {
      await sendButton.click();
      log('message sent');
    } else {
      warn('send button stayed disabled, pressing Enter instead');
      await editor.press('Enter');
    }
    await page.waitForTimeout(1_500);
    await page
      .getByTestId('user-message')
      .last()
      .waitFor({ state: 'visible', timeout: 20_000 })
      .catch(() => warn('user message did not appear (agent may still be starting)'));
  } else {
    log('--no-send: skipping send and rail click');
    await page.waitForTimeout(1_500);
  }

  // 5. Wait for the side-agent logo on the right rail. Permissions are
  // approved in the background while we wait; do not rush the UI.
  if (!args['no-send']) {
    const sideRe = agentNamePattern(args['side-agent']);
    log(`waiting for right-rail agent "${args['side-agent']}"...`);
    let railButton = await findRightRailButton(
      page,
      sideRe,
      Number(args['side-agent-timeout']),
    );

    if (!railButton && args['add-side-agent']) {
      const added = await ensureSideAgent(page, args['side-agent']);
      if (added) {
        const sideChatOpen = await waitForSideChat(page, true, 15_000);
        if (sideChatOpen) {
          log('closing the auto-opened side chat so the rail click is the visible action');
          await page.locator(SIDE_CHAT_CLOSE).first().click();
          await waitForSideChat(page, false, 5_000);
        }
        railButton = await findRightRailButton(
          page,
          sideRe,
          Number(args['side-agent-timeout']),
        );
      }
    }

    if (railButton) {
      log(`rail agent "${railButton.title}" appeared; clicking in 700ms`);
      await page.waitForTimeout(700);
      log(`clicking rail agent "${railButton.title}" at x=${railButton.x}`);
      await railButton.locator.click();
      if (openSideChat) {
        const opened = await waitForSideChat(page, true, 10_000);
        if (!opened) warn('side chat did not open after clicking the rail logo');
      } else {
        log('not opening side chat (--no-open-side)');
      }
      if (attachMode && args.video) {
        log('recording... press Ctrl+C in terminal to stop and save');
      } else {
        log(`holding for ${Number(args.hold)}ms while the side agent runs...`);
        await page.waitForTimeout(Number(args.hold));
      }
    } else {
      failed = true;
      warn(`no right-rail button titled "${args['side-agent']}" found.`);
      warn('The side agent must be bound to this chat (not the primary agent).');
      const titles = await page
        .locator('button[title]')
        .evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().width > 0).map((el) => el.getAttribute('title')));
      warn(`visible button titles: ${JSON.stringify([...new Set(titles)])}`);
      if (!(attachMode && args.video)) {
        await page.waitForTimeout(keepOpenMs);
      } else {
        log('recording... press Ctrl+C in terminal to stop and save');
      }
    }
  }

  if (attachMode && args.video) {
    log('Recording in progress. Press Ctrl+C in terminal to stop and save the video.');
    await manualStopPromise;
  }

  await page.waitForTimeout(300);
} catch (error) {
  failed = true;
  console.error('[demo] flow failed:', error);
  try {
    if (!page && app) page = await app.firstWindow();
    if (page) await dumpProbe(page);
  } catch {
    // ignore probe failure
  }
} finally {
  stopAutoApprove();
  await stopVideoRecording().catch(() => {});
  if (page) await restoreLanguage(page, languageState);
  if (app) await app.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}

if (attachMode) {
  if (recordedVideoPath) {
    log(`video: ${path.relative(repoRoot, recordedVideoPath)}`);
  } else {
    log('attach mode: UI operations finished (no video recorded).');
  }
  process.exit(failed ? 1 : 0);
}

if (!video) {
  fail(`recording finished but no video handle was available. Check ${outDir}`);
}

let videoPath;
try {
  videoPath = await video.path();
} catch (error) {
  warn(`video.path() failed: ${error.message}`);
  const files = fs
    .readdirSync(outDir)
    .filter((file) => file.endsWith('.webm'))
    .map((file) => path.join(outDir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  videoPath = files[0];
}

if (!videoPath || !fs.existsSync(videoPath)) {
  fail(`no .webm found in ${outDir}`);
}

const finalVideoPath = path.join(outDir, `${args.name}.webm`);
if (path.resolve(videoPath) !== path.resolve(finalVideoPath)) {
  fs.rmSync(finalVideoPath, { force: true });
  fs.renameSync(videoPath, finalVideoPath);
  videoPath = finalVideoPath;
}

log(`video: ${path.relative(repoRoot, videoPath)} (${(fs.statSync(videoPath).size / 1024).toFixed(0)} KB)`);

if (args.gif) {
  const gifPath = path.join(outDir, `${args.name}.gif`);
  const converted = convertToGif(videoPath, gifPath);
  if (converted) {
    log(`gif:   ${path.relative(repoRoot, converted)} (${(fs.statSync(converted).size / 1024).toFixed(0)} KB)`);
  }
}

if (failed) {
  console.error('[demo] finished with warnings; the recording is still saved.');
  process.exitCode = 1;
}
