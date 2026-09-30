import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
	GlayvinPackageSummary,
	GlayvinPackSummary,
	GlayvinProfileOverview,
	GlayvinTeamSummary,
} from "../shared/ipc";

/**
 * Cosmos filters this package out of its managed agent directory so the desktop
 * Ask / Accept edits / Auto control stays the only approval layer. Kept in sync with
 * `isBlockedManagedPackageSource` in agent-home.ts.
 */
const COSMOS_EXCLUDED_PACKAGE = /(^|[/@])pi-permission-system(?=$|[@/])/i;

function readJsonObject(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function toStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function toRecordArray(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is Record<string, unknown> =>
					!!item && typeof item === "object" && !Array.isArray(item),
			)
		: [];
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function readTeams(config: Record<string, unknown> | undefined): {
	name: string;
	path: string;
}[] {
	return toRecordArray(config?.teams).flatMap((team) => {
		const name = optionalString(team.name);
		const path = optionalString(team.path);
		return name && path ? [{ name, path }] : [];
	});
}

interface PackOrigin {
	layer: GlayvinPackSummary["layer"];
	teamName?: string;
	manifestPath?: string;
}

/**
 * Resolves which configuration layer a pack manifest came from.
 *
 * `resolved.json` records only pack ids, never the layer or team that supplied them, so this
 * reconstructs Glayvin's documented discovery order rather than reading its output: built-in,
 * then each registered team in registration order with later teams winning, then local. The
 * highest-precedence match is returned.
 */
function locatePack(
	packId: string,
	glayvinHome: string,
	teams: { name: string; path: string }[],
): PackOrigin {
	const localManifest = join(glayvinHome, ".local", "packs", `${packId}.json`);
	if (existsSync(localManifest))
		return { layer: "local", manifestPath: localManifest };

	for (const team of [...teams].reverse()) {
		for (const candidate of [
			join(team.path, "packs", `${packId}.json`),
			join(team.path, ".glayvin", "packs", `${packId}.json`),
		]) {
			if (existsSync(candidate)) {
				return {
					layer: "team",
					teamName: team.name,
					manifestPath: candidate,
				};
			}
		}
	}

	const builtInManifest = join(glayvinHome, "config", "packs", `${packId}.json`);
	if (existsSync(builtInManifest))
		return { layer: "built-in", manifestPath: builtInManifest };

	return { layer: "unknown" };
}

/** Counts how many entries in a resolved list are attributed to `packId`. */
function countOwnedBy(
	entries: Record<string, unknown>[],
	packId: string,
	key: "owner" | "source",
): number {
	return entries.filter((entry) => entry[key] === packId).length;
}

function summarizePackages(
	resolved: Record<string, unknown>,
): GlayvinPackageSummary[] {
	return toRecordArray(resolved.packages).flatMap((entry) => {
		const name = optionalString(entry.name);
		if (!name) return [];
		return [
			{
				name,
				version: optionalString(entry.version),
				pack: optionalString(entry.owner),
				excludedByCosmos: COSMOS_EXCLUDED_PACKAGE.test(name),
			},
		];
	});
}

function unavailable(
	glayvinHome: string | undefined,
	notes: string[],
	extra: Partial<GlayvinProfileOverview> = {},
): GlayvinProfileOverview {
	return {
		available: false,
		glayvinHome,
		packs: [],
		teams: [],
		packages: [],
		notes,
		...extra,
	};
}

/**
 * Read-only view of the Glayvin profile Cosmos already inherits its packages from.
 *
 * Degrades with explanatory notes rather than throwing: a missing Glayvin home, a missing
 * `resolved.json`, or malformed JSON all return `available: false`.
 */
export function getGlayvinProfileOverview(
	glayvinHome: string | undefined,
): GlayvinProfileOverview {
	if (!glayvinHome) {
		return unavailable(undefined, [
			"Glayvin profile details are available when Cosmos can see a Glayvin home.",
		]);
	}

	const resolvedPath = join(glayvinHome, ".local", "resolved.json");
	const configPath = join(glayvinHome, ".local", "glayvin.json");
	const paths = { resolvedPath, configPath };

	if (!existsSync(resolvedPath)) {
		return unavailable(
			glayvinHome,
			[
				"Glayvin has not resolved a profile yet. Start a new Glayvin session or run glayvin-setup.",
			],
			paths,
		);
	}

	const resolved = readJsonObject(resolvedPath);
	if (!resolved) {
		return unavailable(
			glayvinHome,
			[
				`Could not parse ${resolvedPath}. Re-run glayvin-setup to regenerate it.`,
			],
			paths,
		);
	}

	const config = readJsonObject(configPath);
	const registeredTeams = readTeams(config);
	const notes: string[] = [];
	if (!config) {
		notes.push(
			"No readable Glayvin local config was found, so registered teams could not be listed.",
		);
	}

	const extensions = toRecordArray(resolved.extensions);
	const packages = toRecordArray(resolved.packages);
	const skills = toRecordArray(resolved.skills);
	const hooks = toRecordArray(resolved.hooks);
	const commands = toRecordArray(resolved.commands);

	const teamPackIds = new Map<string, string[]>();
	const packs: GlayvinPackSummary[] = toStringArray(resolved.packs).map(
		(packId) => {
			const origin = locatePack(packId, glayvinHome, registeredTeams);
			if (origin.layer === "team" && origin.teamName) {
				teamPackIds.set(origin.teamName, [
					...(teamPackIds.get(origin.teamName) ?? []),
					packId,
				]);
			}
			const manifest = origin.manifestPath
				? readJsonObject(origin.manifestPath)
				: undefined;
			return {
				id: packId,
				layer: origin.layer,
				teamName: origin.teamName,
				manifestPath: origin.manifestPath,
				description: optionalString(manifest?.description),
				packageCount: countOwnedBy(packages, packId, "owner"),
				extensionCount: countOwnedBy(extensions, packId, "source"),
				skillCount: countOwnedBy(skills, packId, "owner"),
				hookCount: countOwnedBy(hooks, packId, "owner"),
				commandCount: countOwnedBy(commands, packId, "owner"),
			};
		},
	);

	const teams: GlayvinTeamSummary[] = registeredTeams.map((team) => ({
		name: team.name,
		path: team.path,
		exists: isDirectory(team.path),
		packIds: teamPackIds.get(team.name) ?? [],
	}));

	if (packs.some((pack) => pack.layer === "unknown")) {
		notes.push(
			"Some packs are active but their manifests could not be located, so their layer is unknown.",
		);
	}
	if (teams.some((team) => !team.exists)) {
		notes.push(
			"Some registered teams point at directories that no longer exist.",
		);
	}
	notes.push(
		"Pack layers are reconstructed from where each manifest sits on disk, because Glayvin's resolved profile records pack ids only.",
	);
	notes.push(
		"Cosmos mirrors this profile's packages into its own agent directory, minus the external permission system, and adds its bundled company package.",
	);

	return {
		available: true,
		glayvinHome,
		resolvedPath,
		configPath,
		profile: optionalString(resolved.profile),
		packs,
		teams,
		packages: summarizePackages(resolved),
		notes,
	};
}
