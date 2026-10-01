import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	isDirectory,
	type RegisteredTeam,
	readRegisteredTeams,
} from "./glayvin-runtime";
import type {
	GlayvinPackLayer,
	GlayvinPackageSummary,
	GlayvinPackStatus,
	GlayvinPackSummary,
	GlayvinProfileOverview,
	GlayvinProfileSummary,
	GlayvinTeamContributions,
	GlayvinTeamSummary,
} from "../shared/ipc";

const execFileAsync = promisify(execFile);

/**
 * Cosmos filters this package out of its managed agent directory so the desktop
 * Ask / Accept edits / Auto control stays the only approval layer. Kept in sync with
 * `isBlockedManagedPackageSource` in agent-home.ts.
 */
const COSMOS_EXCLUDED_PACKAGE = /(^|[/@])pi-permission-system(?=$|[@/])/i;

const RESOLVER_TIMEOUT_MS = 4000;

export type ResolverRunner = (
	glayvinHome: string,
	args: string[],
) => Promise<Record<string, unknown> | undefined>;

/**
 * Node executable for short-lived child processes.
 *
 * In the main process `process.execPath` is the Electron binary, which only behaves as
 * Node when `ELECTRON_RUN_AS_NODE` is set. Electron's helper executable avoids the extra
 * app that macOS otherwise shows in Launchpad. Deliberately derived from `process` rather
 * than imported from paths.ts, so this module stays free of the `electron` import and
 * remains testable under plain Node.
 */
function nodeExecutable(): string {
	const helper = (process as NodeJS.Process & { helperExecPath?: string })
		.helperExecPath;
	return helper && existsSync(helper) ? helper : process.execPath;
}

/**
 * Runs one of Glayvin's resolver CLI subcommands and returns its parsed JSON.
 *
 * Invokes `lib/resolver/bin/cli.mjs` directly rather than the `bin/glayvin` bash wrapper.
 * The wrapper installs the resolver's npm dependencies on demand on its setup, launch and
 * update paths; no read path does so today, but a settings pane should not depend on that
 * staying true. Returns undefined on any failure — a missing resolver,
 * missing dependencies, a timeout, or unparseable output all fall back to reading files.
 */
export const runResolverCli: ResolverRunner = async (glayvinHome, args) => {
	const cli = join(glayvinHome, "lib", "resolver", "bin", "cli.mjs");
	if (!existsSync(cli)) return undefined;
	try {
		const { stdout } = await execFileAsync(
			nodeExecutable(),
			[cli, ...args, "--json"],
			{
				cwd: glayvinHome,
				env: {
					...process.env,
					GLAYVIN_HOME: glayvinHome,
					ELECTRON_RUN_AS_NODE: "1",
				},
				encoding: "utf8",
				timeout: RESOLVER_TIMEOUT_MS,
				maxBuffer: 4 * 1024 * 1024,
			},
		);
		return asObject(JSON.parse(stdout) as unknown);
	} catch {
		return undefined;
	}
};

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return asObject(JSON.parse(readFileSync(path, "utf8")) as unknown);
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

/** Lists the manifest ids in a `packs/` or `profiles/` directory. */
function listManifestIds(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => name.slice(0, -".json".length))
			.sort();
	} catch {
		return [];
	}
}

function countEntries(dir: string): number {
	try {
		return readdirSync(dir).filter((name) => !name.startsWith(".")).length;
	} catch {
		return 0;
	}
}

function toLayer(value: unknown): GlayvinPackLayer {
	return value === "built-in" || value === "team" || value === "local"
		? value
		: "unknown";
}

function toStatus(value: unknown): GlayvinPackStatus {
	return value === "effective" || value === "available" || value === "disabled"
		? value
		: "unknown";
}

function readTeamContributions(teamPath: string): GlayvinTeamContributions {
	const servers = asObject(
		readJsonObject(join(teamPath, "mcp-config.json"))?.mcpServers,
	);
	return {
		packIds: listManifestIds(join(teamPath, "packs")),
		profileIds: listManifestIds(join(teamPath, "profiles")),
		mcpServerNames: servers ? Object.keys(servers).sort() : [],
		skillCount: countEntries(join(teamPath, "skills")),
		hasInstructions:
			existsSync(join(teamPath, "copilot-instructions.team.md")) ||
			existsSync(join(teamPath, "copilot-instructions.md")),
	};
}

/**
 * Probes the directories the resolver's `discoverLayers` searches, to find which layer a
 * manifest came from. Highest precedence first.
 *
 * Two path layouts are easy to get wrong, so state them plainly (source of truth is
 * `lib/resolver/src/layers.mjs`):
 *   - the home-local layer is `$GLAYVIN_HOME/.local/glayvin/{packs,profiles}`, with the
 *     extra `glayvin` segment — not `$GLAYVIN_HOME/.local/{packs,profiles}`
 *   - a registered team root holds `{packs,profiles}` directly, not under a nested
 *     `.glayvin/`. `$cwd/.glayvin` is a separate team root in its own right, which is
 *     where the mistaken layout comes from.
 *
 * Later-registered teams win, hence the reversed iteration.
 *
 * Repo-scoped layers (`$cwd/.glayvin` and `$cwd/.local/glayvin`) are deliberately not
 * probed: which repo applies depends on where Glayvin was invoked, which Cosmos cannot
 * know from the seed alone.
 */
function locateManifest(
	kind: "packs" | "profiles",
	id: string,
	glayvinHome: string,
	teams: RegisteredTeam[],
): { layer: GlayvinPackLayer; teamName?: string; manifestPath?: string } {
	const homeLocal = join(glayvinHome, ".local", "glayvin", kind, `${id}.json`);
	if (existsSync(homeLocal)) return { layer: "local", manifestPath: homeLocal };

	for (const team of [...teams].reverse()) {
		if (!team.enabled) continue;
		const candidate = join(team.path, kind, `${id}.json`);
		if (existsSync(candidate))
			return { layer: "team", teamName: team.name, manifestPath: candidate };
	}

	const builtIn = join(glayvinHome, "config", kind, `${id}.json`);
	if (existsSync(builtIn)) return { layer: "built-in", manifestPath: builtIn };

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

interface PackCounts {
	packageCount: number;
	extensionCount: number;
	skillCount: number;
	commandCount: number;
	hookCount: number;
}

function packCounts(
	resolved: Record<string, unknown>,
	packId: string,
): PackCounts {
	return {
		packageCount: countOwnedBy(
			toRecordArray(resolved.packages),
			packId,
			"owner",
		),
		extensionCount: countOwnedBy(
			toRecordArray(resolved.extensions),
			packId,
			"source",
		),
		skillCount: countOwnedBy(toRecordArray(resolved.skills), packId, "owner"),
		commandCount: countOwnedBy(
			toRecordArray(resolved.commands),
			packId,
			"owner",
		),
		hookCount: countOwnedBy(toRecordArray(resolved.hooks), packId, "owner"),
	};
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
		source: "files",
		glayvinHome,
		packs: [],
		profiles: [],
		teams: [],
		packages: [],
		notes,
		...extra,
	};
}

/** Packs the active profile manifest names directly, before `includes` expansion. */
function declaredPackIds(
	profileId: string | undefined,
	glayvinHome: string,
	teams: RegisteredTeam[],
): string[] | undefined {
	if (!profileId) return undefined;
	const located = locateManifest("profiles", profileId, glayvinHome, teams);
	if (!located.manifestPath) return undefined;
	const manifest = readJsonObject(located.manifestPath);
	return manifest ? toStringArray(manifest.packs) : undefined;
}

/**
 * True when a pack is in play because another pack pulled it in, rather than because the
 * profile or the user asked for it. `includes` is a pack listing another in its
 * `includes[]`; `requires:<id>` is a hard dependency. `enabledPacks` is deliberately not
 * transitive — that is a user turning a pack on by hand, outside the profile.
 */
function isTransitiveVia(via: string): boolean {
	return via === "includes" || via.startsWith("requires:");
}

function packsFromResolver(
	cliPacks: Record<string, unknown>[],
	resolved: Record<string, unknown>,
	glayvinHome: string,
	teams: RegisteredTeam[],
	declared: string[] | undefined,
): GlayvinPackSummary[] {
	return cliPacks.flatMap((entry) => {
		const id = optionalString(entry.id);
		if (!id) return [];
		const layer = toLayer(entry.source);
		const status = toStatus(entry.status);
		const via = optionalString(entry.via);
		const teamName =
			layer === "team"
				? // The resolver reports the layer but not which team within it, so this
					// is the one attribution Cosmos still infers. Untestable against real
					// data today: no registered team ships packs.
					locateManifest("packs", id, glayvinHome, teams).teamName
				: undefined;
		return [
			{
				id,
				layer,
				teamName,
				description: optionalString(entry.description),
				status,
				via,
				// The resolver reports why a pack is in play; only diff against the
				// profile when it does not, which is the file-fallback shape.
				implicit:
					status === "effective" &&
					(via
						? isTransitiveVia(via)
						: !!declared && !declared.includes(id)),
				...packCounts(resolved, id),
			},
		];
	});
}

function profilesFromResolver(
	cliProfiles: Record<string, unknown>[],
	glayvinHome: string,
	teams: RegisteredTeam[],
): GlayvinProfileSummary[] {
	return cliProfiles.flatMap((entry) => {
		const id = optionalString(entry.id);
		if (!id) return [];
		const located = locateManifest("profiles", id, glayvinHome, teams);
		const manifest = located.manifestPath
			? readJsonObject(located.manifestPath)
			: undefined;
		return [
			{
				id,
				layer: toLayer(entry.source),
				description: optionalString(entry.description),
				active: entry.active === true,
				packIds: manifest ? toStringArray(manifest.packs) : [],
			},
		];
	});
}

/**
 * Read-only view of the Glayvin profile Cosmos already inherits its packages from.
 *
 * Prefers Glayvin's own resolver, which reports each pack's layer, effective status and
 * inclusion reason directly. Falls back to reading `resolved.json` when the resolver
 * cannot run, which still yields the active profile and its effective packs but no
 * inventory of what else is available.
 *
 * Degrades with explanatory notes rather than throwing: a missing Glayvin home, a
 * missing `resolved.json`, or malformed JSON all return `available: false`.
 */
export async function getGlayvinProfileOverview(
	glayvinHome: string | undefined,
	runner: ResolverRunner = runResolverCli,
): Promise<GlayvinProfileOverview> {
	if (!glayvinHome) {
		return unavailable(undefined, [
			"Glayvin details are available when Cosmos can see a Glayvin home.",
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

	const registeredTeams = readRegisteredTeams(glayvinHome).filter(
		(team) => team.path,
	);
	const teams: GlayvinTeamSummary[] = registeredTeams.map((team) => ({
		name: team.name,
		path: team.path,
		exists: isDirectory(team.path),
		enabled: team.enabled,
		contributes: readTeamContributions(team.path),
	}));

	const notes: string[] = [];
	const activeProfile = optionalString(resolved.profile);
	const declared = declaredPackIds(activeProfile, glayvinHome, registeredTeams);

	const cliPacks = toRecordArray(
		(await runner(glayvinHome, ["packs", "list"]))?.packs,
	);
	const usingResolver = cliPacks.length > 0;

	let packs: GlayvinPackSummary[];
	let profiles: GlayvinProfileSummary[];

	if (usingResolver) {
		packs = packsFromResolver(
			cliPacks,
			resolved,
			glayvinHome,
			registeredTeams,
			declared,
		);
		profiles = profilesFromResolver(
			toRecordArray((await runner(glayvinHome, ["profile", "list"]))?.profiles),
			glayvinHome,
			registeredTeams,
		);
	} else {
		notes.push(
			"Glayvin's resolver could not be run, so this shows the packs already in effect rather than everything available.",
		);
		packs = toStringArray(resolved.packs).map((id) => {
			const located = locateManifest("packs", id, glayvinHome, registeredTeams);
			const manifest = located.manifestPath
				? readJsonObject(located.manifestPath)
				: undefined;
			return {
				id,
				layer: located.layer,
				teamName: located.teamName,
				description: optionalString(manifest?.description),
				status: "effective" as const,
				implicit: !!declared && !declared.includes(id),
				...packCounts(resolved, id),
			};
		});
		profiles = activeProfile
			? [
					{
						id: activeProfile,
						layer: locateManifest(
							"profiles",
							activeProfile,
							glayvinHome,
							registeredTeams,
						).layer,
						active: true,
						packIds: declared ?? [],
					},
				]
			: [];
	}

	if (packs.some((pack) => pack.layer === "unknown")) {
		notes.push(
			"Some packs could not be traced to a layer, because their manifests are no longer on disk.",
		);
	}
	if (teams.some((team) => !team.exists)) {
		notes.push(
			"Some registered teams point at directories that no longer exist.",
		);
	}

	return {
		available: true,
		source: usingResolver ? "resolver" : "files",
		glayvinHome,
		resolvedPath,
		configPath,
		profile: activeProfile,
		packs,
		profiles,
		teams,
		packages: summarizePackages(resolved),
		notes,
	};
}
