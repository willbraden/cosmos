// Regenerates test/fixtures/*.json from the real pi binary when RECORD_FIXTURES=1.
// The fixtures pin real protocol output for the fast chat-model unit tests.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
// @ts-expect-error untyped test helper
import { startFakeLlmServer } from "../../scripts/fake-llm-server.mjs";
// @ts-expect-error untyped test helper
import { writeFakePiHome } from "../../scripts/fake-pi-home.mjs";
import { PiProcess } from "../../src/main/pi/pi-process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const electronPath = createRequire(import.meta.url)("electron") as unknown as string;
const piCli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");

it.runIf(process.env.RECORD_FIXTURES === "1")("records a tool-using conversation", async () => {
	const server = await startFakeLlmServer();
	const workDir = mkdtempSync(join(tmpdir(), "pi-fixture-work-"));
	const agentDir = writeFakePiHome(mkdtempSync(join(tmpdir(), "pi-fixture-agent-")), server.port);
	const proc = new PiProcess({
		command: electronPath,
		args: [join(root, "resources/pi-launcher.mjs"), piCli, "--mode", "rpc", "-e", join(root, "resources/pi-extension/desktop-bridge.ts")],
		cwd: workDir,
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PI_DESKTOP: "1", PI_DESKTOP_PERMISSION_MODE: "auto", PI_CODING_AGENT_DIR: agentDir },
	});
	const records: unknown[] = [];
	let settle: () => void = () => {};
	proc.on("record", (r: { type: string }) => {
		records.push(r);
		if (r.type === "agent_settled") settle();
	});
	proc.start();
	try {
		for (const message of ["hello", "write a file", "now edit it"]) {
			const settled = new Promise<void>((r) => (settle = r));
			await proc.request({ type: "prompt", message });
			await settled;
		}
		const entries = await proc.request({ type: "get_entries" });
		const scrub = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(workDir, "/work").replaceAll(agentDir, "/agent").replaceAll(root, "/repo"));
		writeFileSync(join(root, "test/fixtures/stream.json"), `${JSON.stringify(scrub(records), null, 1)}\n`);
		writeFileSync(join(root, "test/fixtures/entries.json"), `${JSON.stringify(scrub(entries), null, 1)}\n`);
		expect(records.length).toBeGreaterThan(10);
	} finally {
		await proc.stop();
		await server.close();
		rmSync(workDir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
}, 60_000);
