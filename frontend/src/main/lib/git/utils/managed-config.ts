import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Permission config files Ergatai injects into the agent's worktree while a
 * session is running. They are tool-managed, not user changes, so they must
 * not appear in the Changes panel, commit selection, or diff view.
 */
const ERGATAI_MANAGED_CONFIG_PATHS = new Set([
	".opencode/opencode.json",
	".claude/settings.json",
	".codex/config.toml",
]);

/**
 * Returns true when `relativePath` points at an Ergatai-injected config file.
 * The content marker is checked so a user-authored config with the same path
 * is still treated as a real change.
 */
export function isErgataiManagedConfig(
	worktreePath: string,
	relativePath: string,
): boolean {
	const normalizedPath = relativePath.replace(/\\/g, "/");
	if (!ERGATAI_MANAGED_CONFIG_PATHS.has(normalizedPath)) return false;

	try {
		const content = readFileSync(join(worktreePath, normalizedPath), "utf8");
		if (normalizedPath.endsWith(".toml")) {
			return /^\s*ergatai_managed\s*=\s*true\s*$/m.test(content);
		}
		const parsed = JSON.parse(content) as { ergatai_managed?: unknown };
		return parsed.ergatai_managed === true;
	} catch {
		return false;
	}
}
