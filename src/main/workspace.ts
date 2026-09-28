import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkspaceHealth, WorkspaceRepoHealth } from "../shared/ipc";

const CORE_REPOS = ["cosmos-ai", "segway-next", "nebula"] as const;
const CORE_REPO_SET = new Set<string>(CORE_REPOS);

export function inspectWorkspace(rootPath: string): WorkspaceHealth {
	const rootExists = existsSync(rootPath);
	const rootIsDirectory = rootExists ? safeIsDirectory(rootPath) : false;
	const repos = CORE_REPOS.map((name) => inspectRepo(rootPath, name));
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

function inspectRepo(rootPath: string, name: string): WorkspaceRepoHealth {
	const path = join(rootPath, name);
	const exists = existsSync(path);
	const isDirectory = exists ? safeIsDirectory(path) : false;
	const isGitRepo = isDirectory && existsSync(join(path, ".git"));
	return {
		name,
		path,
		exists,
		isDirectory,
		isGitRepo,
	};
}

function inspectExperiments(rootPath: string): WorkspaceRepoHealth[] {
	try {
		return readdirSync(rootPath, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() &&
					!entry.name.startsWith(".") &&
					!CORE_REPO_SET.has(entry.name),
			)
			.map((entry) => inspectRepo(rootPath, entry.name))
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
