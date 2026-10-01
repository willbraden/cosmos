import { existsSync, readFileSync } from "node:fs";
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
 * Teams registered in the user's Glayvin config. Relative paths are repo-relative
 * and cannot be resolved from here, so only absolute entries are returned.
 */
export function readGlayvinTeams(
	glayvinHome: string | undefined,
): GlayvinTeam[] {
	if (!glayvinHome) return [];
	try {
		const raw = readFileSync(
			join(glayvinHome, ".local", "glayvin.json"),
			"utf8",
		);
		const parsed = JSON.parse(raw) as unknown;
		const teams = (parsed as { teams?: unknown })?.teams;
		if (!Array.isArray(teams)) return [];
		return teams.flatMap((entry) => {
			const name = (entry as GlayvinTeam)?.name;
			const path = (entry as GlayvinTeam)?.path;
			return typeof name === "string" &&
				name.trim() &&
				typeof path === "string" &&
				isAbsolute(path)
				? [{ name: name.trim(), path }]
				: [];
		});
	} catch {
		return [];
	}
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
	const parsed = readLocalJson(glayvinHome, "glayvin.json") as
		| { teams?: unknown }
		| undefined;
	const teams = parsed?.teams;
	if (!Array.isArray(teams)) return [];
	return teams.flatMap((entry) => {
		const name = (entry as GlayvinTeam)?.name;
		return typeof name === "string" && name.trim() ? [name.trim()] : [];
	});
}
