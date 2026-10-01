import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { runtimeLog as log } from "./runtime-log";

const START = "__PI_DESKTOP_ENV_START__";
const END = "__PI_DESKTOP_ENV_END__";
const TIMEOUT_MS = 8000;

// Variables that describe the GUI launch itself and must not leak from the shell probe.
const SKIP = new Set(["_", "SHLVL", "PWD", "OLDPWD"]);

let cached: Promise<NodeJS.ProcessEnv> | null = null;

/**
 * Apps launched from Finder/Dock on macOS get a minimal environment (PATH lacks Homebrew,
 * nvm, etc). Pi's bash tool needs the user's real shell environment, so resolve it once
 * from an interactive login shell, the same way terminals do.
 */
export function resolveShellEnv(): Promise<NodeJS.ProcessEnv> {
	cached ??= probe().catch((error) => {
		log.warn("Could not resolve login shell environment; using process env", error);
		return { ...process.env };
	});
	return cached;
}

export function parseEnvOutput(output: string): NodeJS.ProcessEnv {
	const start = output.indexOf(START);
	const end = output.indexOf(END, start);
	if (start === -1 || end === -1) throw new Error("Shell environment markers not found");
	const env: NodeJS.ProcessEnv = {};
	for (const pair of output.slice(start + START.length, end).split("\0")) {
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const key = pair.slice(0, eq).replace(/^\n+/, "");
		if (!SKIP.has(key)) env[key] = pair.slice(eq + 1);
	}
	return env;
}

async function probe(): Promise<NodeJS.ProcessEnv> {
	if (process.platform === "win32") return { ...process.env };
	const shell = process.env.SHELL || userInfo().shell || "/bin/zsh";
	const output = await new Promise<string>((resolve, reject) => {
		execFile(
			shell,
			["-ilc", `printf '${START}'; env -0; printf '${END}'`],
			{
				timeout: TIMEOUT_MS,
				maxBuffer: 10 * 1024 * 1024,
				// Keep oh-my-zsh style auto-updaters and tmux auto-attach out of the probe.
				env: { ...process.env, DISABLE_AUTO_UPDATE: "true", ZSH_TMUX_AUTOSTARTED: "true" },
			},
			(error, stdout) => (error && !stdout.includes(END) ? reject(error) : resolve(stdout)),
		);
	});
	const env = { ...process.env, ...parseEnvOutput(output) };
	log.info(`Resolved login shell environment from ${shell}`);
	return env;
}
