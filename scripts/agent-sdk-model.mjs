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
  const { createOpencodeClient } = await import("@opencode-ai/sdk");
  const client = createOpencodeClient({ baseUrl: process.env.OPENCODE_URL || "http://127.0.0.1:4096" });
  await client.sessionSwitchModel({ path: { id: sessionId }, body: { model } });
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