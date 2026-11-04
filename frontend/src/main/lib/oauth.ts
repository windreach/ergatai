import {
  createHash,
  randomBytes
} from 'crypto';
import {
  shell
} from 'electron';
import {
  createServer,
  type Server
} from 'http';
import {
  URL
} from 'url';
import {
  getOAuthClientId
} from './config';
import {
  TIMEOUT
} from './config/timeouts';

export interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

export interface OAuthConfig {
  mcpBaseUrl: string; // e.g., http://localhost:3000/v1/links/abc123
  redirectUri?: string; // Optional custom redirect URI for deeplinks
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
}

export interface OAuthCallbacks {
  onStatus: (message: string) => void;
  onError: (error: string) => void;
}

const CALLBACK_PATH = '/callback';
// Client names for OAuth registration
// Some MCP servers (like Figma) have an allowlist - try 'ergatai' first, fall back to 'Codex'
const CLIENT_NAME = 'ergatai';
const FALLBACK_CLIENT_NAME = 'Codex';

/**
 * Generate a styled OAuth callback page with terminal emulator aesthetic
 * Matches application design with Tokyo Night theme
 */
function generateOAuthPage(options: {
  title: string;
  message: string;
  isSuccess: boolean;
  autoClose?: boolean;
  errorDetail?: string;
}): string {
  const { title, isSuccess, autoClose = false, errorDetail } = options;

  // Terminal output line type
  interface TerminalLine {
    text: string;
    status?: string;
    statusClass?: string;
    isHighlight?: boolean;
    highlightColor?: 'green' | 'red';
    hasCursor?: boolean;
    isError?: boolean;
  }

  // Terminal output lines based on success/error
  const terminalLines: TerminalLine[] = isSuccess
    ? [
        { text: 'initiating handshake sequence...' },
        { text: 'verifying credentials', status: '[PROCESSING]', statusClass: 'status-wait' },
        { text: 'token exchange completed', status: '[OK]', statusClass: 'status-ok' },
        { text: 'AUTHORIZATION SUCCESSFUL', isHighlight: true, highlightColor: 'green' },
        { text: 'closing connection', hasCursor: true },
      ]
    : [
        { text: 'initiating handshake sequence...' },
        { text: 'verifying credentials', status: '[PROCESSING]', statusClass: 'status-wait' },
        { text: 'token exchange failed', status: '[ERROR]', statusClass: 'status-error' },
        { text: 'AUTHORIZATION FAILED', isHighlight: true, highlightColor: 'red' },
        ...(errorDetail ? [{ text: `error: ${errorDetail}`, isError: true }] : []),
      ];

  const terminalLinesHtml = terminalLines.map((line, i) => {
    let content = '';
    if (line.isHighlight) {
      const color = line.highlightColor === 'green' ? 'var(--green)' : 'var(--red)';
      const glow = line.highlightColor === 'green'
        ? 'rgba(158, 206, 106, 0.4)'
        : 'rgba(247, 118, 142, 0.4)';
      content = `<span class="cmd-text" style="color: ${color}; text-shadow: 0 0 10px ${glow};">${line.text}</span>`;
    } else if (line.isError) {
      content = `<span class="cmd-text" style="color: var(--red);">${line.text}</span>`;
    } else {
      content = `<span class="cmd-text">${line.text}${line.status ? ` <span class="${line.statusClass}">${line.status}</span>` : ''}${line.hasCursor ? ' <span class="cursor"></span>' : ''}</span>`;
    }
    return `        <div class="line" style="animation-delay: ${0.2 + i * 0.4}s;">
          <span class="prompt">➜</span>
          <span class="path">~</span>
          ${content}
        </div>`;
  }).join('\n');

  const progressSection = autoClose ? `
      <div class="progress-section">
        <div class="timer-info">
          <span>Session Autokill</span>
          <span id="countdown-text">3.0s</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" id="progress-fill"></div>
        </div>
      </div>` : '';

  const autoCloseScript = autoClose ? `
    // Countdown Logic
    setTimeout(() => {
      const duration = 3000;
      const start = Date.now();
      const progressFill = document.getElementById('progress-fill');
      const countdownText = document.getElementById('countdown-text');

      const tick = () => {
        const elapsed = Date.now() - start;
        const remaining = Math.max(0, duration - elapsed);
        const percent = Math.min(100, (elapsed / duration) * 100);

        if(progressFill) progressFill.style.width = percent + '%';
        if(countdownText) countdownText.textContent = (remaining / 1000).toFixed(1) + 's';

        if (elapsed < duration) {
          requestAnimationFrame(tick);
        } else {
          window.close();
        }
      };

      requestAnimationFrame(tick);
    }, 2200);` : '';

  const logoColor = isSuccess ? 'var(--blue)' : 'var(--red)';
  const logoGlow = isSuccess
    ? 'rgba(122, 162, 247, 0.3)'
    : 'rgba(247, 118, 142, 0.3)';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Craft - ${title}</title>
  <style>
    :root {
      /* Tokyo Night Palette */
      --bg: #1a1b26;
      --bg-dark: #16161e;
      --bg-lighter: #24283b;
      --fg: #c0caf5;
      --comment: #565f89;
      --blue: #7aa2f7;
      --cyan: #7dcfff;
      --green: #9ece6a;
      --magenta: #bb9af7;
      --red: #f7768e;
      --yellow: #e0af68;
      --orange: #ff9e64;
      --terminal-black: #414868;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 0;
      width: 100vw;
      height: 100vh;
      background-color: var(--bg);
      color: var(--fg);
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      position: relative;
    }

    /* CRT Scanline Effect */
    body::before {
      content: "";
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: linear-gradient(
        to bottom,
        rgba(18, 16, 16, 0) 50%,
        rgba(0, 0, 0, 0.25) 50%
      );
      background-size: 100% 4px;
      z-index: 20;
      pointer-events: none;
      opacity: 0.15;
    }

    /* CRT Flicker */
    @keyframes flicker {
      0% { opacity: 0.98; }
      5% { opacity: 0.95; }
      10% { opacity: 0.98; }
      100% { opacity: 0.98; }
    }

    .terminal-window {
      width: 90%;
      max-width: 850px;
      height: 70vh;
      min-height: 500px;
      background: rgba(22, 22, 30, 0.95);
      border: 1px solid var(--terminal-black);
      box-shadow:
        0 0 40px rgba(0, 0, 0, 0.6),
        0 0 10px rgba(0, 0, 0, 0.4),
        0 0 0 1px rgba(122, 162, 247, 0.05);
      border-radius: 6px;
      position: relative;
      z-index: 10;
      display: flex;
      flex-direction: column;
      animation: bootUp 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
      overflow: hidden;
      backdrop-filter: blur(4px);
    }

    .title-bar {
      background: var(--bg-lighter);
      border-bottom: 1px solid var(--terminal-black);
      padding: 10px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      user-select: none;
    }

    .title-text {
      color: var(--comment);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.5px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .window-controls {
      display: flex;
      gap: 8px;
    }

    .control {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      position: relative;
    }
    .control.close { background: var(--red); }
    .control.minimize { background: var(--yellow); }
    .control.maximize { background: var(--green); }

    .content {
      padding: 30px;
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow-y: auto;
      animation: flicker 4s infinite;
    }

    .meta-info {
      width: 100%;
      text-align: left;
      font-size: 12px;
      color: var(--comment);
      margin-bottom: 30px;
      border-bottom: 1px dashed var(--terminal-black);
      padding-bottom: 15px;
      opacity: 0.8;
    }

    .logo-container {
      margin-bottom: 30px;
      width: 100%;
      display: flex;
      justify-content: center;
      overflow-x: auto;
      padding-bottom: 10px;
    }

    .logo {
      color: ${logoColor};
      font-weight: 700;
      font-size: 12px;
      line-height: 1;
      white-space: pre;
      text-align: left;
      text-shadow: 0 0 15px ${logoGlow};
      letter-spacing: normal;
    }

    .terminal-output {
      width: 100%;
      max-width: 600px;
      text-align: left;
      font-size: 14px;
      line-height: 1.8;
    }

    .line {
      display: flex;
      gap: 12px;
      margin-bottom: 6px;
      opacity: 0;
      animation: typeLine 0.1s forwards;
    }

    .prompt { color: var(--magenta); font-weight: bold; }
    .path { color: var(--blue); }
    .cmd-text { color: var(--fg); text-shadow: 0 0 2px rgba(192, 202, 245, 0.2); }

    .status-ok { color: var(--green); font-weight: bold; }
    .status-wait { color: var(--yellow); }
    .status-error { color: var(--red); font-weight: bold; }
    .highlight { color: var(--cyan); }

    .cursor {
      display: inline-block;
      width: 8px;
      height: 1.2em;
      background: var(--fg);
      vertical-align: sub;
      margin-left: 8px;
      opacity: 0;
    }

    .line:last-child .cursor {
      animation: blink 1s step-end infinite, appear 0.1s forwards 2.2s;
    }

    .progress-section {
      margin-top: 40px;
      width: 100%;
      max-width: 450px;
      opacity: 0;
      animation: fadeIn 0.5s forwards 2.0s;
    }

    .progress-bar {
      height: 2px;
      background: var(--bg-lighter);
      margin-top: 10px;
      position: relative;
    }

    .progress-fill {
      height: 100%;
      width: 0%;
      background: var(--green);
      box-shadow: 0 0 15px var(--green);
    }

    .timer-info {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--comment);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    /* Mobile Responsive Styles */
    @media (max-width: 640px) {
      body {
        align-items: flex-start;
        padding-top: 0;
        background: var(--bg-dark);
      }

      .terminal-window {
        width: 100%;
        height: 100vh;
        max-width: none;
        border-radius: 0;
        border: none;
        box-shadow: none;
      }

      .title-bar {
        padding: 12px 15px;
      }

      .content {
        padding: 20px 15px;
        justify-content: flex-start;
      }

      .logo {
        font-size: 2.2vw;
        align-self: center;
      }

      @media (max-width: 400px) {
        .logo { font-size: 1.9vw; }
      }

      .terminal-output {
        font-size: 12px;
        margin-top: 20px;
      }

      .meta-info {
        margin-bottom: 20px;
        font-size: 10px;
      }
    }

    @keyframes bootUp {
      from { opacity: 0; transform: scale(0.98); }
      to { opacity: 1; transform: scale(1); }
    }

    @keyframes typeLine {
      from { opacity: 0; transform: translateX(-4px); }
      to { opacity: 1; transform: translateX(0); }
    }

    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }

    @keyframes appear { to { opacity: 1; } }
    @keyframes fadeIn { to { opacity: 1; } }

  </style>
</head>
<body>
  <div class="terminal-window">
    <div class="title-bar">
      <div class="window-controls">
        <div class="control close"></div>
        <div class="control minimize"></div>
        <div class="control maximize"></div>
      </div>
      <div class="title-text">
        user@craft-auth-cli ~
      </div>
      <div style="width: 48px;"></div>
    </div>

    <div class="content">
      <div class="meta-info">
        Last login: <span id="login-time">...</span> on ttys003
      </div>

      <div class="logo-container">
<pre class="logo"></pre>
      </div>

      <div class="terminal-output">
${terminalLinesHtml}
      </div>
${progressSection}
    </div>
  </div>

  <script>
    // Set Login Time
    const now = new Date();
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const timeString = days[now.getDay()] + ' ' + months[now.getMonth()] + ' ' + now.getDate() + ' ' + now.toTimeString().split(' ')[0];
    document.getElementById('login-time').textContent = timeString;
${autoCloseScript}
  </script>
</body>
</html>`;
}


// Generate random state for CSRF protection


// Helper to extract the base MCP URL from a full MCP URL
