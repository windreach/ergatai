import { isAbsolute, normalize, resolve, sep } from "node:path";
import { getRegisteredWorktree, type BackendChat } from "../../ergatai/user-data";

/**
 * Security model for desktop app filesystem access:
 *
 * THREAT MODEL:
 * While a compromised renderer can execute commands via terminal panes,
 * the File Viewer presents a distinct threat: malicious repositories can
 * contain symlinks that trick users into reading/writing sensitive files
 * (e.g., `docs/config.yml` → `~/.bashrc`). Users clicking these links
 * don't know they're accessing files outside the repo.
 *
 * PRIMARY BOUNDARY: assertRegisteredWorktree()
 * - Only worktree paths registered in localDb are accessible via tRPC
 * - Prevents direct filesystem access to unregistered paths
 *
 * SECONDARY: validateRelativePath()
 * - Rejects absolute paths and ".." traversal segments
 * - Defense in depth against path manipulation
 *
 * SYMLINK PROTECTION (secure-fs.ts):
 * - Writes: Block if realpath escapes worktree (prevents accidental overwrites)
 * - Reads: Caller can check isSymlinkEscaping() to warn users
 */

/**
 * Security error codes for path validation failures.
 */
export type PathValidationErrorCode =
	| "ABSOLUTE_PATH"
	| "PATH_TRAVERSAL"
	| "UNREGISTERED_WORKTREE"
	| "INVALID_TARGET"
	| "SYMLINK_ESCAPE"
	| "BACKEND_UNAVAILABLE";

/**
 * Error thrown when path validation fails.
 * Includes a code for programmatic handling.
 */
export class PathValidationError extends Error {
	constructor(
		message: string,
		public readonly code: PathValidationErrorCode,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "PathValidationError";
	}
}

/**
 * Validates that a workspace path is registered in database.
 * This is THE critical security boundary.
 *
 * Accepts:
 * - Worktree paths (from chats.worktreePath)
 * - Project paths (from projects.path)
 *
 * @throws PathValidationError if path is not registered
 */
export async function assertRegisteredWorktree(workspacePath: string): Promise<void> {
	let registered: Awaited<ReturnType<typeof getRegisteredWorktree>>;

	try {
		registered = await getRegisteredWorktree(workspacePath);
	} catch (error) {
		throw new PathValidationError(
			"Backend registration check failed; filesystem access denied",
			"BACKEND_UNAVAILABLE",
			{ cause: error },
		);
	}

	if (registered?.chat || registered?.projectPath) {
		return;
	}

	throw new PathValidationError(
		"Workspace path not registered in database",
		"UNREGISTERED_WORKTREE",
	);
}

/**
 * Gets the chat record if registered. Returns record for updates.
 *
 * @throws PathValidationError if chat is not registered
 */
export async function getRegisteredChat(
	worktreePath: string,
): Promise<BackendChat> {
	let registered: Awaited<ReturnType<typeof getRegisteredWorktree>>;

	try {
		registered = await getRegisteredWorktree(worktreePath);
	} catch (error) {
		throw new PathValidationError(
			"Backend registration check failed; chat access denied",
			"BACKEND_UNAVAILABLE",
			{ cause: error },
		);
	}
	const chat = registered?.chat;

	if (!chat) {
		throw new PathValidationError(
			"Chat not registered in database",
			"UNREGISTERED_WORKTREE",
		);
	}

	return chat;
}

/**
 * Options for path validation.
 */
export interface ValidatePathOptions {
	/**
	 * Allow empty/root path (resolves to worktree itself).
	 * Default: false (prevents accidental worktree deletion)
	 */
	allowRoot?: boolean;
}

/**
 * Validates a relative file path for safety.
 * Rejects absolute paths and path traversal attempts.
 *
 * @throws PathValidationError if path is invalid
 */
export function validateRelativePath(
	filePath: string,
	options: ValidatePathOptions = {},
): void {
	const { allowRoot = false } = options;

	// Reject absolute paths
	if (isAbsolute(filePath)) {
		throw new PathValidationError(
			"Absolute paths are not allowed",
			"ABSOLUTE_PATH",
		);
	}

	const normalized = normalize(filePath);
	const segments = normalized.split(sep);

	// Reject ".." as a path segment (allows "..foo" directories)
	if (segments.includes("..")) {
		throw new PathValidationError(
			"Path traversal not allowed",
			"PATH_TRAVERSAL",
		);
	}

	// Reject root path unless explicitly allowed
	if (!allowRoot && (normalized === "" || normalized === ".")) {
		throw new PathValidationError(
			"Cannot target worktree root",
			"INVALID_TARGET",
		);
	}
}

/**
 * Validates and resolves a path within a worktree. Sync, simple.
 *
 * @param worktreePath - The worktree base path
 * @param filePath - The relative file path to validate
 * @param options - Validation options
 * @returns The resolved full path
 * @throws PathValidationError if path is invalid
 */
export function resolvePathInWorktree(
	worktreePath: string,
	filePath: string,
	options: ValidatePathOptions = {},
): string {
	validateRelativePath(filePath, options);
	// Use resolve to handle any worktreePath (relative or absolute)
	return resolve(worktreePath, normalize(filePath));
}

/**
 * Validates a path for git commands. Lighter check that allows root.
 *
 * @throws PathValidationError if path is invalid
 */
export function assertValidGitPath(filePath: string): void {
	validateRelativePath(filePath, { allowRoot: true });
}
