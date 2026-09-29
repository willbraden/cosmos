import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, shell: {} }));
vi.mock("electron-log/main", () => ({
	default: { info() {}, warn() {}, error() {}, debug() {} },
}));

import * as bridge from "../resources/pi-extension/desktop-bridge";
import { fuzzyScore } from "../src/main/files";
import {
	inferGlayvinHomeFromAgentDir,
	resolveGlayvinHomePath,
} from "../src/main/glayvin-runtime";
import {
	buildFigmaPiAuthEntry,
	piOauthTokensPath,
	readXcodeFigmaBearerToken,
	resetFigmaAuth,
	writeLegacyPiOauthEntry,
} from "../src/main/figma-xcode-auth";
import {
	getMcpOverview,
	removePersonalMcpServer,
	upsertPersonalMcpServer,
} from "../src/main/mcp-config";
import { extractReportedActiveTools } from "../src/main/mcp-session-availability";
import { encodeJsonl, JsonlDecoder } from "../src/main/pi/jsonl";
import { sanitizeSettingsPatch } from "../src/main/settings";
import { parseEnvOutput } from "../src/main/shell-env";
import { supervisorBuildId } from "../src/main/supervisor-identity";
import {
	PERMISSION_MODE_COMMAND,
	PERMISSION_OPTIONS,
	PERMISSION_PROMPT_MARKER,
	permissionNeedsApproval,
} from "../src/shared/pi-types";

describe("JsonlDecoder", () => {
	function decode(chunks: (string | Buffer)[]) {
		const records: unknown[] = [];
		const invalid: string[] = [];
		const decoder = new JsonlDecoder(
			(r) => records.push(r),
			(line) => invalid.push(line),
		);
		for (const chunk of chunks) decoder.push(chunk);
		decoder.end();
		return { records, invalid };
	}

	it("splits only on LF, keeping U+2028/U+2029 inside strings", () => {
		const text = "a\u2028b\u2029c";
		const { records } = decode([encodeJsonl({ text }), encodeJsonl({ n: 2 })]);
		expect(records).toEqual([{ text }, { n: 2 }]);
	});

	it("reassembles records and multi-byte characters split across chunks", () => {
		const bytes = Buffer.from(encodeJsonl({ emoji: "héllo 👋" }));
		const { records } = decode([
			bytes.subarray(0, 13),
			bytes.subarray(13, 15),
			bytes.subarray(15),
		]);
		expect(records).toEqual([{ emoji: "héllo 👋" }]);
	});

	it("accepts CRLF and a final unterminated record", () => {
		expect(decode(['{"a":1}\r\n{"b":2}']).records).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("reports malformed lines without stopping", () => {
		const { records, invalid } = decode(['{"a":1}\nnot json\n{"b":2}\n']);
		expect(records).toEqual([{ a: 1 }, { b: 2 }]);
		expect(invalid).toEqual(["not json"]);
	});
});

describe("desktop bridge extension", () => {
	it("shares its protocol constants with the renderer", () => {
		expect(bridge.PERMISSION_PROMPT_MARKER).toBe(PERMISSION_PROMPT_MARKER);
		expect(bridge.OPTIONS).toEqual(PERMISSION_OPTIONS);
	});

	it("classifies tools and applies permission modes", () => {
		const none = new Set<string>();
		expect(bridge.needsApproval("ask", "read", none)).toBe(false);
		expect(bridge.needsApproval("ask", "edit", none)).toBe(true);
		expect(bridge.needsApproval("ask", "bash", none)).toBe(true);
		expect(bridge.needsApproval("acceptEdits", "write", none)).toBe(false);
		expect(bridge.needsApproval("acceptEdits", "bash", none)).toBe(true);
		expect(bridge.needsApproval("acceptEdits", "some_extension_tool", none)).toBe(
			true,
		);
		expect(bridge.needsApproval("auto", "bash", none)).toBe(false);
		expect(bridge.needsApproval("ask", "bash", new Set(["bash"]))).toBe(false);
	});

	it("parses modes strictly", () => {
		expect(bridge.parseMode(" auto ")).toBe("auto");
		expect(bridge.parseMode("yolo")).toBeUndefined();
		expect(bridge.parseMode(undefined)).toBeUndefined();
	});

	it("registers the slash command the host uses for live mode switches", () => {
		const previous = process.env.PI_DESKTOP;
		process.env.PI_DESKTOP = "1";
		const commands = new Map<string, { handler(args: string): Promise<void> }>();
		try {
			bridge.default({
				registerCommand: (name: string, spec: unknown) =>
					commands.set(name, spec as { handler(args: string): Promise<void> }),
				on: () => {},
			} as never);
		} finally {
			if (previous === undefined) delete process.env.PI_DESKTOP;
			else process.env.PI_DESKTOP = previous;
		}
		expect([...commands.keys()]).toContain(PERMISSION_MODE_COMMAND);
	});

	it("agrees with the shared approval mirror the renderer uses", () => {
		const none = new Set<string>();
		for (const mode of ["ask", "acceptEdits", "auto"] as const)
			for (const tool of ["read", "grep", "edit", "write", "bash", "mcp_thing"])
				expect(permissionNeedsApproval(mode, tool)).toBe(
					bridge.needsApproval(mode, tool, none),
				);
	});
});

describe("glayvin runtime detection", () => {
	it("infers GLAYVIN_HOME from a glayvin-style agent dir", () => {
		expect(
			inferGlayvinHomeFromAgentDir("/Users/test/.glayvin/.pi/agent"),
		).toBe("/Users/test/.glayvin");
		expect(inferGlayvinHomeFromAgentDir("/tmp/custom-agent")).toBeUndefined();
	});

	it("falls back to the inherited or detected home when settings are empty", () => {
		expect(
			resolveGlayvinHomePath(
				{ agentDirPath: "", glayvinHomePath: "" },
				"/Users/test/.glayvin",
			),
		).toBe("/Users/test/.glayvin");
	});

	it("prefers an explicit override, then an inferred home from the agent dir", () => {
		expect(
			resolveGlayvinHomePath(
				{
					agentDirPath: "/Users/test/.glayvin/.pi/agent",
					glayvinHomePath: "",
				},
				"/fallback/.glayvin",
			),
		).toBe("/Users/test/.glayvin");
		expect(
			resolveGlayvinHomePath(
				{ agentDirPath: "", glayvinHomePath: "/override/.glayvin" },
				"/fallback/.glayvin",
			),
		).toBe("/override/.glayvin");
	});
});

describe("mcp config helpers", () => {
	it("lists active and personal servers and writes personal overrides", async () => {
		const root = mkdtempSync(join(tmpdir(), "cosmos-mcp-"));
		const glayvinHome = join(root, ".glayvin");
		const agentDir = join(glayvinHome, ".pi", "agent");
		mkdirSync(join(glayvinHome, ".local"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(glayvinHome, ".local", "mcp-config.merged.json"),
			JSON.stringify({
				mcpServers: {
					figma: {
						type: "http",
						url: "https://mcp.figma.com/mcp",
						auth: "oauth",
						tools: ["whoami"],
					},
				},
			}),
		);
		writeFileSync(
			join(glayvinHome, ".local", "mcp-config.json"),
			JSON.stringify({
				mcpServers: {
					graphos: { command: "npx", args: ["graphos-mcp"] },
				},
			}),
		);

		const overview = await getMcpOverview(glayvinHome, agentDir);
		expect(overview.available).toBe(true);
		expect(overview.servers.map((server) => server.name)).toEqual([
			"figma",
			"graphos",
		]);
		expect(overview.servers.find((server) => server.name === "figma")).toMatchObject({
			active: true,
			personal: false,
			auth: "oauth",
		});
		expect(overview.servers.find((server) => server.name === "graphos")).toMatchObject({
			active: false,
			personal: true,
			transport: "command",
		});

		upsertPersonalMcpServer(glayvinHome, "clickup", {
			type: "http",
			url: "https://mcp.clickup.com/mcp",
			tools: ["*"],
		});
		const written = JSON.parse(
			readFileSync(join(glayvinHome, ".local", "mcp-config.json"), "utf8"),
		) as { mcpServers: Record<string, unknown> };
		expect(Object.keys(written.mcpServers).sort()).toEqual([
			"clickup",
			"graphos",
		]);

		removePersonalMcpServer(glayvinHome, "graphos");
		const afterRemove = await getMcpOverview(glayvinHome, agentDir);
		expect(afterRemove.servers.map((server) => server.name)).toEqual([
			"clickup",
			"figma",
		]);
	});
});

describe("mcp config helpers", () => {
	it("reads merged and personal MCP servers and flags pending personal entries", async () => {
		const root = mkdtempSync(join(tmpdir(), "cosmos-mcp-"));
		const glayvinHome = join(root, ".glayvin");
		const agentDir = join(glayvinHome, ".pi", "agent");
		mkdirSync(join(glayvinHome, ".local"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(glayvinHome, ".local", "mcp-config.merged.json"),
			JSON.stringify({
				mcpServers: {
					figma: {
						type: "http",
						url: "https://mcp.figma.com/mcp",
						auth: "oauth",
						tools: ["whoami"],
					},
				},
			}),
		);
		writeFileSync(
			join(glayvinHome, ".local", "mcp-config.json"),
			JSON.stringify({
				mcpServers: {
					figma: {
						type: "http",
						url: "https://mcp.figma.com/mcp",
						auth: "oauth",
						tools: ["whoami"],
					},
					localdemo: {
						command: "npx",
						args: ["-y", "demo-mcp"],
					},
				},
			}),
		);

		const overview = await getMcpOverview(glayvinHome, agentDir);
		expect(overview.available).toBe(true);
		expect(overview.servers.map((server) => server.name)).toEqual([
			"figma",
			"localdemo",
		]);
		expect(overview.servers.find((server) => server.name === "figma")).toMatchObject({
			active: true,
			personal: true,
			auth: "oauth",
		});
		expect(
			overview.servers.find((server) => server.name === "localdemo"),
		).toMatchObject({
			active: false,
			personal: true,
			transport: "command",
		});
		expect(overview.notes.some((note) => note.includes("not active"))).toBe(true);
	});

	it("writes and removes personal MCP servers", async () => {
		const root = mkdtempSync(join(tmpdir(), "cosmos-mcp-write-"));
		const glayvinHome = join(root, ".glayvin");
		mkdirSync(join(glayvinHome, ".local"), { recursive: true });

		upsertPersonalMcpServer(glayvinHome, "test-server", {
			command: "npx",
			args: ["-y", "test-mcp"],
		});
		let overview = await getMcpOverview(glayvinHome, join(glayvinHome, ".pi", "agent"));
		expect(overview.servers.find((server) => server.name === "test-server")).toMatchObject({
			personal: true,
			active: false,
		});

		removePersonalMcpServer(glayvinHome, "test-server");
		overview = await getMcpOverview(glayvinHome, join(glayvinHome, ".pi", "agent"));
		expect(overview.servers.find((server) => server.name === "test-server")).toBeUndefined();
	});
});

describe("mcp session availability", () => {
	it("extracts reported active tools from a hidden custom message", () => {
		expect(
			extractReportedActiveTools([
				{
					type: "custom_message",
					id: "1",
					parentId: null,
					timestamp: "",
					customType: "desktop-active-tools",
					details: { tools: ["read", "get_screenshot"] },
				},
			] as never),
		).toEqual(["read", "get_screenshot"]);
	});
});

describe("figma xcode auth helpers", () => {
	it("reads the Xcode bearer token and writes a legacy Pi auth file", () => {
		const root = mkdtempSync(join(tmpdir(), "cosmos-figma-auth-"));
		const xcodeConfig = join(root, "mcp-servers.json");
		const agentDir = join(root, ".pi", "agent");
		const token = "figu_test_token";
		writeFileSync(
			xcodeConfig,
			JSON.stringify({
				mcpServers: {
					figma: {
						headers: {
							Authorization: `Bearer ${token}`,
						},
					},
				},
			}),
		);
		expect(readXcodeFigmaBearerToken(xcodeConfig)).toBe(token);

		const entry = buildFigmaPiAuthEntry(token);
		const path = piOauthTokensPath(agentDir);
		writeLegacyPiOauthEntry(path, entry);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(entry);
	});

	it("resets the saved Pi Figma auth state", async () => {
		const root = mkdtempSync(join(tmpdir(), "cosmos-figma-reset-"));
		const agentDir = join(root, ".pi", "agent");
		const path = piOauthTokensPath(agentDir);
		writeLegacyPiOauthEntry(path, buildFigmaPiAuthEntry("figu_test_token"));
		mkdirSync(join(agentDir, "mcp-oauth", "figma"), { recursive: true });
		const result = await resetFigmaAuth(agentDir);
		expect(result.removed).toBe(true);
		expect(result.status.piOAuthConnected).toBe(false);
	});
});

describe("settings validation", () => {
	it("drops unknown keys and wrongly typed values", () => {
		expect(
			sanitizeSettingsPatch({
				theme: "neon",
				permissionMode: "auto",
				notifications: "yes",
				idleSuspendMinutes: 99999,
				piCliPath: "relative/path.js",
				agentDirPath: "/custom/pi-agent",
				glayvinHomePath: "relative/glayvin",
				pinnedSessions: ["/a.jsonl", "b.jsonl", "/a.jsonl"],
				evil: true,
			}),
		).toEqual({
			permissionMode: "auto",
			idleSuspendMinutes: 1440,
			agentDirPath: "/custom/pi-agent",
			pinnedSessions: ["/a.jsonl"],
		});
	});

	it("ignores non-objects", () => {
		expect(sanitizeSettingsPatch(null)).toEqual({});
		expect(sanitizeSettingsPatch("theme=dark")).toEqual({});
	});
});

describe("shell environment parsing", () => {
	it("extracts NUL-separated variables between markers, ignoring shell noise", () => {
		const output =
			"Welcome banner\n__PI_DESKTOP_ENV_START__PATH=/opt/homebrew/bin:/usr/bin\0MULTI=line1\nline2\0SHLVL=2\0__PI_DESKTOP_ENV_END__";
		expect(parseEnvOutput(output)).toEqual({
			PATH: "/opt/homebrew/bin:/usr/bin",
			MULTI: "line1\nline2",
		});
	});

	it("throws when the markers are missing", () => {
		expect(() => parseEnvOutput("nothing here")).toThrow();
	});
});

describe("fuzzy file matching", () => {
	it("ranks file-name matches above deep path matches", () => {
		const a = fuzzyScore("src/components/button.tsx", "button") ?? -Infinity;
		const b = fuzzyScore("docs/big/unrelated/tree/notes.md", "button");
		expect(b).toBeNull();
		const c = fuzzyScore("b/u/t/t/o/n/index.ts", "button") ?? -Infinity;
		expect(a).toBeGreaterThan(c);
	});
});

describe("supervisor build id", () => {
	it("tracks the chunks the entry imports and ignores unrelated siblings", () => {
		const dir = mkdtempSync(join(tmpdir(), "cosmos-build-"));
		mkdirSync(join(dir, "chunks"));
		const entry = join(dir, "session-supervisor.js");
		const chunk = join(dir, "chunks", "shared-abc123.js");
		writeFileSync(entry, 'import { a } from "./chunks/shared-abc123.js";\nconsole.log(a);\n');
		writeFileSync(chunk, "export const a = 1;\n");
		writeFileSync(join(dir, "index.js"), "console.log('unrelated');\n");

		const first = supervisorBuildId(entry);
		expect(supervisorBuildId(entry)).toBe(first);

		// The main-process bundle is not part of the supervisor's graph.
		writeFileSync(join(dir, "index.js"), "console.log('unrelated, but changed');\n");
		expect(supervisorBuildId(entry)).toBe(first);

		writeFileSync(chunk, "export const a = 2;\n");
		expect(supervisorBuildId(entry)).not.toBe(first);
	});
});
