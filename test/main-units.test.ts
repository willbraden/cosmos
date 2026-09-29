import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
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
import {
	assertWorkspaceEntryName,
	cloneWorkspaceRepo,
	coreRepoCloneUrl,
	inspectWorkspace,
	linkWorkspaceRepo,
	unlinkWorkspaceRepo,
} from "../src/main/workspace";
import {
	PERMISSION_OPTIONS,
	PERMISSION_PROMPT_MARKER,
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

describe("workspace repos", () => {
	function workspace(): string {
		return mkdtempSync(join(tmpdir(), "cosmos-workspace-"));
	}

	it("builds core clone URLs from the default org and a valid override", () => {
		expect(coreRepoCloneUrl("nebula")).toBe("git@github.com:shipt/nebula.git");
		expect(coreRepoCloneUrl("nebula", "acme-co")).toBe(
			"git@github.com:acme-co/nebula.git",
		);
		// Junk orgs fall back rather than producing a broken or injected URL.
		expect(coreRepoCloneUrl("nebula", "bad org/../x")).toBe(
			"git@github.com:shipt/nebula.git",
		);
	});

	it("rejects entry names that escape the workspace root", () => {
		for (const name of ["..", ".", "a/b", "../evil", ".hidden", "  ", "a\u0000b"]) {
			expect(() => assertWorkspaceEntryName(name)).toThrow();
		}
		expect(assertWorkspaceEntryName("  cosmos-ai ")).toBe("cosmos-ai");
	});

	it("reports symlinked checkouts as linked, ready repos", () => {
		const root = workspace();
		const external = mkdtempSync(join(tmpdir(), "cosmos-external-"));
		mkdirSync(join(external, ".git"), { recursive: true });

		linkWorkspaceRepo({ rootPath: root, name: "nebula", targetPath: external });
		const health = inspectWorkspace(root);
		const nebula = health.repos.find((repo) => repo.name === "nebula");

		expect(nebula?.isSymlink).toBe(true);
		expect(nebula?.linkTarget).toBe(external);
		expect(nebula?.isGitRepo).toBe(true);
		expect(health.readyRepos).toBe(1);
	});

	it("refuses to link over an existing entry or from inside the workspace", () => {
		const root = workspace();
		const external = mkdtempSync(join(tmpdir(), "cosmos-external-"));
		const inside = join(root, "already-here");
		mkdirSync(inside, { recursive: true });

		expect(() =>
			linkWorkspaceRepo({ rootPath: root, name: "already-here", targetPath: external }),
		).toThrow(/already exists/);
		expect(() =>
			linkWorkspaceRepo({ rootPath: root, name: "nebula", targetPath: inside }),
		).toThrow(/already inside/);
		expect(() =>
			linkWorkspaceRepo({ rootPath: root, name: "nebula", targetPath: join(external, "nope") }),
		).toThrow(/not a folder/);
	});

	it("unlinks symlinks but never deletes a real folder", () => {
		const root = workspace();
		const external = mkdtempSync(join(tmpdir(), "cosmos-external-"));
		writeFileSync(join(external, "keep.txt"), "keep me");
		linkWorkspaceRepo({ rootPath: root, name: "nebula", targetPath: external });
		mkdirSync(join(root, "real-thing"), { recursive: true });

		unlinkWorkspaceRepo(root, "nebula");
		expect(existsSync(join(root, "nebula"))).toBe(false);
		expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("keep me");

		expect(() => unlinkWorkspaceRepo(root, "real-thing")).toThrow(/real folder/);
		expect(existsSync(join(root, "real-thing"))).toBe(true);
	});

	it("clones a repo into the workspace root and streams progress", async () => {
		const root = workspace();
		const origin = mkdtempSync(join(tmpdir(), "cosmos-origin-"));
		execFileSync("git", ["init", "--quiet", "--initial-branch=main", origin]);
		writeFileSync(join(origin, "README.md"), "# nebula\n");
		const gitEnv = {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		};
		execFileSync("git", ["-C", origin, "add", "."], { env: gitEnv });
		execFileSync("git", ["-C", origin, "commit", "--quiet", "-m", "init"], {
			env: gitEnv,
		});

		const progress: string[] = [];
		const target = await cloneWorkspaceRepo({
			rootPath: root,
			name: "nebula",
			url: `file://${origin}`,
			onProgress: (message) => progress.push(message),
		});

		expect(target).toBe(join(root, "nebula"));
		expect(readFileSync(join(target, "README.md"), "utf8")).toBe("# nebula\n");
		expect(inspectWorkspace(root).readyRepos).toBe(1);
		expect(progress.length).toBeGreaterThan(0);
		// Staging directories must not survive a successful clone.
		expect(readdirSync(root)).toEqual(["nebula"]);
	});

	it("leaves no directory behind when a clone fails", async () => {
		const root = workspace();
		await expect(
			cloneWorkspaceRepo({
				rootPath: root,
				name: "nebula",
				url: `file://${join(tmpdir(), "cosmos-missing-origin")}`,
			}),
		).rejects.toThrow();
		expect(existsSync(join(root, "nebula"))).toBe(false);
		expect(readdirSync(root)).toEqual([]);
	});

	it("rejects clone URLs that are not recognised git transports", async () => {
		const root = workspace();
		await expect(
			cloneWorkspaceRepo({
				rootPath: root,
				name: "nebula",
				url: "--upload-pack=touch /tmp/pwned",
			}),
		).rejects.toThrow(/git@/);
	});
});
