// Runs the pi CLI inside Electron's embedded Node.
//
// Electron needs ELECTRON_RUN_AS_NODE=1 to behave as Node, but that variable must not
// leak into commands pi runs for the user (it would turn any Electron app they launch,
// e.g. VS Code, into a bare Node process). Remove it before pi starts, then hand over.
//
// Usage: <electron> pi-launcher.mjs <path/to/pi/cli.js> [pi args...]
import { pathToFileURL } from "node:url";

delete process.env.ELECTRON_RUN_AS_NODE;
const cliPath = process.argv[2];
if (!cliPath) {
	process.stderr.write("pi-launcher: missing pi CLI path\n");
	process.exit(2);
}
process.argv.splice(1, 2, cliPath);
await import(pathToFileURL(cliPath).href);
