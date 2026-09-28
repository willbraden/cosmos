import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DesktopSettings } from "../shared/ipc";

export type RuntimePaths = Pick<
	DesktopSettings,
	"agentDirPath" | "glayvinHomePath"
>;

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
