import { spawn } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { WorkspaceHealth, WorkspaceRepoHealth } from "../shared/ipc";

/** GitHub org the curated company repos live in. Overridable from Settings. */
export const DEFAULT_CORE_REPO_ORG = "shipt";

const CORE_REPOS = ["cosmos-ai", "segway-next", "nebula"] as const;
const CORE_REPO_SET = new Set<string>(CORE_REPOS);

/** Cloning a large monorepo can take minutes, so give git plenty of room. */
const CLONE_TIMEOUT_MS = 20 * 60 * 1000;

export function isCoreRepoName(name: string): boolean {
	return CORE_REPO_SET.has(name);
}

export function isValidOrgName(org: string): boolean {
	return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(org);
}

export function normalizeOrg(org: string | undefined): string {
	const trimmed = (org ?? "").trim();
	return isValidOrgName(trimmed) ? trimmed : DEFAULT_CORE_REPO_ORG;
}

export function coreRepoCloneUrl(name: string, org?: string): string {
	return `git@github.com:${normalizeOrg(org)}/${name}.git`;
}

export function inspectWorkspace(
	rootPath: string,
	org?: string,
): WorkspaceHealth {
	const rootExists = existsSync(rootPath);
	const rootIsDirectory = rootExists ? safeIsDirectory(rootPath) : false;
	const repos = CORE_REPOS.map((name) =>
		inspectRepo(rootPath, name, coreRepoCloneUrl(name, org)),
	);
	const experiments = rootIsDirectory ? inspectExperiments(rootPath) : [];
	return {
		rootPath,
		rootExists,
		rootIsDirectory,
		repos,
		experiments,
		readyRepos: repos.filter((repo) => repo.exists && repo.isGitRepo).length,
	};
}

function inspectRepo(
	rootPath: string,
	name: string,
	cloneUrl?: string,
): WorkspaceRepoHealth {
	const path = join(rootPath, name);
	const linkTarget = readSymlink(path);
	const exists = existsSync(path);
	const isDirectory = exists ? safeIsDirectory(path) : false;
	const isGitRepo = isDirectory && existsSync(join(path, ".git"));
	return {
		name,
		path,
		exists,
		isDirectory,
		isGitRepo,
		isSymlink: linkTarget !== undefined,
		...(linkTarget ? { linkTarget } : {}),
		...(cloneUrl ? { cloneUrl } : {}),
	};
}

function inspectExperiments(rootPath: string): WorkspaceRepoHealth[] {
	try {
		return readdirSync(rootPath, { withFileTypes: true })
			.filter(
				(entry) =>
					// readdir does not follow links, so linked checkouts report as symlinks.
					(entry.isDirectory() || entry.isSymbolicLink()) &&
					!entry.name.startsWith(".") &&
					!CORE_REPO_SET.has(entry.name),
			)
			.map((entry) => inspectRepo(rootPath, entry.name))
			.filter((repo) => repo.isDirectory || repo.isSymlink)
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

export function isPathInsideWorkspace(path: string, rootPath: string): boolean {
	const normalizedRoot = ensureTrailingSlash(resolve(rootPath));
	const normalizedPath = resolve(path);
	return (
		normalizedPath === resolve(rootPath) ||
		normalizedPath.startsWith(normalizedRoot)
	);
}

/** Reject names that would escape the workspace root or hide as a dotfile. */
export function assertWorkspaceEntryName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Enter a folder name");
	const hasControlChars = [...trimmed].some(
		(char) => (char.codePointAt(0) ?? 0) < 0x20,
	);
	if (
		trimmed === "." ||
		trimmed === ".." ||
		trimmed.startsWith(".") ||
		/[\\/]/.test(trimmed) ||
		hasControlChars
	) {
		throw new Error(
			"Use a single visible folder name without slashes, '..', or control characters",
		);
	}
	return trimmed;
}

/** Absolute path for a workspace entry, verified to stay inside the root. */
export function workspaceEntryPath(rootPath: string, name: string): string {
	const entryPath = resolve(join(rootPath, assertWorkspaceEntryName(name)));
	if (!isPathInsideWorkspace(entryPath, rootPath)) {
		throw new Error(
			`Workspace entries must live inside ${rootPath}. Cosmos is locked to the company workspace.`,
		);
	}
	return entryPath;
}

export interface CloneRepoOptions {
	rootPath: string;
	name: string;
	url: string;
	env?: NodeJS.ProcessEnv;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

/**
 * Clone into a staging sibling and rename it into place, so an interrupted clone
 * never leaves a half-populated `<root>/<name>` that later looks "ready".
 */
export async function cloneWorkspaceRepo(
	options: CloneRepoOptions,
): Promise<string> {
	const { rootPath, url, env, onProgress, signal } = options;
	const name = assertWorkspaceEntryName(options.name);
	const target = workspaceEntryPath(rootPath, name);
	if (pathExists(target)) {
		throw new Error(`${name} already exists in ${rootPath}.`);
	}
	if (!/^(?:git@|ssh:\/\/|https:\/\/|file:\/\/)/.test(url)) {
		throw new Error("Clone URLs must use git@, ssh://, https://, or file://");
	}
	mkdirSync(rootPath, { recursive: true });
	const staging = `${target}.cosmos-clone-${process.pid}-${Date.now()}`;
	try {
		await runGitClone({ url, staging, env, onProgress, signal });
		if (pathExists(target)) {
			throw new Error(`${name} already exists in ${rootPath}.`);
		}
		// Staging sits next to the target, so this rename stays on one filesystem.
		renameSync(staging, target);
		return target;
	} finally {
		if (pathExists(staging)) rmSync(staging, { recursive: true, force: true });
	}
}

function runGitClone({
	url,
	staging,
	env,
	onProgress,
	signal,
}: {
	url: string;
	staging: string;
	env?: NodeJS.ProcessEnv;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<void> {
	return new Promise((settle, reject) => {
		const child = spawn("git", ["clone", "--progress", "--", url, staging], {
			env: {
				...(env ?? process.env),
				// Never let git block on an interactive credential or host-key prompt.
				GIT_TERMINAL_PROMPT: "0",
				GIT_SSH_COMMAND:
					env?.GIT_SSH_COMMAND ??
					"ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, CLONE_TIMEOUT_MS);
		timer.unref?.();
		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort, { once: true });

		let tail = "";
		const consume = (chunk: Buffer) => {
			const text = chunk.toString();
			tail = `${tail}${text}`.slice(-4000);
			// git writes progress updates with \r, so split on both break characters.
			const line = text.split(/[\r\n]+/).filter(Boolean).pop();
			if (line) onProgress?.(line.trim());
		};
		child.stdout?.on("data", consume);
		child.stderr?.on("data", consume);

		const finish = (error?: Error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else settle();
		};
		child.on("error", (error) =>
			finish(
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? new Error("git was not found on your PATH")
					: error,
			),
		);
		child.on("close", (code, killSignal) => {
			if (code === 0) return finish();
			if (timedOut) return finish(new Error("git clone timed out"));
			if (killSignal) return finish(new Error("Clone was cancelled"));
			finish(new Error(cloneFailureMessage(lastMeaningfulLine(tail), url, code)));
		});
	});
}

export interface LinkRepoOptions {
	rootPath: string;
	name: string;
	targetPath: string;
}

/** Symlink an existing checkout from elsewhere on disk into the workspace root. */
export function linkWorkspaceRepo({
	rootPath,
	name,
	targetPath,
}: LinkRepoOptions): string {
	const entryName = assertWorkspaceEntryName(name);
	const linkPath = workspaceEntryPath(rootPath, entryName);
	const target = resolve(targetPath);
	if (!existsSync(target) || !safeIsDirectory(target)) {
		throw new Error(`${target} is not a folder.`);
	}
	if (isPathInsideWorkspace(target, rootPath)) {
		throw new Error(
			`${target} is already inside the workspace root, so it does not need a link.`,
		);
	}
	if (pathExists(linkPath)) {
		throw new Error(
			`${entryName} already exists in ${rootPath}. Remove or rename it first.`,
		);
	}
	mkdirSync(rootPath, { recursive: true });
	symlinkSync(target, linkPath, "dir");
	return linkPath;
}

/** Remove a workspace symlink. Refuses to touch real directories. */
export function unlinkWorkspaceRepo(rootPath: string, name: string): void {
	const entryName = assertWorkspaceEntryName(name);
	const linkPath = workspaceEntryPath(rootPath, entryName);
	if (readSymlink(linkPath) === undefined) {
		throw new Error(
			`${entryName} is a real folder, not a link. Remove it in Finder if you really want it gone.`,
		);
	}
	unlinkSync(linkPath);
}

const CLONE_PROGRESS_NOISE =
	/^(Cloning into|Receiving|Resolving|Updating files|remote: (Counting|Compressing|Enumerating|Total))/;

/**
 * git closes a failed clone with "fatal: Could not read from remote repository."
 * and a sentence about access rights that wraps across two lines. None of it
 * names the cause, and the final line is a fragment ("and the repository
 * exists."), so reporting it verbatim tells you nothing.
 */
const CLONE_FAILURE_BOILERPLATE =
	/^(fatal: Could not read from remote repository\.?|Please make sure you have the correct access rights|and the repository exists\.?)$/;

export function lastMeaningfulLine(text: string): string {
	const lines = text
		.split(/[\r\n]+/)
		.map((line) => line.trim())
		.filter((line) => line && !CLONE_PROGRESS_NOISE.test(line));
	// Fall back to the boilerplate only when git gave us nothing else.
	const named = lines.filter((line) => !CLONE_FAILURE_BOILERPLATE.test(line));
	const chosen = named.length > 0 ? named : lines;
	// "ERROR:" is GitHub's own prefix and adds nothing once this is a toast.
	return (chosen[chosen.length - 1] ?? "").replace(/^ERROR:\s*/, "");
}

/**
 * A clone starts from a card showing only the repo's short name, so git saying
 * "Repository not found." leaves out the part worth seeing: which org it tried.
 */
export function cloneFailureMessage(
	line: string,
	url: string,
	code: number | null,
): string {
	if (!line) return `git clone failed (exit ${code ?? "unknown"})`;
	return line.includes(url) ? line : `${line} (${url})`;
}

/** True for anything at `path`, including a symlink whose target is missing. */
function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function readSymlink(path: string): string | undefined {
	try {
		if (!lstatSync(path).isSymbolicLink()) return undefined;
		return resolve(dirname(path), readlinkSync(path));
	} catch {
		return undefined;
	}
}

function ensureTrailingSlash(path: string): string {
	return path.endsWith("/") ? path : `${path}/`;
}

function safeIsDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
