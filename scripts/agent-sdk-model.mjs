const agent = process.argv[2];
const model = process.argv[3];
const cwd = process.argv[4] || process.cwd();
const sessionId = process.env.SESSION_ID || "";

async function claude() {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const q = query({ prompt: "", options: { maxTurns: 1, cwd, model, resume: sessionId || undefined } });
  await q.setModel(model);
  await q.close?.();
  return { ok: true };
}

async function opencode() {
  const base = process.env.OPENCODE_URL;
  let baseUrl = base;
  if (!baseUrl) {
    try {
      const { execFileSync } = await import("node:child_process");
      const out = execFileSync("opencode", ["service", "status"], { encoding: "utf8", timeout: 5000 });
      const m = out.match(/https?:\/\/[^\\s]+/);
      if (m) baseUrl = m[0];
    } catch {}
  }
  if (!baseUrl) baseUrl = "http://127.0.0.1:4096";
  let pw = process.env.OPENCODE_SERVER_PASSWORD;
  if (!pw) {
    try {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const sp = os.homedir() + "/.config/opencode/service.json";
      if (fs.existsSync(sp)) pw = JSON.parse(fs.readFileSync(sp, "utf8")).password;
    } catch {}
  }
  const headers = { "Content-Type": "application/json" };
  if (pw) headers["Authorization"] = "Basic " + Buffer.from("opencode:" + pw).toString("base64");
  const res = await fetch(baseUrl.replace(/\/$/, "") + "/api/session/" + encodeURIComponent(sessionId) + "/model", {
    method: "POST",
    headers,
    body: JSON.stringify({ model }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return { ok: true };
}

async function codex() {
  return { ok: false, error: "codex sdk does not support runtime model switch" };
}

const fn = { claude, opencode, codex }[agent] || (async () => ({ ok: false, error: "unknown agent" }));
try {
  const result = await fn();
  console.log(JSON.stringify(result));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e) }));
}