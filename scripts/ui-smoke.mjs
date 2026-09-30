// UI smoke test: launches the built app against the fake model in an isolated pi home and
// app-data folder, drives the renderer over the Chrome DevTools Protocol, and saves
// screenshots of each step. Nothing touches the user's real ~/.pi or app settings.
//
//   npm run build && node scripts/ui-smoke.mjs <outDir>

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFakeLlmServer } from "./fake-llm-server.mjs";
import { writeFakePiHome } from "./fake-pi-home.mjs";

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(process.argv[2] ?? join(root, "ui-smoke-output"));
mkdirSync(outDir, { recursive: true });
const electron = createRequire(import.meta.url)("electron");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await startFakeLlmServer();
const base = mkdtempSync(join(tmpdir(), "cosmos-smoke-"));
const work = join(base, "demo-project");
mkdirSync(work, { recursive: true });
writeFileSync(join(work, "index.ts"), "export const answer = 42;\n");
writeFileSync(join(work, "README.md"), "# Demo\n");
const agentDir = writeFakePiHome(join(base, "agent"), server.port);
const userData = join(base, "userdata");
mkdirSync(userData, { recursive: true });
writeFileSync(join(userData, "settings.json"), JSON.stringify({ recentProjects: [work], permissionMode: "ask", theme: process.env.THEME ?? "system" }));

const port = 9333;
// APP=/path/to/Cosmos.app/Contents/MacOS/Cosmos tests a packaged build instead.
const appArgs = [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`];
const app = spawn(process.env.APP ?? electron, process.env.APP ? appArgs : [root, ...appArgs], {
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (d) => (appLog += d));
app.stderr.on("data", (d) => (appLog += d));

async function connect() {
	for (let i = 0; i < 240; i++) {
		try {
			const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
			const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools"));
			if (page) return page.webSocketDebuggerUrl;
		} catch {}
		await sleep(250);
	}
	throw new Error("App did not expose a debuggable page");
}

// Never leave an orphaned app holding the debug port if we cannot connect.
const pageUrl = await connect().catch((error) => {
	app.kill("SIGKILL");
	void server.close();
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
		pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolveMsg(msg.result)));
		ws.send(JSON.stringify({ id, method, params }));
	});

const evaluate = async (expression) => {
	const result = await Promise.race([
		send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
		sleep(10_000).then(() => {
			throw new Error(`renderer did not answer within 10s: ${expression.slice(0, 80)}`);
		}),
	]);
	if (result.exceptionDetails) throw new Error(`eval failed: ${result.exceptionDetails.text} :: ${expression}`);
	return result.result.value;
};
const waitFor = async (expression, label, timeout = 20_000) => {
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
const key = async (key, code, keyCode, modifiers = 0) => {
	for (const type of ["rawKeyDown", "keyUp"]) {
		await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, modifiers });
	}
};
const typeInComposer = async (text) => {
	await evaluate(`document.querySelector('.composer textarea').focus()`);
	await send("Input.insertText", { text });
};
const clickText = (selector, text) =>
	evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);

const failures = [];
async function step(name, fn) {
	process.stdout.write(`• ${name}\n`);
	try {
		await fn();
	} catch (error) {
		failures.push(`${name}: ${error.message}`);
		console.log(`  ✗ ${error.message}`);
		await shot(`FAIL-${name.replace(/\W+/g, "-")}`).catch(() => {});
	}
}

try {
	await send("Runtime.enable");

	await step("boots into a new session in the recent project", async () => {
		await waitFor(`!!document.querySelector('.composer textarea') && document.body.innerText.includes('Fake Model')`, "composer with model");
		await shot("01-welcome");
	});

	await step("streams a markdown reply with thinking", async () => {
		await typeInComposer("hello there");
		await key("Enter", "Enter", 13);
		await waitFor(`document.querySelectorAll('.working').length > 0`, "working indicator", 5000);
		await waitFor(`document.body.innerText.includes('Hello from the fake model') && !document.querySelector('.working')`, "reply to finish");
		await sleep(300);
		await shot("02-markdown-reply");
		if (!(await evaluate(`!!document.querySelector('.code-block') && !!document.querySelector('.md table')`))) throw new Error("code block/table not rendered");
	});

	await step("asks permission before writing a file", async () => {
		await typeInComposer("please write a file");
		await key("Enter", "Enter", 13);
		await waitFor(`!!document.querySelector('.dialog-card.permission')`, "permission card");
		await sleep(200);
		await shot("03-permission-prompt");
		await clickText(".dialog-card button", "Allow");
		await waitFor(`!document.querySelector('.working') && document.body.innerText.includes('Done.')`, "run to finish");
		if (readFileSync(join(work, "hello.txt"), "utf8").length === 0) throw new Error("file not written");
	});

	await step("denies a shell command", async () => {
		await typeInComposer("run bash please");
		await key("Enter", "Enter", 13);
		await waitFor(`!!document.querySelector('.dialog-card.permission')`, "permission card");
		await key("Escape", "Escape", 27);
		await waitFor(`!document.querySelector('.working') && document.body.innerText.includes("won't do that")`, "denied reply");
	});

	await step("accept-edits mode edits without asking; changes panel shows diffs", async () => {
		await clickText(".chip", "Ask permissions");
		await clickText(".menu-item", "Accept edits");
		await waitFor(`[...document.querySelectorAll('.chip')].some(c => c.textContent.includes('Accept edits'))`, "mode switched");
		await typeInComposer("edit the greeting");
		await key("Enter", "Enter", 13);
		await waitFor(`!document.querySelector('.working') && document.body.innerText.split('Done. The tool finished').length >= 3`, "edit run");
		if (await evaluate(`!!document.querySelector('.dialog-card')`)) throw new Error("unexpected prompt in acceptEdits");
		// Expand the edit tool card to show its diff.
		await evaluate(`[...document.querySelectorAll('.fold-header')].filter(b => b.textContent.includes('Edit'))[0]?.click()`);
		await evaluate(`document.querySelector('.main-header [title^="Changes"]').click()`);
		await waitFor(`!!document.querySelector('.changes .diff-line.add')`, "changes panel diff");
		await sleep(300);
		await shot("04-edit-and-changes-panel");
	});

	await step("slash command autocomplete and @file mentions", async () => {
		await evaluate(`document.querySelector('.changes [title="Close"]').click()`);
		await typeInComposer("/");
		await waitFor(`!!document.querySelector('[role=listbox]') && document.body.innerText.includes('/compact')`, "slash menu");
		await shot("05-slash-menu");
		await key("Escape", "Escape", 27);
		await evaluate(`(() => { const t = document.querySelector('.composer textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
		await typeInComposer("look at @ind");
		await waitFor(`!!document.querySelector('[role=listbox]') && document.querySelector('[role=listbox]').innerText.includes('index.ts')`, "file mentions");
		await shot("06-file-mention");
		await key("Enter", "Enter", 13);
		const value = await evaluate(`document.querySelector('.composer textarea').value`);
		if (value !== "look at @index.ts ") throw new Error(`mention inserted as ${JSON.stringify(value)}`);
	});

	await step("user shell command with !", async () => {
		await evaluate(`(() => { const t = document.querySelector('.composer textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
		await typeInComposer("!ls");
		await key("Enter", "Enter", 13);
		await waitFor(`[...document.querySelectorAll('.fold-header')].some(b => b.textContent.includes('$ ls') && b.textContent.includes('exit 0'))`, "bash item");
		if (!(await evaluate(`document.body.innerText.includes('README.md')`))) throw new Error("bash output missing");
	});

	await step("sidebar lists the persisted session; settings and providers open", async () => {
		await waitFor(`[...document.querySelectorAll('.session-row .title')].some(t => t.textContent.includes('hello there'))`, "session in sidebar");
		await shot("07-full-conversation");
		await evaluate(`document.querySelector('.sidebar-footer [title^="Settings"]').click()`);
		await clickText(".modal-nav .menu-item", "Providers");
		await waitFor(`document.body.innerText.toLowerCase().includes('sign in with a subscription')`, "providers pane");
		await sleep(400);
		await shot("08-providers");
		await key("Escape", "Escape", 27);
	});

	await step("new session and reopening the old one restores history", async () => {
		await evaluate(`document.querySelector('.sidebar-section-row [title^="New session in"]').click()`);
		await waitFor(`document.body.innerText.includes('What should we build')`, "fresh session");
		await clickText(".session-row", "hello there");
		await waitFor(`document.body.innerText.includes('Hello from the fake model') && document.querySelectorAll('.user-msg').length >= 4`, "history restored");
	});

	await step("light theme", async () => {
		await evaluate(`window.pi.updateSettings({ theme: 'light' })`);
		await sleep(500);
		await shot("09-light-theme");
	});
} finally {
	ws.close();
	app.kill();
	await server.close();
	writeFileSync(join(outDir, "app.log"), appLog);
	app.kill("SIGKILL");
	rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

if (failures.length) {
	console.log(`\n${failures.length} step(s) failed:\n- ${failures.join("\n- ")}`);
	process.exit(1);
}
console.log(`\nAll steps passed. Screenshots in ${outDir}`);
