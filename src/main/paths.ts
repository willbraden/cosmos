import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

/** Directory holding bundled non-code resources (launcher, pi extension). */
export function resourcesDir(): string {
	return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources");
}

export function launcherPath(): string {
	return join(resourcesDir(), "pi-launcher.mjs");
}

export function bridgeExtensionPath(): string {
	return join(resourcesDir(), "pi-extension", "desktop-bridge.ts");
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
