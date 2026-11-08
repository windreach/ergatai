const agent = process.argv[2];
const cwd = process.argv[3] || process.cwd();

function safe(fn, fallback) {
  return fn().catch(() => fallback);
}

async function claude() {
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
  const q = query({ prompt: "", options: { maxTurns: 1, cwd, pathToClaudeCodeExecutable: claudePath } });
  try {
    const [skillsResp, commands, models, mcp, agents, pluginsResp] = await Promise.all([
      safe(() => q.reloadSkills(), { skills: [] }),
      safe(() => q.supportedCommands(), []),
      safe(() => q.supportedModels(), []),
      safe(() => q.mcpServerStatus(), []),
      safe(() => q.supportedAgents(), []),
      safe(() => q.reloadPlugins(), { plugins: [] }),
    ]);
    const skills = (skillsResp?.skills || []).map((c) => ({
      name: c.name,
      description: c.description || "",
      path: "",
      source: "agent-sdk",
      argumentHint: c.argumentHint || "",
      aliases: c.aliases || [],
    }));
    const cmds = (commands || []).map((c) => ({
      name: c.name,
      description: c.description || "",
      argumentHint: c.argumentHint || "",
      aliases: c.aliases || [],
      source: "agent-sdk",
    }));
    const modelList = (models || []).map((m) => ({
      id: m.value || m.id || m.name || m.model || "",
      name: m.displayName || m.name || m.value || m.model || "",
      description: m.description || "",
    }));
    const mcpList = (mcp || []).map((s) => ({
      name: s.name,
      status: s.status || "pending",
      config: s.config || null,
      source: "agent-sdk",
    }));
    const agentList = (agents || []).map((a) => ({
      name: a.name,
      description: a.description || "",
      source: "agent-sdk",
    }));
    const pluginList = (pluginsResp?.plugins || []).map((p) => ({
      name: p.name || "",
      version: "",
      description: "",
      path: p.path || "",
      source: p.source || "agent-sdk",
      marketplace: "",
      category: null,
      homepage: null,
      tags: [],
    }));
    return { skills, commands: cmds, models: modelList, mcp: mcpList, agents: agentList, plugins: pluginList };
  } finally {
    try { await q.close?.(); } catch {}
  }
}

async function opencode() {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { createOpencodeClient } = require("@opencode-ai/sdk");
  const client = createOpencodeClient({ baseUrl: process.env.OPENCODE_URL || "http://127.0.0.1:4096" });
  const [skills, commands, mcp, config] = await Promise.all([
    safe(() => client.skills().then((r) => r?.data || r || []), []),
    safe(() => client.commands().then((r) => r?.data || r || []), []),
    safe(() => client.mcpStatus().then((r) => r?.data || r || {}), {}),
    safe(() => client.config().then((r) => r?.data || r || {}), {}),
  ]);
  const skillList = (Array.isArray(skills) ? skills : []).map((s) => ({
    name: s.name,
    description: s.description || "",
    path: s.path || "",
    source: "agent-sdk",
  }));
  const cmdList = (Array.isArray(commands) ? commands : []).map((c) => ({
    name: c.name,
    description: c.description || "",
    argumentHint: c.argumentHint || "",
    aliases: c.aliases || [],
    source: "agent-sdk",
  }));
  const mcpObj = mcp && typeof mcp === "object" && !Array.isArray(mcp) ? mcp : {};
  const mcpList = Object.keys(mcpObj).map((name) => ({
    name,
    status: (mcpObj[name] && (mcpObj[name].status || mcpObj[name])) || "pending",
    config: (mcpObj[name] && mcpObj[name].config) || null,
    source: "agent-sdk",
  }));
  const providers = (config && (config.providers || config.provider)) || [];
  const modelList = (Array.isArray(providers) ? providers : []).flatMap((p) =>
    (p.models || []).map((m) => ({
      id: m.id || m.value || m.name || "",
      name: m.name || m.displayName || m.id || "",
      description: m.description || "",
    }))
  );
  return { skills: skillList, commands: cmdList, models: modelList, mcp: mcpList, plugins: [] };
}

async function codex() {
  return { skills: [], commands: [], models: [], mcp: [], plugins: [] };
}

const fn = { claude, opencode, codex }[agent] || (async () => ({ skills: [], commands: [], models: [], mcp: [], plugins: [] }));

try {
  const result = await fn();
  result.skills = result.skills || [];
  result.commands = result.commands || [];
  result.models = result.models || [];
  result.mcp = result.mcp || [];
  console.log(JSON.stringify(result));
} catch (e) {
  console.log(JSON.stringify({ skills: [], commands: [], models: [], mcp: [], plugins: [], error: String(e) }));
}
