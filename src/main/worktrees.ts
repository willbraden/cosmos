import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { WorktreeSupport } from "../shared/ipc";

const BRANCH_SEGMENT_LIMIT = 48;

export function managedWorktreeRoot(
	userDataDir: string,
	repoPath: string,
): string {
	return join(
		userDataDir,
		"worktrees",
		sanitizeSegment(basename(resolve(repoPath))) || "repo",
	);
}

export function sanitizeSegment(
	value: string,
	maxLength = BRANCH_SEGMENT_LIMIT,
): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLength);
}

export function planManagedWorktree(
	managedRoot: string,
	taskGroupId: string,
	workerId: string,
): { path: string; branch: string } {
	const group = sanitizeSegment(taskGroupId, 24) || "task";
	const worker = sanitizeSegment(workerId, 24) || "worker";
	return {
		path: join(managedRoot, `${group}-${worker}`),
		branch: `cosmos/${group}/${worker}`,
	};
}

export async function getWorktreeSupport(
	cwd: string,
	userDataDir: string,
): Promise<WorktreeSupport> {
	const repoPath = resolve(cwd);
	const managedRoot = managedWorktreeRoot(userDataDir, repoPath);
	const gitBinary = await hasGitBinary();
	if (!gitBinary) {
		return {
			available: false,
			repoPath,
			managedRoot,
			gitBinary: false,
			isGitRepo: false,
			reason: "Git is not installed or is not on PATH.",
		};
	}
	const gitRepo = await resolveGitTopLevel(repoPath);
	if (!gitRepo) {
		return {
			available: false,
			repoPath,
			managedRoot,
			gitBinary: true,
			isGitRepo: false,
			reason: "This folder is not inside a Git repository.",
		};
	}
	mkdirSync(managedRoot, { recursive: true });
	return {
		available: true,
		repoPath: gitRepo,
		managedRoot,
		gitBinary: true,
		isGitRepo: true,
	};
}

export async function previewManagedWorktree(
	cwd: string,
	userDataDir: string,
	taskGroupId: string,
	workerId: string,
): Promise<{ path: string; branch: string }> {
	const support = await getWorktreeSupport(cwd, userDataDir);
	if (!support.available)
		throw new Error(support.reason ?? "Worktrees are not available.");
	return planManagedWorktree(support.managedRoot, taskGroupId, workerId);
}

async function hasGitBinary(): Promise<boolean> {
	try {
		await execGit(["--version"]);
		return true;
	} catch {
		return false;
	}
}

async function resolveGitTopLevel(cwd: string): Promise<string | null> {
	try {
		const topLevel = (
			await execGit(["rev-parse", "--show-toplevel"], cwd)
		).trim();
		return topLevel && existsSync(topLevel) ? topLevel : null;
	} catch {
		return null;
	}
}

function execGit(args: string[], cwd?: string): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout) => {
				if (error) return reject(error);
				resolvePromise(stdout);
			},
		);
	});
}
