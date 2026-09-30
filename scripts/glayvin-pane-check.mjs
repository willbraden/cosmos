// One-off: render the Glayvin Settings pane against the real ~/.glayvin and
// screenshot it. Isolated --user-data-dir so it cannot disturb a running Cosmos.
//   node scripts/glayvin-pane-check.mjs <outDir>

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(process.argv[2] ?? join(root, "glayvin-pane-output"));
mkdirSync(outDir, { recursive: true });
const electron = createRequire(import.meta.url)("electron");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// macOS caps unix socket paths at 104 bytes, and the supervisor puts its socket
// inside this dir, so keep the path short or the app never opens a window --
// which surfaces as "no debuggable page", not as a path-length error. The
// default TMPDIR on macOS is a ~50-char /var/folders path, close enough to the
// cap to matter once a socket name is appended.
const tmpRoot = existsSync("/tmp") ? "/tmp" : tmpdir();
const userData = mkdtempSync(join(tmpRoot, "cg-"));
// Point at the real Glayvin home so the pane has something to show, but keep
// app settings and sessions in the throwaway dir.
writeFileSync(
	join(userData, "settings.json"),
	JSON.stringify({
		glayvinHomePath: join(homedir(), ".glayvin"),
		theme: process.env.THEME ?? "dark",
	}),
);

const port = 9344;
const app = spawn(
	electron,
	[root, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`],
	{ stdio: ["ignore", "pipe", "pipe"] },
);
let appLog = "";
app.stdout.on("data", (d) => (appLog += d));
app.stderr.on("data", (d) => (appLog += d));

async function connect() {
	for (let i = 0; i < 240; i++) {
		try {
			const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
			const page = targets.find(
				(t) => t.type === "page" && !t.url.startsWith("devtools"),
			);
			if (page) return page.webSocketDebuggerUrl;
		} catch {}
		await sleep(250);
	}
	throw new Error("App did not expose a debuggable page");
}

const pageUrl = await connect().catch((error) => {
	app.kill("SIGKILL");
	console.error(appLog);
	throw error;
});
const ws = new WebSocket(pageUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
	const msg = JSON.parse(e.data);
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)(msg);
		pending.delete(msg.id);
	}
});
const send = (method, params = {}) =>
	new Promise((resolveMsg, reject) => {
		const id = ++nextId;
		pending.set(id, (msg) =>
			msg.error
				? reject(new Error(`${method}: ${msg.error.message}`))
				: resolveMsg(msg.result),
		);
		ws.send(JSON.stringify({ id, method, params }));
	});
const evaluate = async (expression) => {
	// Without a timeout a renderer that never answers hangs the whole run.
	const result = await Promise.race([
		send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		}),
		sleep(10_000).then(() => {
			throw new Error(`renderer did not answer within 10s: ${expression.slice(0, 80)}`);
		}),
	]);
	if (result.exceptionDetails) {
		throw new Error(`eval failed: ${result.exceptionDetails.text}`);
	}
	return result.result.value;
};
const waitFor = async (expression, label, timeout = 25_000) => {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (await evaluate(expression).catch(() => false)) return;
		await sleep(150);
	}
	throw new Error(`Timed out waiting for ${label}`);
};
const shot = async (name) => {
	const { data } = await send("Page.captureScreenshot", { format: "png" });
	writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, "base64"));
	console.log(`  saved ${name}.png`);
};
const clickText = (selector, text) =>
	evaluate(
		`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`,
	);

const failures = [];
try {
	await send("Runtime.enable");
	await waitFor(`document.readyState === 'complete'`, "renderer load");
	await sleep(1200);

	await evaluate(
		`document.querySelector('[title^="Settings"]')?.click() ?? false`,
	);
	await waitFor(`!!document.querySelector('[aria-label="Settings"]')`, "settings modal");

	if (!(await clickText(".modal-nav .menu-item", "Glayvin"))) {
		throw new Error("no Glayvin item in the settings nav");
	}
	await sleep(1800);
	await shot("glayvin-pane");

	const text = await evaluate(
		`document.querySelector('.modal-content')?.innerText ?? ''`,
	);
	writeFileSync(join(outDir, "glayvin-pane.txt"), text);
	console.log(`\n--- pane text (${text.length} chars) ---\n${text}\n---`);

	for (const [label, needle] of [
		["a profile name", /profile/i],
		["pack listing", /pack/i],
		["team listing", /team/i],
	]) {
		if (!needle.test(text)) failures.push(`pane text is missing ${label}`);
	}
	if (text.trim().length < 40) failures.push("pane rendered essentially empty");
	if (/undefined|NaN|\[object Object\]/.test(text)) {
		failures.push("pane shows a raw JS value (undefined/NaN/[object Object])");
	}
	if (/\b1 (packages|extensions|skills|commands|hooks)\b/.test(text)) {
		failures.push("pack counts are not singularised at 1");
	}
} catch (error) {
	failures.push(error.message);
	await shot("FAIL-glayvin-pane").catch(() => {});
} finally {
	ws.close();
	app.kill("SIGKILL");
	await sleep(400);
}

if (failures.length) {
	console.error(`\n✗ ${failures.length} problem(s):`);
	for (const f of failures) console.error(`  - ${f}`);
	console.error(`\napp log tail:\n${appLog.slice(-2000)}`);
	process.exit(1);
}
console.log("\n✓ Glayvin pane rendered with profile, pack, and team content");
// The CDP socket and the spawned app leave handles behind; exit rather than hang.
process.exit(0);
