const agent = process.argv[2];
const cwd = process.argv[3] || process.cwd();
const sessionId = process.argv[4] || process.env.SESSION_ID || "";

let servers = {};
try {
  if (process.env.MCP_SERVERS_JSON) {
    servers = JSON.parse(process.env.MCP_SERVERS_JSON);
  }
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: "invalid MCP_SERVERS_JSON: " + String(e) }));
  process.exit(0);
}

function safe(fn, fallback) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.catch((e) => ({ __error: String(e), ...(fallback || {}) }));
    }
    return Promise.resolve(r ?? fallback);
  } catch (e) {
    return Promise.resolve({ __error: String(e), ...(fallback || {}) });
  }
}

async function claude() {
  if (!sessionId) {
    return { ok: false, error: "claude injection requires session_id" };
  }
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { query } = require("@anthropic-ai/claude-agent-sdk");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const homeDir = os.homedir();
  const claudePath =
    process.env.CLAUDE_CODE_EXECUTABLE ||
    (fs.existsSync(`${homeDir}/.local/bin/claude`) ? `${homeDir}/.local/bin/claude` :
     fs.existsSync("/usr/bin/claude") ? "/usr/bin/claude" : "claude");
  const q = query({ prompt: "", options: { maxTurns: 1, cwd, resume: sessionId, pathToClaudeCodeExecutable: claudePath } });
  try {
    const result = await q.setMcpServers(servers);
    return { ok: true, added: result?.added || [], removed: result?.removed || [], errors: result?.errors || {} };
  } finally {
    try { await q.close?.(); } catch {}
  }
}

async function opencodeBaseUrl() {
  if (process.env.OPENCODE_URL) return process.env.OPENCODE_URL;
  try {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("opencode", ["service", "status"], { encoding: "utf8", timeout: 5000 });
    const m = out.match(/https?:\/\/[^\\s]+/);
    if (m) return m[0];
  } catch {}
  return "http://127.0.0.1:4096";
}

async function opencodeAuthHeaders() {
  const headers = { "Content-Type": "application/json" };
  let pw = process.env.OPENCODE_SERVER_PASSWORD;
  if (!pw) {
    try {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const sp = os.homedir() + "/.config/opencode/service.json";
      if (fs.existsSync(sp)) {
        const j = JSON.parse(fs.readFileSync(sp, "utf8"));
        pw = j.password;
      }
    } catch {}
  }
  if (pw) {
    headers["Authorization"] = "Basic " + Buffer.from("opencode:" + pw).toString("base64");
  }
  return headers;
}

async function opencode() {
  const base = await opencodeBaseUrl();
  const headers = await opencodeAuthHeaders();
  const results = {};
  for (const [name, config] of Object.entries(servers)) {
    const ocConfig = config.type === "stdio"
      ? { type: "local", command: [config.command, ...(config.args || [])], environment: config.env || {} }
      : { type: "remote", url: config.url, headers: config.headers || {}, enabled: true };
    try {
      const res = await fetch(base.replace(/\/$/, "") + "/api/mcp?directory=" + encodeURIComponent(cwd), {
        method: "POST",
        headers,
        body: JSON.stringify({ name, config: ocConfig }),
      });
      const data = await res.json().catch(() => ({}));
      results[name] = res.ok ? { ok: true, data } : { ok: false, error: data?.message || res.statusText };
    } catch (e) {
      results[name] = { ok: false, error: String(e) };
    }
  }
  const ok = Object.values(results).every((r) => r.ok !== false);
  return { ok, results };
}

async function codex() {
  return { ok: false, error: "codex sdk does not support runtime mcp injection" };
}

const fn = { claude, opencode, codex }[agent] || (async () => ({ ok: false, error: "unknown agent" }));

try {
  const result = await fn();
  console.log(JSON.stringify(result));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e) }));
}
