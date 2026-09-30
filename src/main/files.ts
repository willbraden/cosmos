import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { FileMatch } from "../shared/ipc";

const CACHE_MS = 20_000;
const MAX_FILES = 50_000;
const MAX_RESULTS = 40;
const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	".next",
	"dist",
	"build",
	"out",
	".venv",
	"venv",
	"__pycache__",
	"target",
	".cache",
]);

const cache = new Map<string, { at: number; files: Promise<string[]> }>();

/** Fuzzy file search inside a project, for `@` mentions in the composer. */
export async function searchProjectFiles(
	cwd: string,
	query: string,
): Promise<FileMatch[]> {
	if (typeof cwd !== "string" || !isAbsolute(cwd) || typeof query !== "string")
		return [];
	const files = await listFiles(cwd);
	const q = query.toLowerCase();
	const dirs = new Set<string>();
	for (const file of files) {
		let slash = file.lastIndexOf("/");
		while (slash > 0) {
			dirs.add(`${file.slice(0, slash)}/`);
			slash = file.lastIndexOf("/", slash - 1);
		}
	}
	const scored: { path: string; isDirectory: boolean; score: number }[] = [];
	for (const [path, isDirectory] of [
		...files.map((f) => [f, false] as const),
		...[...dirs].map((d) => [d, true] as const),
	]) {
		const score = q
			? fuzzyScore(path.toLowerCase(), q)
			: isDirectory
				? -path.length - 50
				: -path.length;
		if (score !== null) scored.push({ path, isDirectory, score });
	}
	scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
	return scored
		.slice(0, MAX_RESULTS)
		.map(({ path, isDirectory }) => ({ path, isDirectory }));
}

/**
 * Subsequence match; rewards contiguous runs and matches in the file name.
 * Returns null when the query is not a subsequence of the path.
 */
export function fuzzyScore(path: string, query: string): number | null {
	const nameStart = path.lastIndexOf("/", path.length - 2) + 1;
	let score = 0;
	let run = 0;
	let from = 0;
	for (const char of query) {
		const index = path.indexOf(char, from);
		if (index === -1) return null;
		run = index === from ? run + 1 : 0;
		score +=
			1 +
			run * 3 +
			(index >= nameStart ? 2 : 0) -
			Math.min(index - from, 10) * 0.1;
		from = index + 1;
	}
	if (path.slice(nameStart).startsWith(query)) score += 10;
	return score - path.length * 0.01;
}

export async function listProjectFiles(
	cwd: string,
	dir = "",
): Promise<string[]> {
	if (typeof cwd !== "string" || !isAbsolute(cwd)) return [];
	const normalized = normalizeRelativeDir(dir);
	if (normalized === null) return [];
	const files = await listFiles(cwd);
	if (!normalized) return files;
	const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
	return files.filter((file) => file.startsWith(prefix));
}

function listFiles(cwd: string): Promise<string[]> {
	const hit = cache.get(cwd);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.files;
	const files = gitFiles(cwd).catch(() => walk(cwd));
	cache.set(cwd, { at: Date.now(), files });
	return files;
}

function gitFiles(cwd: string): Promise<string[]> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
			{ cwd, maxBuffer: 64 * 1024 * 1024, timeout: 10_000 },
			(error, stdout) => {
				if (error) return reject(error);
				resolve(stdout.split("\0").filter(Boolean).slice(0, MAX_FILES));
			},
		);
	});
}

async function walk(root: string): Promise<string[]> {
	const out: string[] = [];
	const queue = [root];
	while (queue.length > 0 && out.length < MAX_FILES) {
		const dir = queue.shift() as string;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") && entry.name !== ".github") continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) queue.push(full);
			} else if (entry.isFile()) {
				out.push(relative(root, full).split(sep).join("/"));
			}
		}
	}
	return out;
}

function normalizeRelativeDir(dir: string): string | null {
	const normalized = dir
		.trim()
		.replace(/^\.\//, "")
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	if (!normalized || normalized === ".") return "";
	if (
		normalized === ".." ||
		normalized.startsWith("../") ||
		normalized.includes("/../")
	)
		return null;
	return normalized;
}

export async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}
