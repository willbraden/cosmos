import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { DesktopSettings } from "../shared/ipc";

export type RuntimePaths = Pick<
	DesktopSettings,
	"agentDirPath" | "glayvinHomePath"
>;

/** A directory of team-layer config (packs, profiles, skills, MCP servers) registered with Glayvin. */
export interface GlayvinTeam {
	name: string;
	path: string;
}

export function detectGlayvinHome(): string | undefined {
	const home = join(homedir(), ".glayvin");
	return existsSync(join(home, ".local", "glayvin-status.json")) ||
		existsSync(join(home, ".pi", "agent", "settings.json"))
		? home
		: undefined;
}

export function inferGlayvinHomeFromAgentDir(
	agentDir: string | undefined,
): string | undefined {
	if (!agentDir) return undefined;
	const normalized = agentDir.replace(/\/+$/, "");
	const piDir = dirname(normalized);
	return basename(normalized) === "agent" && basename(piDir) === ".pi"
		? dirname(piDir)
		: undefined;
}

export function resolveGlayvinHomePath(
	paths: RuntimePaths,
	fallbackGlayvinHome: string | undefined,
): string | undefined {
	return (
		paths.glayvinHomePath ||
		inferGlayvinHomeFromAgentDir(paths.agentDirPath) ||
		fallbackGlayvinHome
	);
}

/**
 * Whether a path is usable as a layer root. The resolver tests registered teams
 * with `existsSync`, which also accepts a plain file sitting at the path; a file
 * is not a layer, so this rejects it.
 */
export function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** A registered team and the state Glayvin's two config files put it in. */
export interface RegisteredTeam extends GlayvinTeam {
	/** `false` for repo-relative paths, which cannot be resolved from here. */
	absolute: boolean;
	/** Not listed under `teams` in disabled.json. Says nothing about the path. */
	enabled: boolean;
}

/**
 * The single read of the two files that define team state: `.local/glayvin.json`
 * registers teams in precedence order, `.local/disabled.json` switches them off
 * by name. Every other team reader here derives from this one, so the panes
 * cannot drift apart on what counts as a team.
 *
 * Entries with an unusable path keep an empty `path` rather than being dropped —
 * they are still memberships, and callers that only need names depend on seeing
 * them.
 */
export function readRegisteredTeams(
	glayvinHome: string | undefined,
): RegisteredTeam[] {
	const config = readLocalJson(glayvinHome, "glayvin.json") as
		| { teams?: unknown }
		| undefined;
	const teams = config?.teams;
	if (!Array.isArray(teams)) return [];
	const disabledNames = new Set(readDisabledTeamNames(glayvinHome));
	return teams.flatMap((entry) => {
		const rawName = (entry as GlayvinTeam)?.name;
		if (typeof rawName !== "string" || !rawName.trim()) return [];
		const name = rawName.trim();
		const rawPath = (entry as GlayvinTeam)?.path;
		const path = typeof rawPath === "string" && rawPath.trim() ? rawPath : "";
		return [
			{
				name,
				path,
				absolute: Boolean(path) && isAbsolute(path),
				enabled: !disabledNames.has(name),
			},
		];
	});
}

/**
 * Teams registered in the user's Glayvin config. Relative paths are repo-relative
 * and cannot be resolved from here, so only absolute entries are returned.
 */
export function readGlayvinTeams(
	glayvinHome: string | undefined,
): GlayvinTeam[] {
	return readRegisteredTeams(glayvinHome)
		.filter((team) => team.absolute)
		.map((team) => ({ name: team.name, path: team.path }));
}

function readLocalJson(
	glayvinHome: string | undefined,
	file: string,
): unknown {
	if (!glayvinHome) return undefined;
	try {
		return JSON.parse(readFileSync(join(glayvinHome, ".local", file), "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Team names the user has switched off. The resolver filters registered teams
 * against this list (`readEnabledTeamDirs` in lib/resolver/src/layers.mjs), so a
 * disabled team stays in glayvin.json while contributing nothing.
 */
export function readDisabledTeamNames(
	glayvinHome: string | undefined,
): string[] {
	const parsed = readLocalJson(glayvinHome, "disabled.json") as
		| { teams?: unknown }
		| undefined;
	const teams = parsed?.teams;
	if (!Array.isArray(teams)) return [];
	return teams.flatMap((name) =>
		typeof name === "string" && name.trim() ? [name.trim()] : [],
	);
}

/**
 * Every registered team name, including entries `readGlayvinTeams` drops for
 * having a relative path. Those are still memberships — we just can't resolve
 * where they point — so callers can report them rather than show them as unjoined.
 */
export function readRegisteredTeamNames(
	glayvinHome: string | undefined,
): string[] {
	return readRegisteredTeams(glayvinHome).map((team) => team.name);
}
