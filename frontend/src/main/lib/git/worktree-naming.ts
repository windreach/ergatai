import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	adjectives,
	uniqueNamesGenerator,
} from "unique-names-generator";
import { landscapes } from "./dictionaries/landscapes";

const MAX_RETRIES = 10;

function generateLandscapeName(): string {
	return uniqueNamesGenerator({
		dictionaries: [adjectives, landscapes],
		separator: "-",
		length: 2,
		style: "lowerCase",
	});
}

/**
 * Sanitize a project name for use as a filesystem directory name.
 * Lowercases, replaces spaces/underscores with hyphens, strips special characters.
 * Truncates to 50 characters to stay within filesystem path length limits.
 *
 * Slug collisions (e.g., "My Project" and "my_project" both becoming "my-project")
 * are safe because resolveProjectPathFromWorktree() looks up the full worktree path
 * via the chats table, not just the project folder name.
 */
export function sanitizeProjectName(name: string): string {
	const sanitized = name
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9\-.]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 50);

	return sanitized || "project";
}

/**
 * Generate a unique, human-readable folder name for a worktree.
 * Uses adjective-landscape pattern (e.g., "golden-meadow", "quiet-ridge").
 * Checks the parent directory for existing folders to avoid collisions.
 * Falls back to appending a numeric suffix if random generation keeps colliding.
 *
 * Note: There is a theoretical TOCTOU race between existsSync and the actual
 * git worktree add. In practice this is negligible (180k combinations, single
 * local user). If it occurs, git worktree add fails atomically and the error
 * is caught by createWorktreeForChat().
 */
export function generateWorktreeFolderName(parentDir: string): string {
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		const name = generateLandscapeName();
		if (!existsSync(join(parentDir, name))) {
			return name;
		}
	}

	// Fallback: generate a base name and append numeric suffix
	const baseName = generateLandscapeName();

	for (let suffix = 2; suffix <= 999; suffix++) {
		const name = `${baseName}-${suffix}`;
		if (!existsSync(join(parentDir, name))) {
			return name;
		}
	}

	// Absolute fallback: append timestamp
	return `${baseName}-${Date.now().toString(36)}`;
}

/**
 * Sanitize a base branch name so it can be embedded in a generated branch.
 * Keeps `/` because feature branches may be namespaced, but removes characters
 * that are invalid in Git refs.
 */
function sanitizeBranchComponent(input: string): string {
	let s = (input || "").trim();
	if (!s) s = "base";

	s = s.replace(/\.\.+/g, ".");
	s = s.replace(/^\/+/, "").replace(/\/+$/, "");
	s = s.replace(/[ \t~^:?*\[\]\\]/g, "-");
	s = s.replace(/@\{/g, "-");

	s = s
		.split("/")
		.map((part) => part.replace(/^\.+/, "").replace(/\.+$/, ""))
		.join("/");

	if (s.endsWith(".lock")) {
		s = s.slice(0, -5);
	}

	if (!s || s === "/") s = "base";
	return s;
}

/**
 * Generate the shared name for a chat's branch and worktree directory:
 * `chat/<base>-<short-id>` (for example `chat/main-5061`).
 *
 * The same string is used as the Git branch and as the worktree path relative
 * to the project's worktree directory, so a branch such as `chat/main-5061`
 * lives at `<worktree-root>/<project>/chat/main-5061`.
 *
 * `isNameTaken` lets the caller reject names already used by local or remote
 * branches; directory existence is checked here.
 */
export function generateChatWorktreeName(
	parentDir: string,
	baseBranch: string | undefined,
	chatId: string | undefined,
	isNameTaken?: (name: string) => boolean,
): string {
	const base = sanitizeBranchComponent(baseBranch || "main");
	// Drop the `chat_` prefix before taking the short id so the generated name
	// is not `chat/main-chat5061`.
	const rawId = (chatId || randomBytes(4).toString("hex"))
		.replace(/^chat_/, "")
		.replace(/[^a-zA-Z0-9]/g, "")
		.slice(0, 12);
	const shortId = rawId || randomBytes(4).toString("hex").slice(0, 8);

	const prefix = "chat/";
	const maxTotal = 200;
	let baseName = `${prefix}${base}-${shortId}`;
	if (baseName.length > maxTotal) {
		const allowedBase = Math.max(
			1,
			maxTotal - prefix.length - 1 - shortId.length,
		);
		baseName = `${prefix}${base.slice(0, allowedBase)}-${shortId}`;
	}

	const isAvailable = (name: string): boolean =>
		!existsSync(join(parentDir, name)) &&
		isNameTaken?.(name) !== true;

	if (isAvailable(baseName)) return baseName;

	for (let counter = 2; counter <= 1000; counter++) {
		const candidate = `${baseName}-${counter}`;
		if (isAvailable(candidate)) return candidate;
	}

	return `${baseName}-${Date.now().toString(36)}`;
}
