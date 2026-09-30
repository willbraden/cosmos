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
