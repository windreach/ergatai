const agent = process.argv[2];
const cwd = process.argv[3] || process.cwd();

function safe(fn, fallback) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.catch(() => fallback);
    }
    return Promise.resolve(r ?? fallback);
  } catch (e) {
    return Promise.resolve(fallback);
  }
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
      builtin: c.builtin === true,
    }));
    const cmds = (commands || []).map((c) => ({
      name: c.name,
      description: c.description || "",
      argumentHint: c.argumentHint || "",
      aliases: c.aliases || [],
      builtin: c.builtin === true,
      source: "agent-sdk",
    }));
    const modelList = (models || []).map((m) => ({
      id: m.value || m.id || m.name || m.model || "",
      name: m.displayName || m.name || m.value || m.model || "",
      description: m.description || "",
      provider: "Anthropic",
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

async function opencodeBaseUrl() {
  if (process.env.OPENCODE_URL) return process.env.OPENCODE_URL;
  // Try opencode service status
  try {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("opencode", ["service", "status"], { encoding: "utf8", timeout: 5000 });
    const m = out.match(/https?:\/\/[^\\s]+/);
    if (m) return m[0];
  } catch {}
  return "http://127.0.0.1:4096";
}

async function opencodeAuthHeaders() {
  const headers = {};
  // Password from env or service.json
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

async function opencodeFetch(path) {
  const base = await opencodeBaseUrl();
  const headers = await opencodeAuthHeaders();
  const url = base.replace(/\/$/, "") + (path.startsWith("/") ? path : "/" + path);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function opencode() {
  const base = await opencodeBaseUrl();
  const headers = await opencodeAuthHeaders();
  const dir = cwd;
  const q = "?directory=" + encodeURIComponent(dir);

  const skillsResp = await safe(() => opencodeFetch("/api/skill" + q), { data: [] });
  const commandsResp = await safe(() => opencodeFetch("/api/command" + q), { data: [] });
  const mcpResp = await safe(() => opencodeFetch("/api/mcp" + q), { data: [] });
  const configResp = await safe(() => opencodeFetch("/api/config"), {});
  const modelsResp = await safe(() => opencodeFetch("/api/model"), { data: [] });

  const skillList = (Array.isArray(skillsResp?.data) ? skillsResp.data : []).map((s) => ({
    name: s.name || s.id,
    description: s.description || "",
    path: s.path || "",
    source: "agent-sdk",
  }));

  const cmdList = (Array.isArray(commandsResp?.data) ? commandsResp.data : []).map((c) => ({
    name: c.name,
    description: c.description || "",
    argumentHint: c.argumentHint || "",
    aliases: c.aliases || [],
    source: "agent-sdk",
  }));

  const mcpArr = Array.isArray(mcpResp?.data) ? mcpResp.data : [];
  const mcpList = mcpArr.map((m) => ({
    name: m.name || m.id,
    status: m.status || "pending",
    config: m.config || null,
    source: "agent-sdk",
  }));

  // Models from /api/model
  const modelsArr = Array.isArray(modelsResp?.data) ? modelsResp.data : (Array.isArray(modelsResp) ? modelsResp : []);
  const seenModelIds = new Set();
  const modelList = modelsArr.flatMap((m) => {
    const id = m.id || m.modelID || m.value || m.name || m.model || "";
    if (id && seenModelIds.has(id)) return [];
    if (id) seenModelIds.add(id);
    return [{
      id,
      name: m.name || m.displayName || m.id || m.modelID || m.model || "",
      description: m.description || "",
      provider: m.providerID || m.provider || "",
    }];
  });
  const configInfo = Array.isArray(configResp)
    ? (configResp.find((d) => d?.info?.model)?.info || configResp[0]?.info || {})
    : (configResp?.info || configResp || {});
  // Prioritize the configured default model so it becomes the default selection.
  if (configInfo?.model) {
    const mm = configInfo.model;
    const configuredId = mm.model || "";
    if (configuredId) {
      const idx = modelList.findIndex((m) => m.id === configuredId);
      if (idx > 0) {
        const [configured] = modelList.splice(idx, 1);
        modelList.unshift(configured);
      } else if (idx === -1) {
        modelList.unshift({ id: configuredId, name: mm.model || configuredId, description: "" });
      }
    }
  }
  // Fallback: config.model
  if (modelList.length === 0 && configInfo?.model) {
    const mm = configInfo.model;
    modelList.push({ id: (mm.providerID || "") + "/" + (mm.model || ""), name: mm.model || "", description: "" });
  }

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
