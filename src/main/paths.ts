import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

/** Directory holding bundled non-code resources (launcher, pi extension, Cosmos package). */
export function resourcesDir(): string {
	return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources");
}

export function launcherPath(): string {
	return join(resourcesDir(), "pi-launcher.mjs");
}

/**
 * Executable used to run pi as a child Node process.
 *
 * On macOS, spawning the main app binary with ELECTRON_RUN_AS_NODE makes Launchpad / the
 * app switcher show a visible extra "exec" app per session. Electron ships a helper
 * executable specifically for child processes; using it keeps pi in the background where
 * users expect it.
 */
export function childNodePath(): string {
	if (process.platform !== "darwin") return process.execPath;

	const helper = (process as NodeJS.Process & { helperExecPath?: string })
		.helperExecPath;
	if (helper && existsSync(helper)) return helper;

	const executable = basename(process.execPath);
	const derived = join(
		dirname(dirname(process.execPath)),
		"Frameworks",
		`${executable} Helper.app`,
		"Contents",
		"MacOS",
		`${executable} Helper`,
	);
	return existsSync(derived) ? derived : process.execPath;
}

export function bridgeExtensionPath(): string {
	return join(resourcesDir(), "pi-extension", "desktop-bridge.ts");
}

export function cosmosPackagePath(): string {
	return join(resourcesDir(), "cosmos-package");
}

/**
 * The pi CLI shipped inside the app. Packaged builds do not use asar: pi runs as a child
 * process and resolves its whole dependency tree (and jiti, for .ts extensions) from the
 * real filesystem, which an asar archive cannot provide to a child process.
 */
export function bundledPiCliPath(): string {
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	// entry: <pkg>/dist/index.js  ->  cli: <pkg>/dist/bundle/cli.js
	return join(dirname(entry), "bundle", "cli.js");
}

export function resolvePiCliPath(override: string): { path: string; bundled: boolean } {
	if (override && existsSync(override)) return { path: override, bundled: false };
	return { path: bundledPiCliPath(), bundled: true };
}
