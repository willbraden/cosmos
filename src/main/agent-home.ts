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
const MANAGED_MARKER_VERSION = 3;
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

/** Stable identity for a package entry, used for dedupe and for the seed ledger. */
function managedPackageKey(entry: unknown): string {
	return normalizePackageEntrySource(entry) ?? JSON.stringify(entry);
}

export interface ManagedPackageMerge {
	packages: unknown[];
	/** Keys of the packages this merge took from the seed, to persist in the marker. */
	seedSources: string[];
}

/**
 * Merges the Pi seed's packages into Cosmos's managed list.
 *
 * `previousSeedSources` is the ledger of what the last merge took from the seed. Entries in
 * that ledger that the seed no longer lists are dropped, so removing a pack in Glayvin
 * propagates; entries that were never in the ledger are user-added and always survive.
 *
 * Two cases deliberately remove nothing. `undefined` means there is no ledger yet (a marker
 * written before the ledger existed), so nothing can be proven seed-derived and this run only
 * records a baseline. And when no seed could be read at all, a missing or unreadable Glayvin
 * must not empty the list, so the previous ledger carries forward untouched.
 */
export function mergeManagedPackages(
	currentPackages: unknown[],
	packageSource: string,
	seedSettings: Record<string, unknown> | undefined,
	previousSeedSources?: readonly string[],
): ManagedPackageMerge {
	const seedPackages = Array.isArray(seedSettings?.packages)
		? seedSettings.packages
		: [];
	const seedEntries: unknown[] = [];
	const seedSources: string[] = [];
	const seedKeys = new Set<string>();
	for (const entry of seedPackages) {
		if (isBlockedManagedPackageSource(normalizePackageEntrySource(entry)))
			continue;
		const key = managedPackageKey(entry);
		if (seedKeys.has(key)) continue;
		seedKeys.add(key);
		seedSources.push(key);
		seedEntries.push(entry);
	}

	const seedWasRead = seedSettings !== undefined;
	const retired = new Set(
		seedWasRead && previousSeedSources
			? previousSeedSources.filter((source) => !seedKeys.has(source))
			: [],
	);

	const currentWithoutCosmos = currentPackages.filter((entry) => {
		const source = normalizePackageEntrySource(entry);
		if (source && basename(source) === "cosmos-package") return false;
		if (isBlockedManagedPackageSource(source)) return false;
		return !retired.has(managedPackageKey(entry));
	});

	const deduped: unknown[] = [];
	const seen = new Set<string>();
	for (const entry of [...seedEntries, ...currentWithoutCosmos]) {
		const key = managedPackageKey(entry);
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(entry);
	}
	deduped.push({ source: packageSource });
	return {
		packages: deduped,
		seedSources: seedWasRead ? seedSources : [...(previousSeedSources ?? [])],
	};
}

function syncManagedSettings(
	targetDir: string,
	cosmosPackageDir: string,
	seedSettings: Record<string, unknown> | undefined,
	previousSeedSources: readonly string[] | undefined,
): { changed: boolean; packageSource: string; seedSources: string[] } {
	const settingsPath = join(targetDir, "settings.json");
	const current = readJson(settingsPath) ?? {};
	const next = { ...current };
	const packageSource = resolve(cosmosPackageDir);
	const merged = mergeManagedPackages(
		Array.isArray(current.packages) ? current.packages : [],
		packageSource,
		seedSettings,
		previousSeedSources,
	);
	next.packages = merged.packages;
	const changed = JSON.stringify(current) !== JSON.stringify(next);
	if (changed) writeJson(settingsPath, next);
	return { changed, packageSource, seedSources: merged.seedSources };
}

/** Returns the recorded seed ledger, or undefined for markers written before it existed. */
function markerSeedSources(
	marker: Record<string, unknown> | undefined,
): string[] | undefined {
	const value = marker?.seedPackages;
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: undefined;
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
	const previousMarker = readJson(marker);
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
		markerSeedSources(previousMarker),
	);

	const nextMarker = {
		version: MANAGED_MARKER_VERSION,
		managedBy: "Cosmos",
		seededFrom: previousMarker
			? typeof previousMarker.seededFrom === "string"
				? previousMarker.seededFrom
				: null
			: (sourceDir ?? null),
		copied:
			previousMarker && Array.isArray(previousMarker.copied)
				? previousMarker.copied
				: copied,
		createdAt:
			typeof previousMarker?.createdAt === "string"
				? previousMarker.createdAt
				: new Date().toISOString(),
		packageSource: synced.packageSource,
		seedPackages: synced.seedSources,
		notes: [
			"This profile is intentionally separate from terminal/Glayvin Pi homes.",
			"Cosmos copies login and safe defaults, then merges runtime packages from the best available Pi seed profile.",
			"seedPackages records what the last merge took from that seed, so packages removed upstream are dropped instead of lingering.",
			"Cosmos filters out external permission-system packages so desktop Ask/Accept edits/Auto remain the only approval layer.",
			"Cosmos also self-registers its bundled company package in this managed profile.",
		],
	};
	if (JSON.stringify(previousMarker ?? null) !== JSON.stringify(nextMarker)) {
		writeJson(marker, nextMarker);
	}

	if (!alreadyManaged) {
		log.info(
			sourceDir
				? `Initialized Cosmos-managed pi profile at ${targetDir} (seeded from ${sourceDir}: ${copied.join(", ") || "no files copied"})`
				: `Initialized Cosmos-managed pi profile at ${targetDir}`,
		);
	} else if (synced.changed) {
		log.info(
			`Updated Cosmos-managed pi profile packages at ${targetDir} (bundled package ${synced.packageSource})`,
		);
	}
	return targetDir;
}
