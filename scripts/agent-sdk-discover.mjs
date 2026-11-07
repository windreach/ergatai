import { query } from "@anthropic-ai/claude-agent-sdk";

const agent = process.argv[2];
const cwd = process.argv[3] || process.cwd();

async function claude() {
  const q = query({ prompt: "hi", options: { maxTurns: 1, cwd } });
  const cmds = await q.supportedCommands();
  const models = await q.supportedModels();
  await q.close?.();
  return {
    skills: cmds.map((c) => ({ name: c.name, description: c.description, path: "", source: "agent-sdk" })),
    models: models.map((m) => ({ id: m.value || m.id || m.name, name: m.displayName || m.name || m.value, description: m.description || "" })),
    commands: cmds.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })),
  };
}

async function opencode() {
  // OpenCode SDK requires a running server; attempt localhost default
  const { createOpencodeClient } = await import("@opencode-ai/sdk");
  const client = createOpencodeClient({ baseUrl: process.env.OPENCODE_URL || "http://127.0.0.1:4096" });
  const skills = await client.skills().then((r) => r.data || []).catch(() => []);
  const mcp = await client.mcpStatus().then((r) => r.data || {}).catch(() => ({}));
  const commands = await client.commands().then((r) => r.data || []).catch(() => []);
  return {
    skills: (skills || []).map((s) => ({ name: s.name, description: s.description || "", path: s.path || "", source: "agent-sdk" })),
    models: [],
    commands: (commands || []).map((c) => ({ name: c.name, description: c.description || "", argumentHint: c.argumentHint || "" })),
    mcp: Object.keys(mcp || {}),
  };
}

async function codex() {
  return { skills: [], models: [], commands: [], mcp: [] };
}

const fn = { claude, opencode, codex }[agent] || (async () => ({ skills: [], models: [], commands: [], mcp: [] }));
const result = await fn();
console.log(JSON.stringify(result));