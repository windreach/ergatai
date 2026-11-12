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
    // Degraded fallback: read ~/.claude/settings.json when the SDK is unavailable.
    if (modelList.length === 0) {
      try {
        const fs = await import("node:fs");
        const os = await import("node:os");
        const path = await import("node:path");
        const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
        const content = fs.readFileSync(settingsPath, "utf8");
        const cfg = JSON.parse(content);
        const env = (cfg && cfg.env && typeof cfg.env === "object") ? cfg.env : {};
        const slots = [
          [env.ANTHROPIC_DEFAULT_OPUS_MODEL, "opus"],
          [env.ANTHROPIC_DEFAULT_SONNET_MODEL, "sonnet"],
          [env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "haiku"],
        ];
        for (const [m, slot] of slots) {
          if (typeof m === "string" && m && !modelList.some((x) => x.id === m)) {
            modelList.push({ id: m, name: m, description: `Configured ${slot}`, provider: "Configured" });
          }
        }
        const dm = cfg?.model || env.ANTHROPIC_MODEL;
        if (typeof dm === "string" && dm && !modelList.some((x) => x.id === dm)) {
          modelList.unshift({ id: dm, name: dm, description: "Configured model", provider: "Configured" });
        } else if (typeof dm === "string" && dm) {
          const idx = modelList.findIndex((x) => x.id === dm);
          if (idx > 0) { const [it] = modelList.splice(idx, 1); modelList.unshift(it); }
        }
      } catch {}
    }

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

  // Degraded fallback: read opencode config file when the server is unavailable.
  if (modelList.length === 0) {
    try {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const candidates = [];
      if (process.env.OPENCODE_CONFIG) candidates.push(process.env.OPENCODE_CONFIG);
      candidates.push(path.join(os.homedir(), ".config", "opencode", "opencode.json"));
      candidates.push(path.join(os.homedir(), ".config", "opencode", "opencode.jsonc"));
      for (const cp of candidates) {
        let content = "";
        try { content = fs.readFileSync(cp, "utf8"); } catch { continue; }
        // strip comments
        content = content.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
        let cfg = null;
        try { cfg = JSON.parse(content); } catch { continue; }
        const providers = cfg?.provider && typeof cfg.provider === "object" ? cfg.provider : {};
        for (const [pname, pval] of Object.entries(providers)) {
          const pnameStr = (pval && pval.name) || pname;
          const models = (pval && pval.models && typeof pval.models === "object") ? pval.models : {};
          for (const mkey of Object.keys(models)) {
            if (modelList.some((m) => m.id === mkey)) continue;
            modelList.push({ id: mkey, name: mkey, description: "", provider: pnameStr });
          }
        }
        const dm = cfg?.model;
        if (typeof dm === "string" && dm) {
          const id = dm.includes("/") ? dm.split("/").pop() : dm;
          if (id && !modelList.some((m) => m.id === id)) {
            modelList.unshift({ id, name: id, description: "Configured model", provider: "Configured" });
          } else if (id) {
            const idx = modelList.findIndex((m) => m.id === id);
            if (idx > 0) { const [it] = modelList.splice(idx, 1); modelList.unshift(it); }
          }
        }
        if (modelList.length > 0) break;
      }
    } catch {}
  }

  return { skills: skillList, commands: cmdList, models: modelList, mcp: mcpList, plugins: [] };
}

async function codex() {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const models = [];
  const seen = new Set();
  const add = (id, name, description, provider) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    models.push({ id, name: name || id, description: description || "", provider: provider || "Codex" });
  };

  let topModel = null;
  let topProvider = "Codex";
  let catalogPath = null;
  const profileModels = [];
  try {
    const content = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    let current = null;
    for (const raw of content.split(/\r?\n/)) {
      const t = raw.trim();
      if (!t || t.startsWith("#")) continue;
      const secM = t.match(/^\[([^\]]+)\]$/);
      if (secM) { current = secM[1].trim(); continue; }
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      const hash = val.indexOf("#");
      if (hash !== -1) val = val.slice(0, hash).trim();
      val = val.replace(/^["']|["']$/g, "");
      if (!val) continue;
      if (current === null) {
        if (key === "model") topModel = val;
        else if (key === "model_provider") topProvider = val;
        else if (key === "model_catalog_json") catalogPath = val;
      } else if (current.startsWith("profiles.")) {
        if (key === "model") profileModels.push([current.slice("profiles.".length), val]);
      }
    }
  } catch {}

  const cp = catalogPath || path.join(codexHome, "config.models.json");
  try {
    const cat = JSON.parse(fs.readFileSync(cp, "utf8"));
    const arr = Array.isArray(cat.models) ? cat.models : [];
    for (const m of arr) {
      const id = m.slug || m.id || m.model || "";
      if (!id) continue;
      add(id, m.display_name || m.name || id, m.description || "", topProvider);
    }
  } catch {}

  if (topModel) add(topModel, topModel, "Configured model", topProvider);
  for (const [prof, model] of profileModels) {
    add(model, model, `Configured via profile '${prof}'`, topProvider);
  }
  if (topModel) {
    const idx = models.findIndex((m) => m.id === topModel);
    if (idx > 0) {
      const [it] = models.splice(idx, 1);
      models.unshift(it);
    }
  }
  return { skills: [], commands: [], models, mcp: [], plugins: [] };
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
