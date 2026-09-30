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
	if (typeof entry === "string" && entry.trim()) {
		if (
			entry.startsWith("npm:") ||
			entry.startsWith("git:") ||
			entry.startsWith("http://") ||
			entry.startsWith("https://")
		) {
			return entry.trim();
		}
		return resolve(entry);
	}
	if (!entry || typeof entry !== "object") return undefined;
	const source = (entry as Record<string, unknown>).source;
	if (typeof source !== "string" || !source.trim()) return undefined;
	if (
		source.startsWith("npm:") ||
		source.startsWith("git:") ||
		source.startsWith("http://") ||
		source.startsWith("https://")
	) {
		return source.trim();
	}
	return resolve(source);
}

function isBlockedManagedPackageSource(source: string | undefined): boolean {
	if (!source) return false;
	return /(^|[/@])pi-permission-system(?=$|[@/])/i.test(source);
}

function mergeManagedPackages(
	currentPackages: unknown[],
	packageSource: string,
	seedSettings: Record<string, unknown> | undefined,
): unknown[] {
	const seedPackages = Array.isArray(seedSettings?.packages)
		? seedSettings.packages
		: [];
	const currentWithoutCosmos = currentPackages.filter((entry) => {
		const source = normalizePackageEntrySource(entry);
		return (
			!(source && basename(source) === "cosmos-package") &&
			!isBlockedManagedPackageSource(source)
		);
	});
	const merged = [...seedPackages, ...currentWithoutCosmos];
	const deduped: unknown[] = [];
	const seen = new Set<string>();
	for (const entry of merged) {
		const source = normalizePackageEntrySource(entry);
		if (isBlockedManagedPackageSource(source)) continue;
		const key = source ?? JSON.stringify(entry);
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(entry);
	}
	deduped.push({ source: packageSource });
	return deduped;
}

function syncManagedSettings(
	targetDir: string,
	cosmosPackageDir: string,
	seedSettings: Record<string, unknown> | undefined,
): { changed: boolean; packageSource: string } {
	const settingsPath = join(targetDir, "settings.json");
	const current = readJson(settingsPath) ?? {};
	const next = { ...current };
	const packageSource = resolve(cosmosPackageDir);
	next.packages = mergeManagedPackages(
		Array.isArray(current.packages) ? current.packages : [],
		packageSource,
		seedSettings,
	);
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
	const sourceDir = seedCandidates
		.map((path) => resolve(path))
		.find((path) => path !== targetDir && existsSync(path));
	const copied: string[] = [];
	const sourceSettings = sourceDir
		? readJson(join(sourceDir, "settings.json"))
		: undefined;

	if (!alreadyManaged && sourceDir) {
		for (const file of SEEDED_FILES) {
			if (copyIfMissing(join(sourceDir, file), join(targetDir, file)))
				copied.push(file);
		}

		const safeSettings = pickSafePiSettings(sourceSettings);
		if (
			Object.keys(safeSettings).length > 0 &&
			!existsSync(join(targetDir, "settings.json"))
		) {
			writeJson(join(targetDir, "settings.json"), safeSettings);
			copied.push("settings.json(defaults only)");
		}
	}
	const synced = syncManagedSettings(
		targetDir,
		cosmosPackageDir,
		sourceSettings,
	);

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
				"Cosmos copies login and safe defaults, then merges runtime packages from the best available Pi seed profile.",
				"Cosmos filters out external permission-system packages so desktop Ask/Accept edits/Auto remain the only approval layer.",
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
