import {
  execFile
} from "node:child_process";
import { t } from "../i18n"
import {
  createHash,
  randomBytes
} from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import {
  devNull,
  homedir
} from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  resolve
} from "node:path";
import {
  promisify
} from "node:util";
import {
  simpleGit
} from "simple-git";
import {
  adjectives,
  animals,
  uniqueNamesGenerator
} from "unique-names-generator";
import {
  checkGitLfsAvailable,
  getShellEnvironment
} from "./shell-env";
import {
  getRepositoryState
} from "./git-factory";
import {
  executeWorktreeSetup
} from "./worktree-config";
import type {
  WorktreeSetupResult
} from "./worktree-config";
import {
  generateWorktreeFolderName
} from "./worktree-naming";

const execFileAsync = promisify(execFile);

/**
 * Error thrown by execFile when the command fails.
 * `code` can be a number (exit code) or string (spawn error like "ENOENT").
 */
interface ExecFileException extends Error {
	code?: number | string;
	killed?: boolean;
	signal?: NodeJS.Signals;
	cmd?: string;
	stdout?: string;
	stderr?: string;
}

function isExecFileException(error: unknown): error is ExecFileException {
	return (
		error instanceof Error &&
		("code" in error || "signal" in error || "killed" in error)
	);
}

async function getGitEnv(): Promise<Record<string, string>> {
	const shellEnv = await getShellEnvironment();
	const result: Record<string, string> = {};

	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") {
			result[key] = value;
		}
	}

	const pathKey = process.platform === "win32" ? "Path" : "PATH";
	if (shellEnv[pathKey]) {
		result[pathKey] = shellEnv[pathKey];
	}

	return result;
}

async function repoUsesLfs(repoPath: string): Promise<boolean> {
	try {
		const lfsDir = join(repoPath, ".git", "lfs");
		const stats = await stat(lfsDir);
		if (stats.isDirectory()) {
			return true;
		}
	} catch (error) {
		if (!isEnoent(error)) {
			console.warn(`[git] Could not check .git/lfs directory: ${error}`);
		}
	}

	const attributeFiles = [
		join(repoPath, ".gitattributes"),
		join(repoPath, ".git", "info", "attributes"),
		join(repoPath, ".lfsconfig"),
	];

	for (const filePath of attributeFiles) {
		try {
			const content = await readFile(filePath, "utf-8");
			if (content.includes("filter=lfs") || content.includes("[lfs]")) {
				return true;
			}
		} catch (error) {
			if (!isEnoent(error)) {
				console.warn(`[git] Could not read ${filePath}: ${error}`);
			}
		}
	}

	try {
		const git = simpleGit(repoPath);
		const lsFiles = await git.raw(["ls-files"]);
		const sampleFiles = lsFiles.split("\n").filter(Boolean).slice(0, 20);

		if (sampleFiles.length > 0) {
			const checkAttr = await git.raw([
				"check-attr",
				"filter",
				"--",
				...sampleFiles,
			]);
			if (checkAttr.includes("filter: lfs")) {
				return true;
			}
		}
	} catch {}

	return false;
}

function isEnoent(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}

function sanitizeBranchComponent(input: string): string {
	let s = (input || "").trim();
	if (!s) s = "base";

	// Git ref format: strip consecutive dots and trailing slashes.
	s = s.replace(/\.\.+/g, ".");
	s = s.replace(/^\/+/, "").replace(/\/+$/, "");

	// Replace characters that are invalid in ref names.
	s = s.replace(/[ \t~^:?*\[\]\\]/g, "-");
	s = s.replace(/@\{/g, "-");

	// Per-component rules: no leading/trailing dots.
	s = s
		.split("/")
		.map((part) => part.replace(/^\.+/, "").replace(/\.+$/, ""))
		.join("/");

	// Avoid .lock suffix on the final component.
	if (s.endsWith(".lock")) {
		s = s.slice(0, -5);
	}

	if (!s || s === "/" ) s = "base";
	return s;
}

export function generateBranchName(baseBranch?: string, chatId?: string): string {
	const base = sanitizeBranchComponent(baseBranch || "main");
	// Drop the `chat_` prefix before taking the short id. Keeping it made the
	// short id start with the constant "chat" plus only the first few timestamp
	// digits, so every chat created in the same time window produced the same
	// branch name (e.g. `chat/main-chat5062`).
	const rawId = (chatId || randomBytes(4).toString("hex"))
		.replace(/^chat_/, "")
		.replace(/[^a-zA-Z0-9]/g, "")
		.slice(0, 12);
	const shortId = rawId || randomBytes(4).toString("hex").slice(0, 8);

	const prefix = "chat/";
	const maxTotal = 200;
	let name = `${prefix}${base}-${shortId}`;
	if (name.length > maxTotal) {
		const allowedBase = Math.max(1, maxTotal - prefix.length - 1 - shortId.length);
		name = `${prefix}${base.slice(0, allowedBase)}-${shortId}`;
	}
	return name;
}

export async function ensureUniqueBranchName(
	mainRepoPath: string,
	desired: string,
): Promise<string> {
	const git = simpleGit(mainRepoPath);

	// Read the local branch list once instead of probing each candidate.
	// `git show-ref --verify --quiet <ref>` exits with a non-zero status when
	// the ref is missing but prints nothing; simple-git treats "no output" as
	// success, so the old per-candidate probe resolved for BOTH existing and
	// missing refs. That made the loop spin through 1000 git subprocesses
	// (~50s) on every chat creation before falling through to `-1000`.
	let existing: Set<string>;
	try {
		existing = new Set((await git.branchLocal()).all);
	} catch {
		// If we cannot list branches, let `git worktree add` surface the real
		// error instead of failing chat creation here.
		return desired;
	}

	if (!existing.has(desired)) return desired;

	for (let counter = 2; counter <= 1000; counter++) {
		const candidate = `${desired}-${counter}`;
		if (!existing.has(candidate)) return candidate;
	}

	return `${desired}-${Date.now().toString(36)}`;
}

export async function createWorktree(
	mainRepoPath: string,
	branch: string,
	worktreePath: string,
	startPoint = "origin/main",
	createBranch = true,
	force = false,
): Promise<void> {
	const usesLfs = await repoUsesLfs(mainRepoPath);

	try {
		const parentDir = join(worktreePath, "..");
		await mkdir(parentDir, { recursive: true });

		const env = await getGitEnv();

		if (usesLfs) {
			const lfsAvailable = await checkGitLfsAvailable(env);
			if (!lfsAvailable) {
				throw new Error(
					t("This repository uses Git LFS, but git-lfs was not found. Please install git-lfs (e.g., 'brew install git-lfs') and run 'git lfs install'."),
				);
			}
		}

		// Resolve startPoint to commit hash to avoid Windows escaping issues with ^{commit}
		const git = simpleGit(mainRepoPath);
		let commitHash: string;
		try {
			commitHash = (await git.revparse([`${startPoint}^{commit}`])).trim();
		} catch {
			// Fallback to local branch if origin/branch doesn't exist
			const localBranch = startPoint.replace(/^origin\//, "");
			try {
				commitHash = (await git.revparse([`${localBranch}^{commit}`])).trim();
			} catch {
				commitHash = (await git.revparse([startPoint])).trim();
			}
		}

		// When creating a new branch we resolve to a commit hash (avoids Windows
		// escaping issues with ^{commit}); when checking out an existing branch we
		// must pass the branch ref itself so HEAD stays attached to that branch
		// instead of becoming detached.
		const checkoutRef = createBranch ? commitHash : startPoint;

		const worktreeArgs = createBranch
			? [
					"-C",
					mainRepoPath,
					"worktree",
					"add",
					...(force ? ["-f"] : []),
					worktreePath,
					"-b",
					branch,
					commitHash,
				]
			: [
					"-C",
					mainRepoPath,
					"worktree",
					"add",
					...(force ? ["-f"] : []),
					worktreePath,
					checkoutRef,
				];

		await execFileAsync("git", worktreeArgs, {
			env,
			timeout: 120_000,
		});

	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const lowerError = errorMessage.toLowerCase();

		const isLockError =
			lowerError.includes("could not lock") ||
			lowerError.includes("unable to lock") ||
			(lowerError.includes(".lock") && lowerError.includes("file exists"));

		if (isLockError) {
			console.error(
				`Git lock file error during worktree creation: ${errorMessage}`,
			);
			throw new Error(
				t("Failed to create worktree: The git repository is locked by another process. This usually happens when another git operation is in progress, or a previous operation crashed. Please wait for the other operation to complete, or manually remove the lock file (e.g., .git/config.lock or .git/index.lock) if you're sure no git operations are running."),
			);
		}

		const isLfsError =
			lowerError.includes("git-lfs") ||
			lowerError.includes("filter-process") ||
			lowerError.includes("smudge filter") ||
			(lowerError.includes("lfs") && lowerError.includes("not")) ||
			(lowerError.includes("lfs") && usesLfs);

		if (isLfsError) {
			console.error(`Git LFS error during worktree creation: ${errorMessage}`);
			throw new Error(
				t("Failed to create worktree: This repository uses Git LFS, but git-lfs was not found or failed. Please install git-lfs (e.g., 'brew install git-lfs') and run 'git lfs install'."),
			);
		}

		console.error(`Failed to create worktree: ${errorMessage}`);
		throw new Error(t('Failed to create worktree: {{errorMessage}}'));
	}
}

export async function removeWorktree(
	mainRepoPath: string,
	worktreePath: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		const env = await getGitEnv();

		await execFileAsync(
			"git",
			["-C", mainRepoPath, "worktree", "remove", worktreePath, "--force"],
			{ env, timeout: 60_000 },
		);

		return { success: true };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		console.error(`Failed to remove worktree: ${errorMessage}`);
		return { success: false, error: errorMessage };
	}
}

export async function getGitRoot(path: string): Promise<string> {
	try {
		const git = simpleGit(path);
		const root = await git.revparse(["--show-toplevel"]);
		return root.trim();
	} catch {
		throw new Error(t('Not a git repository: {{path}}'));
	}
}

export async function worktreeExists(
	mainRepoPath: string,
	worktreePath: string,
): Promise<boolean> {
	try {
		const git = simpleGit(mainRepoPath);
		const worktrees = await git.raw(["worktree", "list", "--porcelain"]);

		const lines = worktrees.split("\n");
		const worktreePrefix = `worktree ${worktreePath}`;
		return lines.some((line) => line.trim() === worktreePrefix);
	} catch (error) {
		console.error(`Failed to check worktree existence: ${error}`);
		throw error;
	}
}

export async function hasOriginRemote(mainRepoPath: string): Promise<boolean> {
	try {
		const git = simpleGit(mainRepoPath);
		const remotes = await git.getRemotes();
		return remotes.some((r) => r.name === "origin");
	} catch {
		return false;
	}
}

export async function getDefaultBranch(mainRepoPath: string): Promise<string> {
	const git = simpleGit(mainRepoPath);

	// First check if we have an origin remote
	const hasRemote = await hasOriginRemote(mainRepoPath);

	if (hasRemote) {
		// Try to get the default branch from origin/HEAD
		try {
			const headRef = await git.raw([
				"symbolic-ref",
				"refs/remotes/origin/HEAD",
			]);
			const match = headRef.trim().match(/refs\/remotes\/origin\/(.+)/);
			if (match) return match[1];
		} catch {}

		// Check remote branches for common default branch names
		try {
			const branches = await git.branch(["-r"]);
			const remoteBranches = branches.all.map((b) => b.replace("origin/", ""));

			for (const candidate of ["main", "master", "develop", "trunk"]) {
				if (remoteBranches.includes(candidate)) {
					return candidate;
				}
			}
		} catch {}

		// Try ls-remote as last resort for remote repos
		try {
			const result = await git.raw(["ls-remote", "--symref", "origin", "HEAD"]);
			const symrefMatch = result.match(/ref:\s+refs\/heads\/(.+?)\tHEAD/);
			if (symrefMatch) {
				return symrefMatch[1];
			}
		} catch {}
	} else {
		// No remote - use the current local branch or check for common branch names
		try {
			const currentBranch = await getCurrentBranch(mainRepoPath);
			if (currentBranch) {
				return currentBranch;
			}
		} catch {}

		// Fallback: check for common default branch names locally
		try {
			const localBranches = await git.branchLocal();
			for (const candidate of ["main", "master", "develop", "trunk"]) {
				if (localBranches.all.includes(candidate)) {
					return candidate;
				}
			}
			// If we have unknown local branches, use the first one
			if (localBranches.all.length > 0) {
				return localBranches.all[0];
			}
		} catch {}
	}

	return "main";
}

export async function fetchDefaultBranch(
	mainRepoPath: string,
	defaultBranch: string,
): Promise<string> {
	const git = simpleGit(mainRepoPath);
	await git.fetch("origin", defaultBranch);
	const commit = await git.revparse(`origin/${defaultBranch}`);
	return commit.trim();
}

/**
 * Refreshes the local origin/HEAD symref from the remote and returns the current default branch.
 * This detects when the remote repository's default branch has changed (e.g., master -> main).
 * @param mainRepoPath - Path to the main repository
 * @returns The current default branch name, or null if unable to determine
 */
export async function refreshDefaultBranch(
	mainRepoPath: string,
): Promise<string | null> {
	const git = simpleGit(mainRepoPath);

	const hasRemote = await hasOriginRemote(mainRepoPath);
	if (!hasRemote) {
		return null;
	}

	try {
		// Git doesn't auto-update origin/HEAD on fetch, so we must explicitly
		// sync it to detect when the remote's default branch changes
		await git.remote(["set-head", "origin", "--auto"]);

		const headRef = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
		const match = headRef.trim().match(/refs\/remotes\/origin\/(.+)/);
		if (match) {
			return match[1];
		}
	} catch {
		// set-head requires network access; fall back to ls-remote which may
		// work in some edge cases or provide a more specific error
		try {
			const result = await git.raw(["ls-remote", "--symref", "origin", "HEAD"]);
			const symrefMatch = result.match(/ref:\s+refs\/heads\/(.+?)\tHEAD/);
			if (symrefMatch) {
				return symrefMatch[1];
			}
		} catch {
			// Network unavailable - caller will use cached value
		}
	}

	return null;
}

export async function checkNeedsRebase(
	worktreePath: string,
	defaultBranch: string,
): Promise<boolean> {
	const git = simpleGit(worktreePath);
	const behindCount = await git.raw([
		"rev-list",
		"--count",
		`HEAD..origin/${defaultBranch}`,
	]);
	return Number.parseInt(behindCount.trim(), 10) > 0;
}

export async function hasUncommittedChanges(
	worktreePath: string,
): Promise<boolean> {
	const git = simpleGit(worktreePath);
	const status = await git.status();
	return !status.isClean();
}

export async function hasUnpushedCommits(
	worktreePath: string,
): Promise<boolean> {
	const git = simpleGit(worktreePath);
	try {
		const aheadCount = await git.raw([
			"rev-list",
			"--count",
			"@{upstream}..HEAD",
		]);
		return Number.parseInt(aheadCount.trim(), 10) > 0;
	} catch {
		try {
			const localCommits = await git.raw([
				"rev-list",
				"--count",
				"HEAD",
				"--not",
				"--remotes",
			]);
			return Number.parseInt(localCommits.trim(), 10) > 0;
		} catch {
			return false;
		}
	}
}

export type BranchExistsResult =
	| { status: "exists" }
	| { status: "not_found" }
	| { status: "error"; message: string };

/**
 * Git exit codes for ls-remote --exit-code:
 * - 0: Refs found (branch exists)
 * - 2: No matching refs (branch doesn't exist)
 * - 128: Fatal error (auth, network, invalid repo, etc.)
 */
const GIT_EXIT_CODES = {
	SUCCESS: 0,
	NO_MATCHING_REFS: 2,
	FATAL_ERROR: 128,
} as const;

/**
 * Patterns for categorizing git fatal errors (exit code 128).
 * These are checked against lowercase error messages/stderr.
 */
const GIT_ERROR_PATTERNS = {
	network: [
		"could not resolve host",
		"unable to access",
		"connection refused",
		"network is unreachable",
		"timed out",
		"ssl",
		"could not read from remote",
	],
	auth: [
		"authentication",
		"permission denied",
		"403",
		"401",
		// SSH-specific auth failures
		"permission denied (publickey)",
		"host key verification failed",
	],
	remoteNotConfigured: [
		"does not appear to be a git repository",
		"no such remote",
		"repository not found",
		"remote origin not found",
	],
} as const;

function categorizeGitError(errorMessage: string): BranchExistsResult {
	const lowerMessage = errorMessage.toLowerCase();

	if (GIT_ERROR_PATTERNS.network.some((p) => lowerMessage.includes(p))) {
		return {
			status: "error",
			message: "Cannot connect to remote. Check your network connection.",
		};
	}

	if (GIT_ERROR_PATTERNS.auth.some((p) => lowerMessage.includes(p))) {
		return {
			status: "error",
			message: "Authentication failed. Check your Git credentials.",
		};
	}

	if (
		GIT_ERROR_PATTERNS.remoteNotConfigured.some((p) => lowerMessage.includes(p))
	) {
		return {
			status: "error",
			message:
				"Remote 'origin' is not configured or the repository was not found.",
		};
	}

	return {
		status: "error",
		message: `Failed to verify branch: ${errorMessage}`,
	};
}

export async function branchExistsOnRemote(
	worktreePath: string,
	branchName: string,
): Promise<BranchExistsResult> {
	const env = await getGitEnv();

	try {
		// Use execFileAsync directly to get reliable exit codes
		// simple-git doesn't expose exit codes in a predictable way
		await execFileAsync(
			"git",
			[
				"-C",
				worktreePath,
				"ls-remote",
				"--exit-code",
				"--heads",
				"origin",
				branchName,
			],
			{ env, timeout: 30_000 },
		);
		// Exit code 0 = branch exists (--exit-code flag ensures this)
		return { status: "exists" };
	} catch (error) {
		// Use type guard to safely access ExecFileException properties
		if (!isExecFileException(error)) {
			return {
				status: "error",
				message: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		// Handle spawn/system errors first (code is a string like "ENOENT")
		if (typeof error.code === "string") {
			if (error.code === "ENOENT") {
				return {
					status: "error",
					message: "Git is not installed or not found in PATH.",
				};
			}
			if (error.code === "ETIMEDOUT") {
				return {
					status: "error",
					message: "Git command timed out. Check your network connection.",
				};
			}
			// Other system errors
			return {
				status: "error",
				message: `System error: ${error.code}`,
			};
		}

		// Handle killed/timed out processes (timeout option triggers this)
		if (error.killed || error.signal) {
			return {
				status: "error",
				message: "Git command timed out. Check your network connection.",
			};
		}

		// Now code is numeric - it's a git exit code
		if (error.code === GIT_EXIT_CODES.NO_MATCHING_REFS) {
			return { status: "not_found" };
		}

		// For fatal errors (128) or other codes, categorize using stderr (preferred) or message
		// stderr contains the actual git error; message may include wrapper text
		const errorText = error.stderr || error.message || "";
		return categorizeGitError(errorText);
	}
}

/**
 * Detect which branch a worktree was likely based off of.
 * Uses merge-base to find the closest common ancestor with candidate base branches.
 */
export async function detectBaseBranch(
	worktreePath: string,
	currentBranch: string,
	defaultBranch: string,
): Promise<string | null> {
	const git = simpleGit(worktreePath);

	// Candidate base branches to check, in priority order
	const candidates = [
		defaultBranch,
		"main",
		"master",
		"develop",
		"development",
	].filter((b, i, arr) => arr.indexOf(b) === i); // dedupe

	let bestCandidate: string | null = null;
	let bestAheadCount = Number.POSITIVE_INFINITY;

	for (const candidate of candidates) {
		// Skip if this is the current branch
		if (candidate === currentBranch) continue;

		try {
			// Check if the remote branch exists
			const remoteBranch = `origin/${candidate}`;
			await git.raw(["rev-parse", "--verify", remoteBranch]);

			// Count how many commits the current branch is ahead of the merge-base
			// The branch with the fewest commits "ahead" is likely the base
			const mergeBase = await git.raw(["merge-base", "HEAD", remoteBranch]);
			const aheadCount = await git.raw([
				"rev-list",
				"--count",
				`${mergeBase.trim()}..HEAD`,
			]);

			const count = Number.parseInt(aheadCount.trim(), 10);
			if (count < bestAheadCount) {
				bestAheadCount = count;
				bestCandidate = candidate;
			}
		} catch {}
	}

	return bestCandidate;
}

/**
 * Lists all local and remote branches in a repository
 * @param repoPath - Path to the repository
 * @param options.fetch - Whether to fetch and prune remote refs first (default: false)
 * @returns Object with local and remote branch arrays
 */
export async function listBranches(
	repoPath: string,
	options?: { fetch?: boolean },
): Promise<{ local: string[]; remote: string[] }> {
	const git = simpleGit(repoPath);

	// Optionally fetch and prune to get up-to-date remote refs
	if (options?.fetch) {
		try {
			await git.fetch(["--prune"]);
		} catch {
			// Ignore fetch errors (e.g., offline)
		}
	}

	// Get local branches
	const localResult = await git.branchLocal();
	const local = localResult.all;

	// Get remote branches (strip "origin/" prefix)
	const remoteResult = await git.branch(["-r"]);
	const remote = remoteResult.all
		.filter((b) => b.startsWith("origin/") && !b.includes("->"))
		.map((b) => b.replace("origin/", ""));

	return { local, remote };
}

/**
 * Gets the current branch name (HEAD)
 * @param repoPath - Path to the repository
 * @returns The current branch name, or null if in detached HEAD state
 */
export async function getCurrentBranch(
	repoPath: string,
): Promise<string | null> {
	const git = simpleGit(repoPath);
	try {
		const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
		const trimmed = branch.trim();
		// "HEAD" means detached HEAD state
		return trimmed === "HEAD" ? null : trimmed;
	} catch {
		return null;
	}
}

/**
 * Result of pre-checkout safety checks
 */
export interface CheckoutSafetyResult {
	safe: boolean;
	error?: string;
	hasUncommittedChanges?: boolean;
	hasUntrackedFiles?: boolean;
}

/**
 * Performs safety checks before a branch checkout:
 * 1. Checks for uncommitted changes (staged/unstaged/created/renamed)
 * 2. Checks for untracked files that might be overwritten
 * 3. Runs git fetch --prune to clean up stale remote refs
 * @param repoPath - Path to the repository
 * @returns Safety check result indicating if checkout is safe
 */
export async function checkBranchCheckoutSafety(
	repoPath: string,
): Promise<CheckoutSafetyResult> {
	const git = simpleGit(repoPath);

	try {
		const status = await git.status();

		const hasUncommittedChanges =
			status.staged.length > 0 ||
			status.modified.length > 0 ||
			status.deleted.length > 0 ||
			status.created.length > 0 ||
			status.renamed.length > 0 ||
			status.conflicted.length > 0;

		const hasUntrackedFiles = status.not_added.length > 0;

		if (hasUncommittedChanges) {
			return {
				safe: false,
				error:
					"Cannot switch branches: you have uncommitted changes. Please commit or stash your changes first.",
				hasUncommittedChanges: true,
				hasUntrackedFiles,
			};
		}

		// Block on untracked files as they could be overwritten by checkout
		if (hasUntrackedFiles) {
			return {
				safe: false,
				error:
					"Cannot switch branches: you have untracked files that may be overwritten. Please commit, stash, or remove them first.",
				hasUncommittedChanges: false,
				hasUntrackedFiles: true,
			};
		}

		// Fetch and prune stale remote refs (best-effort, ignore errors if offline)
		try {
			await git.fetch(["--prune"]);
		} catch {
			// Ignore fetch errors
		}

		return {
			safe: true,
			hasUncommittedChanges: false,
			hasUntrackedFiles: false,
		};
	} catch (error) {
		return {
			safe: false,
			error: `Failed to check repository status: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Checks out a branch in a repository.
 * If the branch only exists on remote, creates a local tracking branch.
 * @param repoPath - Path to the repository
 * @param branch - The branch name to checkout
 */
export async function checkoutBranch(
	repoPath: string,
	branch: string,
): Promise<void> {
	const git = simpleGit(repoPath);

	// Check if branch exists locally
	const localBranches = await git.branchLocal();
	if (localBranches.all.includes(branch)) {
		await git.checkout(branch);
		return;
	}

	// Branch doesn't exist locally - check if it exists on remote and create tracking branch
	const remoteBranches = await git.branch(["-r"]);
	const remoteBranchName = `origin/${branch}`;
	if (remoteBranches.all.includes(remoteBranchName)) {
		// Create local branch tracking the remote
		await git.checkout(["-b", branch, "--track", remoteBranchName]);
		return;
	}

	// Branch doesn't exist anywhere - let git checkout fail with its normal error
	await git.checkout(branch);
}

/**
 * Safe branch checkout that performs safety checks first.
 * This is the preferred method for branch workspaces.
 * @param repoPath - Path to the repository
 * @param branch - Branch to checkout
 * @throws Error if safety checks fail or checkout fails
 */
/**
 * Checks if a git ref exists locally (without network access).
 * Uses --verify --quiet to only check exit code without output.
 * @param repoPath - Path to the repository
 * @param ref - The ref to check (e.g., "main", "origin/main")
 * @returns true if the ref exists locally, false otherwise
 */
export async function refExistsLocally(
	repoPath: string,
	ref: string,
): Promise<boolean> {
	const git = simpleGit(repoPath);
	try {
		// Use --verify --quiet to check if ref exists without output
		// Append ^{commit} to ensure it resolves to a commit-ish
		await git.raw(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Sanitizes git error messages for user display.
 * Strips "fatal:" prefixes, excessive newlines, and other git plumbing text.
 * @param message - Raw git error message
 * @returns Cleaned message suitable for UI display
 */
export function sanitizeGitError(message: string): string {
	return message
		.replace(/^fatal:\s*/i, "")
		.replace(/^error:\s*/i, "")
		.replace(/\n+/g, " ")
		.trim();
}

export async function safeCheckoutBranch(
	repoPath: string,
	branch: string,
): Promise<void> {
	// Check if we're already on the target branch - no checkout needed
	const currentBranch = await getCurrentBranch(repoPath);
	if (currentBranch === branch) {
		return;
	}

	// Run safety checks before switching branches
	const safety = await checkBranchCheckoutSafety(repoPath);
	if (!safety.safe) {
		throw new Error(safety.error);
	}

	// Proceed with checkout
	await checkoutBranch(repoPath, branch);

	// Verify we landed on the correct branch
	const verifyBranch = await getCurrentBranch(repoPath);
	if (verifyBranch !== branch) {
		throw new Error(
			t("Branch checkout verification failed: expected \"{{branch}}\" but HEAD is on \"{{actual}}\"", { branch, actual: verifyBranch ?? "detached HEAD" }),
		);
	}
}

// ============ Utility functions for chats.ts compatibility ============

export interface WorktreeResult {
	success: boolean;
	worktreePath?: string;
	branch?: string;
	baseBranch?: string;
	error?: string;
}

export interface CreateWorktreeForChatOptions {
	onSetupComplete?: (result: WorktreeSetupResult) => void;
	/**
	 * "new" (default): derive a brand-new branch from the selected base branch.
	 * "existing": check out an already-existing branch into the worktree instead
	 * of creating a new one (reuses a worktree that already has the branch
	 * checked out when possible).
	 */
	branchMode?: "new" | "existing";
}

/**
 * Create a git worktree for a chat (wrapper for chats.ts)
 * @param projectPath - Path to the main repository
 * @param projectSlug - Sanitized project name for worktree directory
 * @param chatId - Chat ID (used for logging)
 * @param selectedBaseBranch - Optional branch to base the worktree off (defaults to auto-detected default branch)
 */
export async function createWorktreeForChat(
	projectPath: string,
	projectSlug: string,
	chatId: string,
	selectedBaseBranch?: string,
	branchType?: "local" | "remote",
	options?: CreateWorktreeForChatOptions,
): Promise<WorktreeResult> {
	try {
		const git = simpleGit(projectPath);
		// `checkIsRepo()` can surface different behavior across simple-git/platform
		// combinations; `rev-parse --is-inside-work-tree` is the explicit check we
		// want for deciding whether worktree mode is possible.
		const isRepo = await git
			.revparse(["--is-inside-work-tree"])
			.then((value) => value.trim() === "true")
			.catch(() => false);

		if (!isRepo) {
			return { success: true, worktreePath: projectPath };
		}

		const branchMode = options?.branchMode ?? "existing";

		// Use provided base branch or auto-detect
		const baseBranch = selectedBaseBranch || await getDefaultBranch(projectPath);

		// ------------------------------------------------------------------
		// "existing" mode: check out an already-existing branch instead of
		// deriving a new one. Each chat gets its own worktree directory, even
		// when the branch is already checked out elsewhere (shared branch,
		// independent worktree; uses `git worktree add -f`).
		// ------------------------------------------------------------------
		if (branchMode === "existing") {
			const branch = baseBranch;

			// Create an independent worktree directory even when this branch is
			// already checked out elsewhere (shared branch, independent worktree).
			const worktreesDir = join(homedir(), ".ergatai", "worktrees");
			const projectWorktreeDir = join(worktreesDir, projectSlug);
			const folderName = generateWorktreeFolderName(projectWorktreeDir);
			const worktreePath = join(projectWorktreeDir, folderName);

			// Determine whether the branch exists locally or only on remote.
			const localBranches = (await git.branchLocal()).all;
			const remoteBranches = (await git.branch(["-r"])).all
				.filter((b) => b.startsWith("origin/") && !b.includes("->"))
				.map((b) => b.replace("origin/", ""));

			if (localBranches.includes(branch)) {
				await createWorktree(projectPath, branch, worktreePath, branch, false, true);
			} else if (remoteBranches.includes(branch)) {
				// Create a local tracking branch for the remote branch.
				await execFileAsync(
					"git",
					[
						"-C",
						projectPath,
						"worktree",
						"add",
						"-f",
						"-b",
						branch,
						worktreePath,
						`origin/${branch}`,
					],
					{ env: await getGitEnv(), timeout: 120_000 },
				);
			} else {
				return {
					success: false,
					error: `Branch not found: ${branch}`,
				};
			}

			// Run worktree setup commands in BACKGROUND.
			executeWorktreeSetup(worktreePath, projectPath)
				.then((setupResult) => {
					options?.onSetupComplete?.(setupResult);
					if (!setupResult.success) {
						console.warn(
							`[worktree] Setup completed with errors: ${setupResult.errors.join(", ")}`,
						);
					} else {
						console.log(
							`[worktree] Setup completed successfully for ${chatId}`,
						);
					}
				})
				.catch((setupError) => {
					const errorMsg =
						setupError instanceof Error
							? setupError.message
							: String(setupError);
					options?.onSetupComplete?.({
						success: false,
						commandsRun: 0,
						output: [`[error] ${errorMsg}`],
						errors: [errorMsg],
					});
					console.warn(`[worktree] Setup failed: ${errorMsg}`);
				});

			return { success: true, worktreePath, branch };
		}

		// ------------------------------------------------------------------
		// "new" mode (default): derive a brand-new branch from the selected base
		// ------------------------------------------------------------------
		let branch = generateBranchName(baseBranch, chatId);
		branch = await ensureUniqueBranchName(projectPath, branch);
		const worktreesDir = join(homedir(), ".ergatai", "worktrees");
		const projectWorktreeDir = join(worktreesDir, projectSlug);
		const folderName = generateWorktreeFolderName(projectWorktreeDir);
		const worktreePath = join(projectWorktreeDir, folderName);

		// Determine startPoint based on branch type
		// For local branches, use the local ref directly
		// For remote branches or when type is not specified, use origin/{branch}
		const startPoint =
			branchType === "local" ? baseBranch : `origin/${baseBranch}`;

		await createWorktree(projectPath, branch, worktreePath, startPoint);

		// Run worktree setup commands in BACKGROUND (don't block chat creation)
		// This allows the user to start chatting immediately while deps install
		executeWorktreeSetup(worktreePath, projectPath)
			.then((setupResult) => {
				options?.onSetupComplete?.(setupResult);
				if (!setupResult.success) {
					console.warn(
						`[worktree] Setup completed with errors: ${setupResult.errors.join(", ")}`,
					);
				} else {
					console.log(
						`[worktree] Setup completed successfully for ${chatId}`,
					);
				}
			})
			.catch((setupError) => {
				const errorMsg =
					setupError instanceof Error
						? setupError.message
						: String(setupError);
				options?.onSetupComplete?.({
					success: false,
					commandsRun: 0,
					output: [`[error] ${errorMsg}`],
					errors: [errorMsg],
				});
				console.warn(`[worktree] Setup failed: ${errorMsg}`);
			});

		return { success: true, worktreePath, branch, baseBranch };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Find the worktree path that already has `branch` checked out, if any.
 * Returns null when the branch is not checked out in any worktree.
 */
export async function findCheckedOutWorktreePath(
	projectPath: string,
	branch: string,
): Promise<string | null> {
	try {
		const git = simpleGit(projectPath);
		const worktreeList = await git.raw(["worktree", "list", "--porcelain"]);
		const lines = worktreeList.split("\n");
		let currentPath: string | null = null;
		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				currentPath = line.substring(9).trim();
			} else if (line.startsWith("branch ")) {
				const b = line.substring(7).trim().replace("refs/heads/", "");
				if (b === branch && currentPath) {
					return currentPath;
				}
			}
		}
	} catch {
		// ignore
	}
	return null;
}

/**
 * Get diff for a worktree compared to its base branch
 * @param worktreePath - Path to the worktree
 * @param baseBranch - The base branch to compare against (if not provided, uses default branch)
 */
export async function getWorktreeDiff(
	worktreePath: string,
	baseBranch?: string,
	options?: { onlyUncommitted?: boolean },
): Promise<{ success: boolean; diff?: string; error?: string }> {
	try {
		const git = simpleGit(worktreePath);
		const status = await git.status();
		const _currentBranch = status.current;

		// Has uncommitted changes - diff against HEAD
		if (!status.isClean()) {
			const exclusionArgs = [
				":!*.lock",
				":!*-lock.*",
				":!package-lock.json",
				":!pnpm-lock.yaml",
				":!yarn.lock",
			];

			const workingDiff = await git.diff([
				"HEAD",
				"--no-color",
				"--",
				...exclusionArgs,
			]);

			const untrackedFiles = status.not_added.filter((file) => {
				if (file.endsWith(".lock")) return false;
				if (file.includes("-lock.")) return false;
				if (file.endsWith("package-lock.json")) return false;
				if (file.endsWith("pnpm-lock.yaml")) return false;
				if (file.endsWith("yarn.lock")) return false;
				return true;
			});

			// git diff --no-index only accepts 2 paths, so we need to diff each file separately
			// Also, git diff --no-index returns exit code 1 when files differ, which simple-git treats as error
			// So we use raw() to get the output regardless of exit code
			const untrackedDiffs: string[] = [];
			for (const file of untrackedFiles) {
				try {
					const fileDiff = await git.raw([
						"diff",
						"--no-color",
						"--no-index",
						devNull,
						file,
					]);
					if (fileDiff) {
						untrackedDiffs.push(fileDiff);
					}
				} catch (error: unknown) {
					// git diff --no-index returns exit code 1 when files differ
					// simple-git throws but includes the diff output in the error
					const gitError = error as { message?: string };
					if (gitError.message && gitError.message.includes("diff --git")) {
						// Extract the diff from the error message
						const diffStart = gitError.message.indexOf("diff --git");
						if (diffStart !== -1) {
							untrackedDiffs.push(gitError.message.substring(diffStart));
						}
					}
				}
			}
			const untrackedDiff = untrackedDiffs.join("\n");

			const combinedDiff = [workingDiff, untrackedDiff]
				.filter(Boolean)
				.join("\n");

			return { success: true, diff: combinedDiff };
		}

		// All committed - if onlyUncommitted mode, return empty diff
		if (options?.onlyUncommitted) {
			return { success: true, diff: "" };
		}

		// All committed - diff against base branch
		const targetBranch = baseBranch || await getDefaultBranch(worktreePath);

		// Use origin if available, fallback to local branch
		const baseRef = await refExistsLocally(worktreePath, `origin/${targetBranch}`)
			? `origin/${targetBranch}`
			: targetBranch;

		try {
			const diff = await git.diff([
				`${baseRef}...HEAD`,
				"--no-color",
				"--",
				":!*.lock",
				":!*-lock.*",
				":!package-lock.json",
				":!pnpm-lock.yaml",
				":!yarn.lock",
			]);
			return { success: true, diff: diff || "" };
		} catch {
			return { success: true, diff: "" };
		}
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Commit all changes in a worktree
 */
export async function commitWorktreeChanges(
	worktreePath: string,
	message: string,
): Promise<{ success: boolean; commitHash?: string; error?: string }> {
	try {
		const git = simpleGit(worktreePath);

		await git.add("-A");

		const status = await git.status();
		const hasChanges = status.staged.length > 0 || status.files.length > 0;

		if (!hasChanges) {
			return { success: false, error: "No changes to commit" };
		}

		const result = await git.commit(message);

		return { success: true, commitHash: result.commit };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Merge worktree branch into base branch
 */
export async function mergeWorktreeToMain(
	projectPath: string,
	worktreeBranch: string,
	baseBranch: string,
): Promise<{ success: boolean; error?: string }> {
	const git = simpleGit(projectPath);

	try {
		await git.checkout(baseBranch);
		await git.merge([worktreeBranch, "--no-edit"]);

		return { success: true };
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : "Unknown error";

		if (errorMsg.includes("CONFLICT") || errorMsg.includes("merge failed")) {
			await git.merge(["--abort"]).catch(() => {});
			return {
				success: false,
				error: "Merge conflicts detected. Please resolve manually.",
			};
		}

		return { success: false, error: errorMsg };
	}
}

/**
 * Push worktree branch to remote
 */
export async function pushWorktreeBranch(
	worktreePath: string,
	branch: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		const git = simpleGit(worktreePath);

		const remotes = await git.getRemotes();
		if (remotes.length === 0) {
			return { success: false, error: "No remote repository configured" };
		}

		await git.push(["-u", "origin", branch]);

		return { success: true };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Get current git status summary
 */
export interface MergeChatBranchResult {
	status:
		| "nothing_to_merge"
		| "needs_manual_merge"
		| "merged"
		| "error";
	reason?: string;
	conflictedFiles?: string[];
	error?: string;
}

export async function resolveProjectPathFromWorktree(
	worktreePath: string,
): Promise<string> {
	const git = simpleGit(worktreePath);
	try {
		const commonDir = (await git.revparse(["--git-common-dir"])).trim();
		// commonDir may be relative to worktreePath
		const absoluteCommon = resolve(worktreePath, commonDir);
		// commonDir is <project>/.git (or <project>/.git/worktrees/<name> for old layouts)
		// The project path is the parent of the .git directory.
		let projectPath = absoluteCommon;
		// Strip trailing /worktrees/<name> if present
		const idx = projectPath.lastIndexOf(".git");
		if (idx !== -1) {
			projectPath = projectPath.slice(0, idx);
		}
		return projectPath || worktreePath;
	} catch {
		return worktreePath;
	}
}

export async function mergeChatBranchIntoBase(
	projectPath: string,
	chatBranch: string,
	baseBranch: string,
	options?: { push?: boolean },
): Promise<MergeChatBranchResult> {
	// Resolve base checkout location.
	let baseRepoPath = await findCheckedOutWorktreePath(projectPath, baseBranch);
	let needCheckout = false;
	if (!baseRepoPath) {
		baseRepoPath = projectPath;
		needCheckout = true;
	}

	if (needCheckout) {
		try {
			await safeCheckoutBranch(baseRepoPath, baseBranch);
		} catch (error) {
			const dirty = await hasUncommittedChanges(baseRepoPath).catch(() => false);
			if (dirty) {
				return { status: "needs_manual_merge", reason: "base_dirty" };
			}
			return {
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	// Dirty check.
	if (await hasUncommittedChanges(baseRepoPath).catch(() => false)) {
		return { status: "needs_manual_merge", reason: "base_dirty" };
	}

	// Repo state check.
	const repoState = await getRepositoryState(baseRepoPath).catch(() => null);
	if (
		repoState &&
		(repoState.isRebasing ||
			repoState.isMerging ||
			repoState.isCherryPicking ||
			repoState.isReverting)
	) {
		return { status: "needs_manual_merge", reason: "repo_busy" };
	}

	const git = simpleGit(baseRepoPath);

	// Ahead commits check.
	let ahead = 0;
	try {
		const out = await git.raw(["rev-list", "--count", `${baseBranch}..${chatBranch}`]);
		ahead = Number.parseInt(out.trim(), 10) || 0;
	} catch {
		// Fall back: try from projectPath's git namespace (branch may be registered).
		try {
			const g2 = simpleGit(projectPath);
			const out = await g2.raw(["rev-list", "--count", `${baseBranch}..${chatBranch}`]);
			ahead = Number.parseInt(out.trim(), 10) || 0;
		} catch {
			ahead = 0;
		}
	}

	if (ahead === 0) {
		return { status: "nothing_to_merge" };
	}

	// Attempt merge.
	try {
		await git.merge([chatBranch, "--no-edit"]);
	} catch (error) {
		const status = await git.status().catch(() => null);
		const conflicted = status?.conflicted ?? [];
		await git.merge(["--abort"]).catch(() => {});
		if (conflicted.length > 0) {
			return {
				status: "needs_manual_merge",
				reason: "conflict",
				conflictedFiles: conflicted,
			};
		}
		return {
			status: "needs_manual_merge",
			reason: "merge_failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}

	if (options?.push) {
		try {
			await git.push();
		} catch {
			// Push is optional/best-effort.
		}
	}

	return { status: "merged" };
}

export interface SyncWorktreeToBaseResult {
	status:
		| "nothing_to_sync"
		| "needs_manual_merge"
		| "synced"
		| "error";
	filesChanged?: number;
	reason?: string;
	conflictedFiles?: string[];
	error?: string;
}

/**
 * Paths that belong to the harness/tooling rather than the project. They exist
 * in both the main checkout and every worktree, but usually hold per-worktree
 * state, so syncing them back would create noisy conflicts.
 */
const SYNC_EXCLUDED_PREFIXES = [
	".git/",
	".claude/",
	".codex/",
	".cursor/",
	".ergatai/",
	".next/",
	".opencode/",
	".turbo/",
	"coverage/",
	"node_modules/",
	"target/",
	"worktrees/",
];

const SYNC_EXCLUDED_FILES = new Set([".DS_Store", "Thumbs.db"]);

function isSyncExcludedPath(relativePath: string): boolean {
	const normalized = relativePath.replaceAll("\\", "/");
	if (SYNC_EXCLUDED_FILES.has(normalized)) return true;
	return SYNC_EXCLUDED_PREFIXES.some(
		(prefix) =>
			normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
	);
}

/** Git's blob hash is sha1("blob <byte-length>\\0" + content). */
function gitBlobHash(content: Buffer): string {
	const header = Buffer.from(`blob ${content.length}\0`, "utf8");
	return createHash("sha1").update(header).update(content).digest("hex");
}

const MAX_SYNC_FILE_BYTES = 100 * 1024 * 1024;

async function getPathContentHash(absPath: string): Promise<string | null> {
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(absPath);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}

	if (info.isSymbolicLink()) {
		// Git stores a symlink as a blob containing its target path.
		return gitBlobHash(Buffer.from(await readlink(absPath), "utf8"));
	}
	if (!info.isFile()) return null;
	if (info.size > MAX_SYNC_FILE_BYTES) {
		throw new Error(
			`Refusing to sync ${absPath}: file is larger than 100 MB`,
		);
	}
	return gitBlobHash(await readFile(absPath));
}

async function getBlobHashAtRevision(
	repoPath: string,
	revision: string,
	relativePath: string,
): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", [
			"-C",
			repoPath,
			"rev-parse",
			"--verify",
			"--quiet",
			`${revision}:${relativePath}`,
		]);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Remember which content this app last wrote into the base working tree for a
 * given worktree. Without it, the second sync would mistake our own previous
 * (still uncommitted) output for a user edit and refuse to update the file.
 *
 * The file lives under the repository's common .git directory, so it survives
 * restarts without polluting the project or creating commits.
 */
type SyncState = {
	version: 1;
	/** relative path -> blob hash last written, or null for a deletion */
	paths: Record<string, string | null>;
	/** Chat branch HEAD that was squash-applied to the base working tree. */
	lastSyncedCommit?: string;
};

async function getSyncStatePath(
	projectPath: string,
	worktreePath: string,
	chatBranch: string,
): Promise<string> {
	const { stdout } = await execFileAsync("git", [
		"-C",
		projectPath,
		"rev-parse",
		"--git-common-dir",
	]);
	const commonDirRaw = stdout.trim();
	const commonDir = isAbsolute(commonDirRaw)
		? commonDirRaw
		: resolve(projectPath, commonDirRaw);
	const id = createHash("sha1")
		.update(`${resolve(worktreePath)}\0${chatBranch}`)
		.digest("hex")
		.slice(0, 16);
	return join(commonDir, "ergatai-sync", `${id}.json`);
}

async function readSyncState(statePath: string): Promise<SyncState> {
	try {
		const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<SyncState>;
		if (parsed && parsed.version === 1 && parsed.paths && typeof parsed.paths === "object") {
			return {
				version: 1,
				paths: { ...parsed.paths },
				lastSyncedCommit:
					typeof parsed.lastSyncedCommit === "string"
						? parsed.lastSyncedCommit
						: undefined,
			};
		}
	} catch {
		// Missing or malformed state is treated as a first sync.
	}
	return { version: 1, paths: {} };
}

async function writeSyncState(
	statePath: string,
	state: SyncState,
): Promise<void> {
	await mkdir(dirname(statePath), { recursive: true });
	await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

const SYNC_COMMIT_PREFIX = "ergatai-sync:";

async function runGit(
	repoPath: string,
	args: string[],
	maxBuffer = 20 * 1024 * 1024,
): Promise<string> {
	const { stdout } = await execFileAsync(
		"git",
		["-C", repoPath, ...args],
		{ maxBuffer },
	);
	return stdout;
}

async function hasStagedChanges(repoPath: string): Promise<boolean> {
	try {
		await runGit(repoPath, ["diff", "--cached", "--quiet"]);
		return false;
	} catch (error) {
		if (isExecFileException(error) && error.code === 1) return true;
		throw error;
	}
}

/**
 * Stage the worktree, excluding harness/tooling directories. Returns true when
 * there is at least one staged project change.
 */
async function stageWorktreeChanges(worktreePath: string): Promise<boolean> {
	await runGit(worktreePath, ["add", "-A", "--", "."]);

	const staged = (
		await runGit(worktreePath, ["diff", "--cached", "--name-only", "-z"])
	)
		.split("\0")
		.filter(Boolean);
	const excluded = staged.filter(isSyncExcludedPath);
	for (let index = 0; index < excluded.length; index += 100) {
		await runGit(worktreePath, [
			"reset",
			"-q",
			"--",
			...excluded.slice(index, index + 100),
		]);
	}

	return hasStagedChanges(worktreePath);
}

/**
 * Create (or amend) the single disposable snapshot commit on the chat branch.
 * This commit is the merge source for `git merge --squash`; it is never pushed
 * and never becomes part of the base branch history.
 */
async function commitStagedSnapshot(
	worktreePath: string,
	chatBranch: string,
	hasStagedChanges: boolean,
): Promise<{ head: string; committed: boolean }> {
	if (!hasStagedChanges) {
		return {
			head: (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim(),
			committed: false,
		};
	}

	const subject = (
		await runGit(worktreePath, ["log", "-1", "--format=%s"])
	).trim();
	const identity = [
		"-c",
		"user.name=Ergatai",
		"-c",
		"user.email=ergatai@local",
		"-c",
		"commit.gpgsign=false",
	];
	if (subject.startsWith(SYNC_COMMIT_PREFIX)) {
		// Reverting the worktree back to the previous snapshot would make the
		// amend an empty commit. Drop our disposable commit instead.
		const parent = await runGit(worktreePath, [
			"rev-parse",
			"HEAD^",
		]).catch(() => null);
		if (parent) {
			const parentTree = (
				await runGit(worktreePath, [
					"rev-parse",
					`${parent.trim()}^{tree}`,
				])
			).trim();
			const stagedTree = (
				await runGit(worktreePath, ["write-tree"])
			).trim();
			if (stagedTree === parentTree) {
				await runGit(worktreePath, ["reset", "--mixed", "HEAD^"]);
				return { head: parent.trim(), committed: false };
			}
		}

		await runGit(worktreePath, [
			...identity,
			"commit",
			"--no-verify",
			"--amend",
			"--no-edit",
		]);
	} else {
		await runGit(worktreePath, [
			...identity,
			"commit",
			"--no-verify",
			"-m",
			`${SYNC_COMMIT_PREFIX} ${chatBranch}`,
		]);
	}

	return {
		head: (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim(),
		committed: true,
	};
}

/**
 * Preflight a merge without touching either working tree. Returns null when
 * `git merge-tree` is unavailable (older git), an empty array for a clean
 * merge, or the conflicted file names.
 */
async function getMergeTreeConflicts(
	repoPath: string,
	baseRevision: string,
	chatRevision: string,
): Promise<string[] | null> {
	try {
		await runGit(repoPath, [
			"merge-tree",
			"--write-tree",
			"--name-only",
			baseRevision,
			chatRevision,
		]);
		return [];
	} catch (error) {
		if (isExecFileException(error) && error.code === 1) {
			const output = typeof error.stdout === "string" ? error.stdout : "";
			const lines = output.split("\n");
			const files: string[] = [];
			for (let index = 1; index < lines.length; index += 1) {
				const line = lines[index].trim();
				if (!line) break;
				files.push(line);
			}
			return files;
		}
		// merge-tree is not available (or failed for a non-conflict reason).
		return null;
	}
}

async function removeSquashMessage(repoPath: string): Promise<void> {
	try {
		const relativePath = (
			await runGit(repoPath, ["rev-parse", "--git-path", "SQUASH_MSG"])
		).trim();
		const absolutePath = isAbsolute(relativePath)
			? relativePath
			: resolve(repoPath, relativePath);
		await unlink(absolutePath).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	} catch {
		// Best effort: a stale SQUASH_MSG only affects the next manual commit.
	}
}

async function resetIndexPaths(
	repoPath: string,
	paths: string[],
): Promise<void> {
	for (let index = 0; index < paths.length; index += 100) {
		await runGit(repoPath, [
			"reset",
			"-q",
			"--",
			...paths.slice(index, index + 100),
		]);
	}
}

async function stagePaths(repoPath: string, paths: string[]): Promise<void> {
	for (let index = 0; index < paths.length; index += 100) {
		await runGit(repoPath, [
			"add",
			"-A",
			"--",
			...paths.slice(index, index + 100),
		]);
	}
}

async function restorePathToHead(
	repoPath: string,
	relativePath: string,
	headHash: string | null,
): Promise<void> {
	if (headHash === null) {
		await unlink(join(repoPath, relativePath)).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			},
		);
		return;
	}
	await runGit(repoPath, ["checkout", "HEAD", "--", relativePath]);
}

/**
 * Rebase the disposable chat branch onto the current base tip. This advances
 * the merge-base so a previous squash (committed by the user) is not mistaken
 * for an independent edit on the base side.
 */
async function rebaseChatBranchOnto(
	worktreePath: string,
	ontoRevision: string,
): Promise<
	| { ok: true; head: string }
	| { ok: false; conflicts: string[]; error: string }
> {
	try {
		await runGit(worktreePath, [
			"rebase",
			"--autostash",
			"--no-verify",
			ontoRevision,
		]);
		return {
			ok: true,
			head: (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim(),
		};
	} catch (error) {
		let conflicts: string[] = [];
		try {
			conflicts = (
				await runGit(worktreePath, [
					"diff",
					"--name-only",
					"--diff-filter=U",
					"-z",
				])
			)
				.split("\0")
				.filter(Boolean);
		} catch {
			// Best effort; the abort below restores the worktree anyway.
		}
		await runGit(worktreePath, ["rebase", "--abort"]).catch(() => {});
		return {
			ok: false,
			conflicts,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Undo the files written by the previous sync, but only when they still match
 * exactly what we recorded. User edits and staged changes are left untouched.
 */
async function clearPreviousSyncPaths(
	baseRepoPath: string,
	syncState: SyncState,
	stagedPaths: Set<string>,
): Promise<{ error?: string }> {
	for (const [relativePath, recordedHash] of Object.entries(
		syncState.paths,
	)) {
		if (isSyncExcludedPath(relativePath)) continue;
		if (stagedPaths.has(relativePath)) continue;

		const baseAbsPath = join(baseRepoPath, relativePath);
		let baseWorkingHash: string | null;
		try {
			baseWorkingHash = await getPathContentHash(baseAbsPath);
		} catch {
			continue;
		}
		const baseHeadHash = await getBlobHashAtRevision(
			baseRepoPath,
			"HEAD",
			relativePath,
		);

		if (baseWorkingHash === baseHeadHash) continue;
		if (baseWorkingHash !== recordedHash) continue;

		try {
			await restorePathToHead(
				baseRepoPath,
				relativePath,
				baseHeadHash,
			);
		} catch (error) {
			return {
				error:
					error instanceof Error ? error.message : String(error),
			};
		}
	}
	return {};
}

/**
 * Apply the current state of a chat worktree to the base branch's working tree
 * without adding commits to the base branch or touching the remote.
 *
 * The chat worktree is committed into one disposable snapshot commit (amended
 * in place on every sync). That commit is only a merge source:
 *
 *   worktree snapshot commit
 *     -> git merge --squash into the base checkout
 *     -> git reset (leave ordinary unstaged changes)
 *
 * The base branch ref never moves and `git log` on the base branch is
 * unchanged. A per-worktree state file records which paths were written, so a
 * later sync can first undo its own previous output without touching the
 * user's edits.
 */
export async function syncWorktreeChangesToBase(
	projectPath: string,
	worktreePath: string,
	chatBranch: string,
	baseBranch: string,
): Promise<SyncWorktreeToBaseResult> {
	if (resolve(projectPath) === resolve(worktreePath)) {
		return {
			status: "error",
			error: "Worktree path and project path are the same",
		};
	}

	// 1. Read the current chat HEAD. The worktree may still have uncommitted
	// changes; they are preserved by the autostash rebase below.
	let chatHead: string;
	try {
		chatHead = (
			await runGit(worktreePath, ["rev-parse", "HEAD"])
		).trim();
	} catch (error) {
		return {
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		};
	}

	// 2. Resolve where the base branch is checked out.
	let baseRepoPath = await findCheckedOutWorktreePath(projectPath, baseBranch);
	if (!baseRepoPath) {
		baseRepoPath = projectPath;
		try {
			await safeCheckoutBranch(baseRepoPath, baseBranch);
		} catch (error) {
			const dirty = await hasUncommittedChanges(baseRepoPath).catch(
				() => false,
			);
			return {
				status: "needs_manual_merge",
				reason: dirty ? "base_dirty" : "checkout_failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	const repoState = await getRepositoryState(baseRepoPath).catch(() => null);
	if (
		repoState &&
		(repoState.isRebasing ||
			repoState.isMerging ||
			repoState.isCherryPicking ||
			repoState.isReverting)
	) {
		return { status: "needs_manual_merge", reason: "repo_busy" };
	}

	// Only write into a checkout that is actually on the base branch.
	try {
		const currentBaseBranch = (
			await simpleGit(baseRepoPath).revparse(["--abbrev-ref", "HEAD"])
		).trim();
		if (currentBaseBranch !== baseBranch) {
			return {
				status: "error",
				error: `Base checkout is on "${currentBaseBranch}", expected "${baseBranch}"`,
			};
		}
	} catch (error) {
		return {
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		};
	}

	// 3. Load the per-worktree sync state.
	let syncStatePath: string;
	try {
		syncStatePath = await getSyncStatePath(
			projectPath,
			worktreePath,
			chatBranch,
		);
	} catch (error) {
		return {
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		};
	}
	// Read sync state and inspect the worktree state concurrently; neither
	// depends on the other.
	const [syncState, chatState] = await Promise.all([
		readSyncState(syncStatePath),
		getRepositoryState(worktreePath).catch(() => null),
	]);
	if (
		chatState &&
		(chatState.isRebasing ||
			chatState.isMerging ||
			chatState.isCherryPicking ||
			chatState.isReverting)
	) {
		return { status: "needs_manual_merge", reason: "worktree_busy" };
	}

	// 4. If the base advanced since the chat branch forked, rebase the
	// disposable snapshot commit onto the new base tip. Otherwise every later
	// sync sees the user's previously committed sync as an independent base
	// edit and reports a false conflict.
	let baseHead: string;
	try {
		baseHead = (
			await runGit(baseRepoPath, ["rev-parse", "HEAD"])
		).trim();
	} catch (error) {
		return {
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		};
	}

	let mergeBase: string;
	try {
		mergeBase = (
			await runGit(projectPath, ["merge-base", baseHead, chatHead])
		).trim();
	} catch (error) {
		return {
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		};
	}
	if (!mergeBase) {
		return { status: "error", error: "Could not resolve merge base" };
	}

	if (mergeBase !== baseHead) {
		const rebased = await rebaseChatBranchOnto(worktreePath, baseHead);
		if (!rebased.ok) {
			return {
				status: "needs_manual_merge",
				reason:
					rebased.conflicts.length > 0 ? "conflict" : "rebase_failed",
				conflictedFiles: rebased.conflicts.slice(0, 50),
				error: rebased.error,
			};
		}
		chatHead = rebased.head;
	}

	// Stage and snapshot the current worktree state on the (possibly rebased)
	// chat branch. The snapshot commit is amended in place on every sync.
	let committed = false;
	try {
		const hasChanges = await stageWorktreeChanges(worktreePath);
		const snapshot = await commitStagedSnapshot(
			worktreePath,
			chatBranch,
			hasChanges,
		);
		chatHead = snapshot.head;
		committed = snapshot.committed;
	} catch (error) {
		return {
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		};
	}

	// Nothing new since the last successful squash.
	if (!committed && syncState.lastSyncedCommit === chatHead) {
		return { status: "nothing_to_sync" };
	}

	// 5. Compute the committed delta between the base HEAD and the snapshot.
	let mergePaths: string[];
	try {
		mergePaths = (
			await runGit(
				projectPath,
				[
					"diff",
					"--name-only",
					"-z",
					"--no-renames",
					`${baseHead}..${chatHead}`,
				],
				50 * 1024 * 1024,
			)
		)
			.split("\0")
			.filter(Boolean)
			.filter((relativePath) => !isSyncExcludedPath(relativePath));
	} catch (error) {
		return {
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		};
	}

	let stagedPaths: Set<string>;
	try {
		stagedPaths = new Set(
			(
				await runGit(baseRepoPath, [
					"diff",
					"--cached",
					"--name-only",
					"-z",
				])
			)
				.split("\0")
				.filter(Boolean),
		);
	} catch (error) {
		return {
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		};
	}

	// The worktree was reverted to the base state. Remove the previous sync
	// from the base working tree as well.
	if (mergePaths.length === 0) {
		const cleanup = await clearPreviousSyncPaths(
			baseRepoPath,
			syncState,
			stagedPaths,
		);
		if (cleanup.error) {
			return { status: "error", error: cleanup.error };
		}
		await writeSyncState(syncStatePath, {
			version: 1,
			paths: {},
			lastSyncedCommit: chatHead,
		}).catch(() => {});
		return { status: "nothing_to_sync" };
	}

	// 5. Refuse to overwrite local edits in the base checkout.

	const conflicts: string[] = [];
	let hasDirtyConflict = false;

	for (const relativePath of mergePaths) {
		const baseAbsPath = join(baseRepoPath, relativePath);
		let baseWorkingHash: string | null;
		try {
			baseWorkingHash = await getPathContentHash(baseAbsPath);
		} catch (error) {
			return {
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			};
		}

		const baseHeadHash = await getBlobHashAtRevision(
			baseRepoPath,
			"HEAD",
			relativePath,
		);
		const hasState = Object.prototype.hasOwnProperty.call(
			syncState.paths,
			relativePath,
		);
		const stateHash = hasState
			? syncState.paths[relativePath]
			: undefined;

		// A staged edit is always the user's; our sync leaves changes unstaged.
		if (stagedPaths.has(relativePath)) {
			conflicts.push(relativePath);
			hasDirtyConflict = true;
			continue;
		}

		// Clean checkout at this path.
		if (baseWorkingHash === baseHeadHash) continue;

		// Our previous sync, still untouched by the user.
		if (hasState && baseWorkingHash === stateHash) continue;

		conflicts.push(relativePath);
		hasDirtyConflict = true;
	}

	if (conflicts.length > 0) {
		return {
			status: "needs_manual_merge",
			reason: "base_dirty",
			conflictedFiles: conflicts.slice(0, 50),
		};
	}

	// 6. Preflight committed-side conflicts without touching the worktree.
	const mergeTreeConflicts = await getMergeTreeConflicts(
		baseRepoPath,
		baseHead,
		chatHead,
	);
	if (mergeTreeConflicts && mergeTreeConflicts.length > 0) {
		return {
			status: "needs_manual_merge",
			reason: "conflict",
			conflictedFiles: mergeTreeConflicts.slice(0, 50),
		};
	}

	// 7. Remove our own previous sync from the base working tree. This makes
	// the new snapshot apply cleanly even though the base already contains the
	// previous (uncommitted) sync. User edits are never touched.
	const cleanup = await clearPreviousSyncPaths(
		baseRepoPath,
		syncState,
		stagedPaths,
	);
	if (cleanup.error) {
		return { status: "error", error: cleanup.error };
	}

	// 8. Squash the snapshot commit into the base checkout.
	const baseGit = simpleGit(baseRepoPath);
	try {
		await baseGit.merge(["--squash", chatBranch]);
	} catch (error) {
		await runGit(baseRepoPath, ["reset", "--merge"]).catch(() => {});
		// `reset --merge` clears the index; put back any edits the user had
		// staged before the sync.
		await stagePaths(baseRepoPath, [...stagedPaths]).catch(() => {});
		await removeSquashMessage(baseRepoPath);
		const status = await baseGit.status().catch(() => null);
		const conflicted = status?.conflicted ?? [];
		return {
			status: "needs_manual_merge",
			reason: conflicted.length > 0 ? "conflict" : "merge_failed",
			conflictedFiles:
				conflicted.length > 0 ? conflicted.slice(0, 50) : undefined,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	// `merge --squash` stages the result; keep the files but unstage only the
	// paths this sync touched, preserving unrelated staged edits.
	await resetIndexPaths(baseRepoPath, mergePaths).catch(() => {});
	await removeSquashMessage(baseRepoPath);

	// 9. Record what we wrote so the next sync can clean up its own output.
	const nextState: SyncState = {
		version: 1,
		paths: {},
		lastSyncedCommit: chatHead,
	};
	let filesChanged = 0;
	for (const relativePath of mergePaths) {
		let writtenHash: string | null;
		try {
			writtenHash = await getPathContentHash(
				join(baseRepoPath, relativePath),
			);
		} catch (error) {
			return {
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			};
		}
		const headHash = await getBlobHashAtRevision(
			baseRepoPath,
			"HEAD",
			relativePath,
		);
		if (writtenHash !== headHash) filesChanged += 1;
		nextState.paths[relativePath] = writtenHash;
	}

	try {
		await writeSyncState(syncStatePath, nextState);
	} catch (error) {
		return {
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		};
	}

	return { status: "synced", filesChanged };
}

export async function getGitStatus(worktreePath: string): Promise<{
	hasUncommittedChanges: boolean;
	hasUnpushedCommits: boolean;
	currentBranch: string;
	error?: string;
}> {
	try {
		const git = simpleGit(worktreePath);
		const status = await git.status();

		return {
			hasUncommittedChanges: !status.isClean(),
			hasUnpushedCommits: status.ahead > 0,
			currentBranch: status.current || "",
		};
	} catch (error) {
		return {
			hasUncommittedChanges: false,
			hasUnpushedCommits: false,
			currentBranch: "",
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}