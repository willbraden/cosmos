import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

/** Matches the relative specifiers Rollup emits for shared chunks, e.g. "./chunks/shell-env-2lz.js". */
const RELATIVE_SPECIFIER = /["'](\.\.?\/[^"'\n]+\.js)["']/g;

/**
 * Fingerprint of the built supervisor bundle: its entry file plus every chunk it imports,
 * hashed by relative path and content.
 *
 * The client and the supervisor compute this over the same files, so a mismatch means the
 * supervisor answering the socket was built from different code (an older build, or another
 * checkout entirely) and has to be replaced. A build-time constant would not work here,
 * because `electron-vite dev` rebuilds the bundle many times per config evaluation.
 */
export function supervisorBuildId(entryPath: string): string {
	const root = dirname(entryPath);
	const files = new Set<string>();
	collectModuleGraph(entryPath, files);
	const hash = createHash("sha256");
	for (const file of [...files].sort()) {
		hash.update(relative(root, file));
		hash.update("\0");
		hash.update(readFile(file) ?? "\0missing");
		hash.update("\0");
	}
	return hash.digest("hex").slice(0, 16);
}

function collectModuleGraph(file: string, seen: Set<string>): void {
	if (seen.has(file)) return;
	seen.add(file);
	const source = readFile(file);
	if (source === null) return;
	for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
		collectModuleGraph(resolve(dirname(file), match[1]), seen);
	}
}

function readFile(file: string): string | null {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}
