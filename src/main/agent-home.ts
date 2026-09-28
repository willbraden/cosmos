import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import log from "electron-log/main";

const MANAGED_PROFILE_MARKER = ".cosmos-managed.json";
const SEEDED_FILES = ["auth.json", "models.json", "models-store.json"] as const;

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return value && typeof value === "object"
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2));
}

function copyIfMissing(from: string, to: string): boolean {
	if (!existsSync(from) || existsSync(to)) return false;
	mkdirSync(dirname(to), { recursive: true });
	copyFileSync(from, to);
	return true;
}

function pickSafePiSettings(
	source: Record<string, unknown> | undefined,
): Record<string, unknown> {
	if (!source) return {};
	const next: Record<string, unknown> = {};
	for (const key of [
		"defaultProvider",
		"defaultModel",
		"defaultThinkingLevel",
	]) {
		const value = source[key];
		if (typeof value === "string" && value.trim()) next[key] = value;
	}
	return next;
}

function normalizePackageEntrySource(entry: unknown): string | undefined {
	if (typeof entry === "string" && entry.trim()) return resolve(entry);
	if (!entry || typeof entry !== "object") return undefined;
	const source = (entry as Record<string, unknown>).source;
	return typeof source === "string" && source.trim() ? resolve(source) : undefined;
}

function syncManagedSettings(
	targetDir: string,
	cosmosPackageDir: string,
): { changed: boolean; packageSource: string } {
	const settingsPath = join(targetDir, "settings.json");
	const current = readJson(settingsPath) ?? {};
	const next = { ...current };
	const packageSource = resolve(cosmosPackageDir);
	const existingPackages = Array.isArray(current.packages) ? current.packages : [];
	const filteredPackages = existingPackages.filter((entry) => {
		const source = normalizePackageEntrySource(entry);
		return !(source && basename(source) === "cosmos-package");
	});
	filteredPackages.push({ source: packageSource });
	next.packages = filteredPackages;
	const changed = JSON.stringify(current) !== JSON.stringify(next);
	if (changed) writeJson(settingsPath, next);
	return { changed, packageSource };
}

export function cosmosManagedAgentDir(userDataDir: string): string {
	return join(userDataDir, "pi-agent");
}

export function isCosmosManagedAgentDir(agentDir: string): boolean {
	return existsSync(join(agentDir, MANAGED_PROFILE_MARKER));
}

export function ensureCosmosManagedAgentDir(
	userDataDir: string,
	seedCandidates: string[],
	cosmosPackageDir: string,
): string {
	const targetDir = cosmosManagedAgentDir(userDataDir);
	mkdirSync(join(targetDir, "sessions"), { recursive: true });

	const marker = join(targetDir, MANAGED_PROFILE_MARKER);
	const alreadyManaged = existsSync(marker);
	let sourceDir: string | undefined;
	const copied: string[] = [];

	if (!alreadyManaged) {
		sourceDir = seedCandidates
			.map((path) => resolve(path))
			.find((path) => path !== targetDir && existsSync(path));

		if (sourceDir) {
			for (const file of SEEDED_FILES) {
				if (copyIfMissing(join(sourceDir, file), join(targetDir, file)))
					copied.push(file);
			}

			const safeSettings = pickSafePiSettings(
				readJson(join(sourceDir, "settings.json")),
			);
			if (
				Object.keys(safeSettings).length > 0 &&
				!existsSync(join(targetDir, "settings.json"))
			) {
				writeJson(join(targetDir, "settings.json"), safeSettings);
				copied.push("settings.json(defaults only)");
			}
		}
	}

	const synced = syncManagedSettings(targetDir, cosmosPackageDir);

	if (!alreadyManaged) {
		writeJson(marker, {
			version: 2,
			managedBy: "Cosmos",
			seededFrom: sourceDir ?? null,
			copied,
			createdAt: new Date().toISOString(),
			packageSource: synced.packageSource,
			notes: [
				"This profile is intentionally separate from terminal/Glayvin Pi homes.",
				"Cosmos copies only login and model defaults, not terminal extensions or permission rules.",
				"Cosmos also self-registers its bundled company package in this managed profile.",
			],
		});

		log.info(
			sourceDir
				? `Initialized Cosmos-managed pi profile at ${targetDir} (seeded from ${sourceDir}: ${copied.join(", ") || "no files copied"})`
				: `Initialized Cosmos-managed pi profile at ${targetDir}`,
		);
	} else if (synced.changed) {
		log.info(
			`Updated Cosmos-managed pi profile at ${targetDir} to load bundled package ${synced.packageSource}`,
		);
	}
	return targetDir;
}
