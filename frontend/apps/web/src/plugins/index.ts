import type { Plugin } from "@ergatai/core-plugin-types";

export type PluginModule = { default: Plugin };

const pluginModules = import.meta.glob<PluginModule>("./*.plugin.ts");

export async function loadPlugins(): Promise<Plugin[]> {
  const entries = Object.entries(pluginModules).sort(([left], [right]) => left.localeCompare(right));
  const plugins = await Promise.all(entries.map(async ([path, loadPlugin]) => {
    const pluginModule = await loadPlugin();
    const plugin = pluginModule.default;

    if (!plugin || typeof plugin.apply !== "function") {
      throw new Error(`Plugin at ${path} must export a default Plugin.`);
    }

    return plugin;
  }));

  const names = new Set<string>();
  for (const plugin of plugins) {
    const name = plugin.name ?? "(anonymous)";
    if (names.has(name)) {
      throw new Error(`Duplicate plugin name: ${name}`);
    }
    names.add(name);
  }

  return plugins;
}
