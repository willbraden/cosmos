// End-to-end: the real pi CLI, launched exactly as the app launches it (Electron as Node,
// through the launcher, with the bridge extension), against the scripted fake model.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error untyped test helper
import { startFakeLlmServer } from "../../scripts/fake-llm-server.mjs";
// @ts-expect-error untyped test helper
import { writeFakePiHome } from "../../scripts/fake-pi-home.mjs";
import { PiProcess } from "../../src/main/pi/pi-process";
import { PERMISSION_OPTIONS, PERMISSION_PROMPT_MARKER, type PiRecord } from "../../src/shared/pi-types";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const electronPath = require("electron") as unknown as string;
const childPath = process.platform !== "darwin"
	? electronPath
	: join(
		dirname(dirname(electronPath)),
		"Frameworks",
		`${basename(electronPath)} Helper.app`,
		"Contents",
		"MacOS",
		`${basename(electronPath)} Helper`,
	);
const piCli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");

let server: { port: number; requests: unknown[]; close(): Promise<void> };
let workDir: string;
let agentDir: string;

function launch(permissionMode: string, extraArgs: string[] = []): PiProcess {
	const proc = new PiProcess({
		command: childPath,
		args: [
			join(root, "resources/pi-launcher.mjs"),
			piCli,
			"--mode",
			"rpc",
			"-e",
			join(root, "resources/pi-extension/desktop-bridge.ts"),
			...extraArgs,
		],
		cwd: workDir,
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			PI_DESKTOP: "1",
			PI_DESKTOP_PERMISSION_MODE: permissionMode,
			PI_CODING_AGENT_DIR: agentDir,
		},
	});
	proc.start();
	return proc;
}

function collect(proc: PiProcess) {
	const records: PiRecord[] = [];
	const waiters: { match: (r: PiRecord) => boolean; resolve: (r: PiRecord) => void }[] = [];
	proc.on("record", (record: PiRecord) => {
		records.push(record);
		for (const waiter of [...waiters]) {
			if (waiter.match(record)) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve(record);
			}
		}
	});
	return {
		records,
		next(match: (r: PiRecord) => boolean, timeoutMs = 30_000): Promise<PiRecord> {
			const existing = records.find(match);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Timed out waiting for record")), timeoutMs);
				waiters.push({
					match,
					resolve: (r) => {
						clearTimeout(timer);
						resolve(r);
					},
				});
			});
		},
	};
}

beforeAll(async () => {
	server = await startFakeLlmServer();
	workDir = mkdtempSync(join(tmpdir(), "pi-desktop-e2e-work-"));
	agentDir = writeFakePiHome(mkdtempSync(join(tmpdir(), "pi-desktop-e2e-agent-")), server.port);
});

afterAll(async () => {
	await server?.close();
	rmSync(workDir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

describe("pi RPC through the desktop launcher", () => {
	it("launcher strips ELECTRON_RUN_AS_NODE before pi's tools run", async () => {
		const proc = launch("auto");
		try {
			const result = await proc.request<{ output: string }>({ type: "bash", command: "echo \"[${ELECTRON_RUN_AS_NODE:-unset}]\"" });
			expect(result.output.trim()).toBe("[unset]");
		} finally {
			await proc.stop();
		}
	}, 60_000);

	it("streams a markdown reply with thinking from the configured model", async () => {
		const proc = launch("ask");
		const events = collect(proc);
		try {
			const models = await proc.request<{ models: { id: string }[] }>({ type: "get_available_models" });
			expect(models.models.map((m) => m.id)).toContain("fake-model");

			await proc.request({ type: "prompt", message: "hello there" });
			await events.next((r) => r.type === "agent_settled");

			const deltas = events.records.filter((r) => r.type === "message_update");
			expect(deltas.length).toBeGreaterThan(5);
			const final = events.records.filter((r) => r.type === "message_end").at(-1) as Extract<PiRecord, { type: "message_end" }>;
			expect(final.message.role).toBe("assistant");
			const content = (final.message as { content: { type: string; text?: string; thinking?: string }[] }).content;
			expect(content.some((c) => c.type === "thinking" && c.thinking?.includes("markdown"))).toBe(true);
			expect(content.some((c) => c.type === "text" && c.text?.includes("Hello from the fake model"))).toBe(true);

			const state = await proc.request<{ sessionFile?: string; messageCount: number }>({ type: "get_state" });
			expect(state.sessionFile && existsSync(state.sessionFile)).toBe(true);
			const entries = await proc.request<{ entries: { id: string }[]; leafId: string }>({ type: "get_entries" });
			expect(entries.leafId).toBe(entries.entries.at(-1)?.id);
		} finally {
			await proc.stop();
		}
	}, 60_000);

	it("asks permission before write in ask mode and runs the tool when allowed", async () => {
		const proc = launch("ask");
		const events = collect(proc);
		try {
			await proc.request({ type: "prompt", message: "please write a file" });
			const request = (await events.next(
				(r) => r.type === "extension_ui_request" && "title" in r && r.title.startsWith(PERMISSION_PROMPT_MARKER),
			)) as Extract<PiRecord, { type: "extension_ui_request"; method: "select" }>;
			const payload = JSON.parse(request.title.slice(PERMISSION_PROMPT_MARKER.length));
			expect(payload.toolName).toBe("write");
			expect(payload.args.path).toBe("hello.txt");
			expect(request.options).toEqual(Object.values(PERMISSION_OPTIONS));

			proc.send({ type: "extension_ui_response", id: request.id, value: PERMISSION_OPTIONS.allow });
			const end = (await events.next((r) => r.type === "tool_execution_end")) as Extract<PiRecord, { type: "tool_execution_end" }>;
			expect(end.isError).toBe(false);
			await events.next((r) => r.type === "agent_settled");
			expect(readFileSync(join(workDir, "hello.txt"), "utf8")).toContain("Hello from Pi Desktop");
		} finally {
			await proc.stop();
		}
	}, 60_000);

	it("blocks the tool when the user denies, and acceptEdits skips the prompt for edits", async () => {
		const denied = launch("ask");
		const deniedEvents = collect(denied);
		try {
			await denied.request({ type: "prompt", message: "run bash please" });
			const request = (await deniedEvents.next(
				(r) =>
					r.type === "extension_ui_request" &&
					"title" in r &&
					r.title.startsWith(PERMISSION_PROMPT_MARKER),
			)) as { id: string };
			denied.send({ type: "extension_ui_response", id: request.id, value: PERMISSION_OPTIONS.deny });
			const end = (await deniedEvents.next((r) => r.type === "tool_execution_end")) as Extract<PiRecord, { type: "tool_execution_end" }>;
			expect(end.isError).toBe(true);
			await deniedEvents.next((r) => r.type === "agent_settled");
		} finally {
			await denied.stop();
		}

		const edits = launch("acceptEdits");
		const editEvents = collect(edits);
		try {
			await edits.request({ type: "prompt", message: "edit the greeting" });
			const end = (await editEvents.next((r) => r.type === "tool_execution_end")) as Extract<PiRecord, { type: "tool_execution_end" }>;
			expect(end.isError).toBe(false);
			expect((end.result.details as { patch?: string }).patch).toContain("+Howdy");
			expect(
				editEvents.records.some(
					(r) =>
						r.type === "extension_ui_request" &&
						"title" in r &&
						r.title.startsWith(PERMISSION_PROMPT_MARKER),
				),
			).toBe(false);
			await editEvents.next((r) => r.type === "agent_settled");
		} finally {
			await edits.stop();
		}
	}, 90_000);

	it("switches permission mode at runtime via the bridge command without adding messages", async () => {
		const proc = launch("ask");
		const events = collect(proc);
		try {
			await proc.request({ type: "prompt", message: "/desktop-permission-mode auto" });
			const before = await proc.request<{ messages: unknown[] }>({ type: "get_messages" });
			expect(before.messages).toHaveLength(0);
			await proc.request({ type: "prompt", message: "run bash please" });
			await events.next((r) => r.type === "agent_settled");
			expect(
				events.records.some(
					(r) =>
						r.type === "extension_ui_request" &&
						"title" in r &&
						r.title.startsWith(PERMISSION_PROMPT_MARKER),
				),
			).toBe(false);
			const end = events.records.find((r) => r.type === "tool_execution_end") as Extract<PiRecord, { type: "tool_execution_end" }>;
			expect(end.isError).toBe(false);
		} finally {
			await proc.stop();
		}
	}, 60_000);

	it("rewinds to an earlier user message in the same session file so it can be re-sent edited", async () => {
		const proc = launch("auto");
		const events = collect(proc);
		const settles = () =>
			events.records.filter((r) => r.type === "agent_settled").length;
		const waitForSettle = async (count: number) => {
			const deadline = Date.now() + 30_000;
			while (settles() < count) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for settle");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		};
		try {
			await proc.request({ type: "prompt", message: "hello there" });
			await waitForSettle(1);
			const sessionFile = (
				await proc.request<{ sessionFile: string }>({ type: "get_state" })
			).sessionFile;
			const afterFirst = await proc.request<{
				entries: { id: string; type: string; message?: { role: string } }[];
			}>({ type: "get_entries" });
			const firstUserEntry = afterFirst.entries.find(
				(entry) => entry.type === "message" && entry.message?.role === "user",
			);
			expect(firstUserEntry).toBeDefined();

			await proc.request({ type: "prompt", message: "hello again" });
			await waitForSettle(2);
			expect(
				(
					await proc.request<{ messages: { role: string }[] }>({
						type: "get_messages",
					})
				).messages.map((m) => m.role),
			).toEqual(["system", "user", "assistant", "user", "assistant"]);

			await proc.request({
				type: "prompt",
				message: `/desktop-rewind ${firstUserEntry?.id}`,
			});

			// Same session file: the rewind branches inside the tree rather than forking out,
			// which is what keeps the edit inside the current desktop session.
			expect(
				(await proc.request<{ sessionFile: string }>({ type: "get_state" }))
					.sessionFile,
			).toBe(sessionFile);
			// The edited message and everything after it are off the active branch.
			expect(
				(
					await proc.request<{ messages: { role: string }[] }>({
						type: "get_messages",
					})
				).messages.map((m) => m.role),
			).toEqual(["system"]);
			const rewound = await proc.request<{
				entries: { id: string }[];
				leafId: string | null;
			}>({ type: "get_entries" });
			expect(rewound.leafId).not.toBe(firstUserEntry?.id);
			// The abandoned branch is still recorded in the same file.
			expect(
				rewound.entries.some((entry) => entry.id === firstUserEntry?.id),
			).toBe(true);
		} finally {
			await proc.stop();
		}
	}, 90_000);

	it("resumes an existing session file with --session", async () => {
		const first = launch("auto");
		let sessionFile = "";
		const events = collect(first);
		try {
			await first.request({ type: "prompt", message: "hello again" });
			await events.next((r) => r.type === "agent_settled");
			sessionFile = (await first.request<{ sessionFile: string }>({ type: "get_state" })).sessionFile;
		} finally {
			await first.stop();
		}
		const resumed = launch("auto", ["--session", sessionFile]);
		try {
			const messages = await resumed.request<{ messages: { role: string }[] }>({ type: "get_messages" });
			expect(messages.messages.filter((m) => m.role === "user")).toHaveLength(1);
		} finally {
			await resumed.stop();
		}
	}, 60_000);
});
