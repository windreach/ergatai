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
  return fn().catch((e) => ({ __error: String(e), ...(fallback || {}) }));
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

async function opencode() {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { createOpencodeClient } = require("@opencode-ai/sdk");
  const baseUrl = process.env.OPENCODE_URL || "http://127.0.0.1:4096";
  const client = createOpencodeClient({ baseUrl });
  const results = {};
  for (const [name, config] of Object.entries(servers)) {
    const ocConfig = config.type === "stdio"
      ? { type: "local", command: [config.command, ...(config.args || [])], environment: config.env || {} }
      : { type: "remote", url: config.url, headers: config.headers || {}, enabled: true };
    const res = await safe(() => client.mcp.add({ body: { name, config: ocConfig }, query: { directory: cwd } }), {});
    results[name] = res && res.__error ? { ok: false, error: res.__error } : { ok: true, data: res };
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
