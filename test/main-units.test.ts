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
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, shell: {} }));
vi.mock("electron-log/main", () => ({
	default: { info() {}, warn() {}, error() {}, debug() {} },
}));

import * as bridge from "../resources/pi-extension/desktop-bridge";
import {
	ensureCosmosManagedAgentDir,
	mergeManagedPackages,
} from "../src/main/agent-home";
import { fuzzyScore } from "../src/main/files";
import {
	inferGlayvinHomeFromAgentDir,
	resolveGlayvinHomePath,
} from "../src/main/glayvin-runtime";
import { getGlayvinProfileOverview } from "../src/main/glayvin-profile";
import {
	managedWorktreeRoot,
	planManagedWorktree,
	sanitizeSegment,
} from "../src/main/worktrees";
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
import {
	isManagedSessionPath,
	isSessionFile,
	SessionIndex,
} from "../src/main/session-index";
import { sanitizeSettingsPatch } from "../src/main/settings";
import { parseEnvOutput } from "../src/main/shell-env";
import { supervisorBuildId } from "../src/main/supervisor-identity";
import {
	assertWorkspaceEntryName,
	cloneWorkspaceRepo,
	coreRepoCloneUrl,
	inspectWorkspace,
	isCoreRepoName,
	linkWorkspaceRepo,
	cloneFailureMessage,
	lastMeaningfulLine,
	unlinkWorkspaceRepo,
} from "../src/main/workspace";
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

describe("managed worktrees", () => {
	it("sanitizes worktree path and branch segments safely", () => {
		expect(sanitizeSegment(" Feature Branch / Weird Name ")).toBe(
			"feature-branch-weird-name",
		);
		expect(sanitizeSegment("***", 12)).toBe("");
	});

	it("plans managed worktrees under a repo-scoped root", () => {
		const root = managedWorktreeRoot(
			"/tmp/cosmos",
			"/Users/test/Cosmos/cosmos-gui",
		);
		expect(root).toBe("/tmp/cosmos/worktrees/cosmos-gui");
		expect(planManagedWorktree(root, "task 123", "worker:abc")).toEqual({
			path: "/tmp/cosmos/worktrees/cosmos-gui/task-123-worker-abc",
			branch: "cosmos/task-123/worker-abc",
		});
	});
});

describe("cosmos managed agent home", () => {
	it("merges seeded runtime packages into the managed profile", () => {
		const root = mkdtempSync(join(tmpdir(), "cosmos-managed-agent-"));
		const userData = join(root, "user-data");
		const seed = join(root, "seed-agent");
		const cosmosPackage = join(root, "cosmos-package");
		mkdirSync(seed, { recursive: true });
		mkdirSync(cosmosPackage, { recursive: true });
		writeFileSync(
			join(seed, "settings.json"),
			JSON.stringify({
				defaultProvider: "github-copilot",
				packages: [
					"npm:pi-mcp-adapter@2.21.2",
					"npm:pi-lens@4.0.0",
					"npm:@gotgenes/pi-permission-system@24.0.0",
				],
			}),
		);
		const managed = ensureCosmosManagedAgentDir(userData, [seed], cosmosPackage);
		const settings = JSON.parse(
			readFileSync(join(managed, "settings.json"), "utf8"),
		) as {
			packages?: unknown[];
		};
		expect(settings.packages).toEqual([
			"npm:pi-mcp-adapter@2.21.2",
			"npm:pi-lens@4.0.0",
			{ source: cosmosPackage },
		]);
	});
});

describe("managed package merge", () => {
	const COSMOS = "/apps/cosmos-package";

	it("drops packages the seed no longer lists", () => {
		const merged = mergeManagedPackages(
			["npm:pi-lens@4.0.0", "npm:pi-context@2.1.2"],
			COSMOS,
			{ packages: ["npm:pi-lens@4.0.0"] },
			["npm:pi-lens@4.0.0", "npm:pi-context@2.1.2"],
		);
		expect(merged.packages).toEqual([
			"npm:pi-lens@4.0.0",
			{ source: COSMOS },
		]);
		expect(merged.seedSources).toEqual(["npm:pi-lens@4.0.0"]);
	});

	it("keeps user-added packages that never came from the seed", () => {
		const merged = mergeManagedPackages(
			["npm:pi-lens@4.0.0", "npm:my-own-package@1.0.0"],
			COSMOS,
			{ packages: [] },
			["npm:pi-lens@4.0.0"],
		);
		expect(merged.packages).toEqual([
			"npm:my-own-package@1.0.0",
			{ source: COSMOS },
		]);
		expect(merged.seedSources).toEqual([]);
	});

	it("replaces a seeded package when the seed bumps its version", () => {
		const merged = mergeManagedPackages(
			["npm:pi-lens@4.0.0"],
			COSMOS,
			{ packages: ["npm:pi-lens@4.1.0"] },
			["npm:pi-lens@4.0.0"],
		);
		expect(merged.packages).toEqual([
			"npm:pi-lens@4.1.0",
			{ source: COSMOS },
		]);
	});

	it("filters the external permission system and keeps it out of the ledger", () => {
		const merged = mergeManagedPackages(
			[
				"npm:@gotgenes/pi-permission-system@23.0.0",
				{ source: "npm:pi-lens@4.0.0" },
			],
			COSMOS,
			{
				packages: [
					"npm:@gotgenes/pi-permission-system@24.0.0",
					"npm:pi-subagents@0.45.2",
				],
			},
		);
		expect(merged.packages).toEqual([
			"npm:pi-subagents@0.45.2",
			{ source: "npm:pi-lens@4.0.0" },
			{ source: COSMOS },
		]);
		expect(merged.seedSources).toEqual(["npm:pi-subagents@0.45.2"]);
	});

	it("appends the bundled cosmos package last exactly once", () => {
		const merged = mergeManagedPackages(
			[{ source: COSMOS }, "npm:pi-lens@4.0.0"],
			COSMOS,
			{ packages: ["npm:pi-lens@4.0.0"] },
		);
		expect(merged.packages).toEqual([
			"npm:pi-lens@4.0.0",
			{ source: COSMOS },
		]);
		expect(
			merged.packages.filter(
				(entry) =>
					typeof entry === "object" &&
					(entry as { source?: string }).source === COSMOS,
			),
		).toHaveLength(1);
	});

	it("removes nothing and preserves the ledger when no seed was read", () => {
		const merged = mergeManagedPackages(
			["npm:pi-lens@4.0.0", "npm:pi-context@2.1.2"],
			COSMOS,
			undefined,
			["npm:pi-lens@4.0.0", "npm:pi-context@2.1.2"],
		);
		expect(merged.packages).toEqual([
			"npm:pi-lens@4.0.0",
			"npm:pi-context@2.1.2",
			{ source: COSMOS },
		]);
		expect(merged.seedSources).toEqual([
			"npm:pi-lens@4.0.0",
			"npm:pi-context@2.1.2",
		]);
	});

	it("removes nothing when there is no ledger yet", () => {
		const merged = mergeManagedPackages(
			["npm:pi-lens@4.0.0", "npm:pi-context@2.1.2"],
			COSMOS,
			{ packages: ["npm:pi-lens@4.0.0"] },
		);
		expect(merged.packages).toEqual([
			"npm:pi-lens@4.0.0",
			"npm:pi-context@2.1.2",
			{ source: COSMOS },
		]);
		expect(merged.seedSources).toEqual(["npm:pi-lens@4.0.0"]);
	});

	it("matches object-form and string-form entries for the same source", () => {
		const merged = mergeManagedPackages(
			[{ source: "npm:pi-lens@4.0.0" }],
			COSMOS,
			{ packages: [] },
			["npm:pi-lens@4.0.0"],
		);
		expect(merged.packages).toEqual([{ source: COSMOS }]);
	});

	it("normalizes relative local paths before comparing", () => {
		const merged = mergeManagedPackages(
			[{ source: "./local-pkg" }],
			COSMOS,
			{ packages: [] },
			[resolve("./local-pkg")],
		);
		expect(merged.packages).toEqual([{ source: COSMOS }]);
	});
});

describe("managed agent marker ledger", () => {
	function setup() {
		const root = mkdtempSync(join(tmpdir(), "cosmos-managed-ledger-"));
		const userData = join(root, "user-data");
		const seed = join(root, "seed-agent");
		const cosmosPackage = join(root, "cosmos-package");
		mkdirSync(seed, { recursive: true });
		mkdirSync(cosmosPackage, { recursive: true });
		const writeSeed = (packages: string[]) =>
			writeFileSync(
				join(seed, "settings.json"),
				JSON.stringify({ defaultProvider: "github-copilot", packages }),
			);
		const readManaged = (dir: string, file: string) =>
			JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<
				string,
				unknown
			>;
		return { userData, seed, cosmosPackage, writeSeed, readManaged };
	}

	it("writes a versioned ledger on first run", () => {
		const { userData, seed, cosmosPackage, writeSeed, readManaged } = setup();
		writeSeed(["npm:pi-lens@4.0.0", "npm:pi-context@2.1.2"]);
		const managed = ensureCosmosManagedAgentDir(
			userData,
			[seed],
			cosmosPackage,
		);
		const marker = readManaged(managed, ".cosmos-managed.json");
		expect(marker.version).toBe(3);
		expect(marker.seedPackages).toEqual([
			"npm:pi-lens@4.0.0",
			"npm:pi-context@2.1.2",
		]);
	});

	it("drops a package once the seed stops listing it", () => {
		const { userData, seed, cosmosPackage, writeSeed, readManaged } = setup();
		writeSeed(["npm:pi-lens@4.0.0", "npm:pi-context@2.1.2"]);
		ensureCosmosManagedAgentDir(userData, [seed], cosmosPackage);
		writeSeed(["npm:pi-lens@4.0.0"]);
		const managed = ensureCosmosManagedAgentDir(
			userData,
			[seed],
			cosmosPackage,
		);
		const settings = readManaged(managed, "settings.json");
		expect(settings.packages).toEqual([
			"npm:pi-lens@4.0.0",
			{ source: cosmosPackage },
		]);
	});

	it("removes nothing on the first run after migrating a v1 marker", () => {
		const { userData, seed, cosmosPackage, writeSeed, readManaged } = setup();
		writeSeed(["npm:pi-lens@4.0.0", "npm:pi-context@2.1.2"]);
		const managed = ensureCosmosManagedAgentDir(
			userData,
			[seed],
			cosmosPackage,
		);
		// Rewind to the shipped v1 marker shape, which carries no ledger.
		writeFileSync(
			join(managed, ".cosmos-managed.json"),
			JSON.stringify({
				version: 1,
				managedBy: "Cosmos",
				seededFrom: seed,
				copied: ["auth.json"],
				createdAt: "2026-09-27T06:34:55.042Z",
			}),
		);
		writeSeed(["npm:pi-lens@4.0.0"]);
		ensureCosmosManagedAgentDir(userData, [seed], cosmosPackage);
		expect(readManaged(managed, "settings.json").packages).toEqual([
			"npm:pi-lens@4.0.0",
			"npm:pi-context@2.1.2",
			{ source: cosmosPackage },
		]);
		const marker = readManaged(managed, ".cosmos-managed.json");
		expect(marker.version).toBe(3);
		expect(marker.seedPackages).toEqual(["npm:pi-lens@4.0.0"]);
		expect(marker.createdAt).toBe("2026-09-27T06:34:55.042Z");
		expect(marker.copied).toEqual(["auth.json"]);
	});

	it("subtracts on the launch after the ledger is established", () => {
		const { userData, seed, cosmosPackage, writeSeed, readManaged } = setup();
		writeSeed(["npm:pi-lens@4.0.0", "npm:pi-context@2.1.2"]);
		const managed = ensureCosmosManagedAgentDir(
			userData,
			[seed],
			cosmosPackage,
		);
		writeSeed(["npm:pi-lens@4.0.0"]);
		ensureCosmosManagedAgentDir(userData, [seed], cosmosPackage);
		expect(readManaged(managed, "settings.json").packages).toEqual([
			"npm:pi-lens@4.0.0",
			{ source: cosmosPackage },
		]);
	});

	it("keeps seeded packages when the seed disappears", () => {
		const { userData, seed, cosmosPackage, writeSeed, readManaged } = setup();
		writeSeed(["npm:pi-lens@4.0.0"]);
		const managed = ensureCosmosManagedAgentDir(
			userData,
			[seed],
			cosmosPackage,
		);
		ensureCosmosManagedAgentDir(userData, [join(seed, "missing")], cosmosPackage);
		expect(readManaged(managed, "settings.json").packages).toEqual([
			"npm:pi-lens@4.0.0",
			{ source: cosmosPackage },
		]);
		expect(readManaged(managed, ".cosmos-managed.json").seedPackages).toEqual([
			"npm:pi-lens@4.0.0",
		]);
	});
});

describe("glayvin profile overview", () => {
	const noResolver = async () => undefined;

	function setup() {
		const root = mkdtempSync(join(tmpdir(), "cosmos-glayvin-profile-"));
		const glayvinHome = join(root, ".glayvin");
		mkdirSync(join(glayvinHome, ".local"), { recursive: true });
		mkdirSync(join(glayvinHome, "config", "packs"), { recursive: true });
		const write = (path: string, value: unknown) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify(value));
		};
		return { root, glayvinHome, write };
	}

	/** A home with the `default` profile resolving to core + the context pack core includes. */
	function setupDefaultProfile() {
		const fixture = setup();
		const { glayvinHome, write } = fixture;
		write(join(glayvinHome, "config", "profiles", "default.json"), {
			id: "default",
			packs: ["core"],
		});
		write(join(glayvinHome, "config", "packs", "core.json"), {
			id: "core",
			description: "Core runtime",
			includes: ["context"],
		});
		write(join(glayvinHome, "config", "packs", "context.json"), {
			id: "context",
		});
		write(join(glayvinHome, ".local", "resolved.json"), {
			profile: "default",
			packs: ["core", "context"],
			packages: [{ name: "pi-lens", version: "4.0.0", owner: "core" }],
		});
		return fixture;
	}

	it("reports unavailable without a glayvin home", async () => {
		const overview = await getGlayvinProfileOverview(undefined, noResolver);
		expect(overview.available).toBe(false);
		expect(overview.packs).toEqual([]);
		expect(overview.notes.length).toBeGreaterThan(0);
	});

	it("reports unavailable when the profile has not been resolved", async () => {
		const { glayvinHome } = setup();
		const overview = await getGlayvinProfileOverview(glayvinHome, noResolver);
		expect(overview.available).toBe(false);
		expect(overview.resolvedPath).toBe(
			join(glayvinHome, ".local", "resolved.json"),
		);
		expect(overview.notes.join(" ")).toContain("has not resolved a profile");
	});

	it("degrades instead of throwing on malformed resolved.json", async () => {
		const { glayvinHome } = setup();
		writeFileSync(join(glayvinHome, ".local", "resolved.json"), "{ not json");
		const overview = await getGlayvinProfileOverview(glayvinHome, noResolver);
		expect(overview.available).toBe(false);
		expect(overview.notes.join(" ")).toContain("Could not parse");
	});

	it("lists every pack the resolver knows about, not just the active ones", async () => {
		const { glayvinHome } = setupDefaultProfile();
		const overview = await getGlayvinProfileOverview(glayvinHome, async (_home, args) =>
			args[0] === "packs"
				? {
						packs: [
							{
								id: "core",
								source: "built-in",
								status: "effective",
								via: "profile",
								description: "Core runtime",
							},
							{
								id: "context",
								source: "built-in",
								status: "effective",
								via: "includes",
							},
							{ id: "vision", source: "built-in", status: "available" },
							{ id: "noisy", source: "built-in", status: "disabled" },
						],
					}
				: {
						profiles: [
							{
								id: "default",
								source: "built-in",
								active: true,
								description: "Default profile",
							},
							{ id: "minimal", source: "built-in", active: false },
						],
					},
		);

		expect(overview.source).toBe("resolver");
		expect(overview.packs.map((pack) => [pack.id, pack.status])).toEqual([
			["core", "effective"],
			["context", "effective"],
			["vision", "available"],
			["noisy", "disabled"],
		]);
		expect(overview.profiles).toEqual([
			{
				id: "default",
				layer: "built-in",
				description: "Default profile",
				active: true,
				packIds: ["core"],
			},
			{
				id: "minimal",
				layer: "built-in",
				description: undefined,
				active: false,
				packIds: [],
			},
		]);
		expect(overview.packages).toEqual([
			{
				name: "pi-lens",
				version: "4.0.0",
				pack: "core",
				excludedByCosmos: false,
			},
		]);
	});

	it("flags a pack the profile never named as implicit, with the resolver's reason", async () => {
		const { glayvinHome } = setupDefaultProfile();
		const overview = await getGlayvinProfileOverview(glayvinHome, async (_home, args) =>
			args[0] === "packs"
				? {
						packs: [
							{
								id: "core",
								source: "built-in",
								status: "effective",
								via: "profile",
							},
							{
								id: "context",
								source: "built-in",
								status: "effective",
								via: "includes",
							},
							{ id: "vision", source: "built-in", status: "available" },
						],
					}
				: { profiles: [] },
		);

		expect(overview.packs.map((pack) => [pack.id, pack.implicit, pack.via]))
			.toEqual([
				["core", false, "profile"],
				["context", true, "includes"],
				// Only effective packs can be implicit.
				["vision", false, undefined],
			]);
	});

	it("falls back to resolved.json when the resolver cannot run", async () => {
		const { glayvinHome } = setupDefaultProfile();
		const overview = await getGlayvinProfileOverview(glayvinHome, noResolver);

		expect(overview.source).toBe("files");
		expect(overview.available).toBe(true);
		expect(overview.packs.map((pack) => [pack.id, pack.layer, pack.implicit]))
			.toEqual([
				["core", "built-in", false],
				["context", "built-in", true],
			]);
		expect(overview.packs[0].description).toBe("Core runtime");
		expect(overview.profiles).toEqual([
			{ id: "default", layer: "built-in", active: true, packIds: ["core"] },
		]);
		expect(overview.notes.join(" ")).toContain("resolver could not be run");
	});

	it("falls back when the resolver returns unusable output", async () => {
		const { glayvinHome } = setupDefaultProfile();
		const overview = await getGlayvinProfileOverview(glayvinHome, async () => ({
			packs: "not-an-array",
		}));
		expect(overview.source).toBe("files");
		expect(overview.packs.map((pack) => pack.id)).toEqual(["core", "context"]);
	});

	it("attributes packs to the highest-precedence layer that has them", async () => {
		const { root, glayvinHome, write } = setup();
		const teamA = join(root, "team-a");
		const teamB = join(root, "team-b");
		write(join(glayvinHome, ".local", "glayvin.json"), {
			teams: [
				{ name: "team-a", path: teamA },
				{ name: "team-b", path: teamB },
			],
		});
		write(join(glayvinHome, "config", "packs", "debug.json"), { id: "debug" });
		write(join(teamA, "packs", "debug.json"), { id: "debug" });
		write(join(teamB, "packs", "debug.json"), { id: "debug" });
		write(join(glayvinHome, ".local", "glayvin", "packs", "scratch.json"), {
			id: "scratch",
			description: "Personal scratch pack",
		});
		write(join(glayvinHome, ".local", "resolved.json"), {
			profile: "default",
			packs: ["debug", "scratch", "ghost"],
		});

		const overview = await getGlayvinProfileOverview(glayvinHome, noResolver);
		expect(
			overview.packs.map((pack) => [pack.id, pack.layer, pack.teamName]),
		).toEqual([
			// The later-registered team wins.
			["debug", "team", "team-b"],
			["scratch", "local", undefined],
			["ghost", "unknown", undefined],
		]);
		expect(overview.notes.join(" ")).toContain("could not be traced to a layer");
	});

	it("ignores packs from a disabled team", async () => {
		const { root, glayvinHome, write } = setup();
		const team = join(root, "team-a");
		write(join(glayvinHome, ".local", "glayvin.json"), {
			teams: [{ name: "team-a", path: team }],
		});
		write(join(glayvinHome, ".local", "disabled.json"), { teams: ["team-a"] });
		write(join(team, "packs", "debug.json"), { id: "debug" });
		write(join(glayvinHome, ".local", "resolved.json"), {
			profile: "default",
			packs: ["debug"],
		});

		const overview = await getGlayvinProfileOverview(glayvinHome, noResolver);
		expect(overview.teams[0].enabled).toBe(false);
		expect(overview.packs[0].layer).toBe("unknown");
	});

	it("reports what each registered team contributes", async () => {
		const { root, glayvinHome, write } = setup();
		const team = join(root, "cosmos-ai");
		write(join(glayvinHome, ".local", "glayvin.json"), {
			teams: [{ name: "cosmos-ai", path: team }],
		});
		write(join(team, "mcp-config.json"), {
			mcpServers: { figma: {}, sentry: {} },
		});
		mkdirSync(join(team, "skills", "defuddle"), { recursive: true });
		mkdirSync(join(team, "skills", "triage"), { recursive: true });
		writeFileSync(join(team, "copilot-instructions.md"), "team context");
		write(join(glayvinHome, ".local", "resolved.json"), {
			profile: "default",
			packs: [],
		});

		const overview = await getGlayvinProfileOverview(glayvinHome, noResolver);
		expect(overview.teams).toEqual([
			{
				name: "cosmos-ai",
				path: team,
				exists: true,
				enabled: true,
				contributes: {
					packIds: [],
					profileIds: [],
					mcpServerNames: ["figma", "sentry"],
					skillCount: 2,
					hasInstructions: true,
				},
			},
		]);
	});

	it("flags registered teams whose directories are gone", async () => {
		const { root, glayvinHome, write } = setup();
		write(join(glayvinHome, ".local", "glayvin.json"), {
			teams: [{ name: "stale", path: join(root, "missing") }],
		});
		write(join(glayvinHome, ".local", "resolved.json"), {
			profile: "minimal",
			packs: [],
		});
		const overview = await getGlayvinProfileOverview(glayvinHome, noResolver);
		expect(overview.teams[0]).toMatchObject({ name: "stale", exists: false });
		expect(overview.notes.join(" ")).toContain("no longer exist");
	});
});

describe("glayvin runtime detection", () => {
	it("infers GLAYVIN_HOME from a glayvin-style agent dir", () => {
		expect(inferGlayvinHomeFromAgentDir("/Users/test/.glayvin/.pi/agent")).toBe(
			"/Users/test/.glayvin",
		);
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
		expect(
			overview.servers.find((server) => server.name === "figma"),
		).toMatchObject({
			active: true,
			personal: false,
			auth: "oauth",
		});
		expect(
			overview.servers.find((server) => server.name === "graphos"),
		).toMatchObject({
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
		expect(
			overview.servers.find((server) => server.name === "figma"),
		).toMatchObject({
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
		let overview = await getMcpOverview(
			glayvinHome,
			join(glayvinHome, ".pi", "agent"),
		);
		expect(
			overview.servers.find((server) => server.name === "test-server"),
		).toMatchObject({
			personal: true,
			active: false,
		});

		removePersonalMcpServer(glayvinHome, "test-server");
		overview = await getMcpOverview(
			glayvinHome,
			join(glayvinHome, ".pi", "agent"),
		);
		expect(
			overview.servers.find((server) => server.name === "test-server"),
		).toBeUndefined();
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
		expect(coreRepoCloneUrl("neutron")).toBe("git@github.com:shipt/neutron.git");
		expect(coreRepoCloneUrl("neutron", "acme-co")).toBe(
			"git@github.com:acme-co/neutron.git",
		);
		// Junk orgs fall back rather than producing a broken or injected URL.
		expect(coreRepoCloneUrl("neutron", "bad org/../x")).toBe(
			"git@github.com:shipt/neutron.git",
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

		linkWorkspaceRepo({ rootPath: root, name: "neutron", targetPath: external });
		const health = inspectWorkspace(root);
		const neutron = health.repos.find((repo) => repo.name === "neutron");

		expect(neutron?.isSymlink).toBe(true);
		expect(neutron?.linkTarget).toBe(external);
		expect(neutron?.isGitRepo).toBe(true);
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
			linkWorkspaceRepo({ rootPath: root, name: "neutron", targetPath: inside }),
		).toThrow(/already inside/);
		expect(() =>
			linkWorkspaceRepo({ rootPath: root, name: "neutron", targetPath: join(external, "nope") }),
		).toThrow(/not a folder/);
	});

	it("unlinks symlinks but never deletes a real folder", () => {
		const root = workspace();
		const external = mkdtempSync(join(tmpdir(), "cosmos-external-"));
		writeFileSync(join(external, "keep.txt"), "keep me");
		linkWorkspaceRepo({ rootPath: root, name: "neutron", targetPath: external });
		mkdirSync(join(root, "real-thing"), { recursive: true });

		unlinkWorkspaceRepo(root, "neutron");
		expect(existsSync(join(root, "neutron"))).toBe(false);
		expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("keep me");

		expect(() => unlinkWorkspaceRepo(root, "real-thing")).toThrow(/real folder/);
		expect(existsSync(join(root, "real-thing"))).toBe(true);
	});

	it("clones a repo into the workspace root and streams progress", async () => {
		const root = workspace();
		const origin = mkdtempSync(join(tmpdir(), "cosmos-origin-"));
		execFileSync("git", ["init", "--quiet", "--initial-branch=main", origin]);
		writeFileSync(join(origin, "README.md"), "# neutron\n");
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
			name: "neutron",
			url: `file://${origin}`,
			onProgress: (message) => progress.push(message),
		});

		expect(target).toBe(join(root, "neutron"));
		expect(readFileSync(join(target, "README.md"), "utf8")).toBe("# neutron\n");
		expect(inspectWorkspace(root).readyRepos).toBe(1);
		expect(progress.length).toBeGreaterThan(0);
		// Staging directories must not survive a successful clone.
		expect(readdirSync(root)).toEqual(["neutron"]);
	});

	it("leaves no directory behind when a clone fails", async () => {
		const root = workspace();
		await expect(
			cloneWorkspaceRepo({
				rootPath: root,
				name: "neutron",
				url: `file://${join(tmpdir(), "cosmos-missing-origin")}`,
			}),
		).rejects.toThrow();
		expect(existsSync(join(root, "neutron"))).toBe(false);
		expect(readdirSync(root)).toEqual([]);
	});

	it("rejects clone URLs that are not recognised git transports", async () => {
		const root = workspace();
		await expect(
			cloneWorkspaceRepo({
				rootPath: root,
				name: "neutron",
				url: "--upload-pack=touch /tmp/pwned",
			}),
		).rejects.toThrow(/git@/);
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

describe("session file deletion", () => {
	function withSessionRoot<T>(run: (root: string) => T): T {
		const root = mkdtempSync(join(tmpdir(), "cosmos-sessions-"));
		const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
		process.env.PI_CODING_AGENT_SESSION_DIR = root;
		try {
			return run(root);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
			else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
		}
	}

	it("tells a path outside the session folder apart from a file that is already gone", () => {
		withSessionRoot((root) => {
			const missing = join(root, "project", "gone.jsonl");
			expect(isManagedSessionPath(missing)).toBe(true);
			expect(isSessionFile(missing)).toBe(false);
			expect(isManagedSessionPath(join(tmpdir(), "elsewhere.jsonl"))).toBe(false);
		});
	});

	it("treats deleting an already-deleted session as a no-op but still rejects foreign paths", async () => {
		const index = new SessionIndex(() => {});
		try {
			await withSessionRoot(async (root) => {
				await expect(index.trash(join(root, "project", "gone.jsonl"))).resolves.toBeUndefined();
				await expect(index.trash(join(tmpdir(), "elsewhere.jsonl"))).rejects.toThrow(/outside/);
				await expect(index.trash(join(root, "notes.txt"))).rejects.toThrow(/Not a pi session file/);
			});
		} finally {
			index.stop();
		}
	});
});

describe("clone failure reporting", () => {
	it("names the cause instead of the fragment git happens to end on", () => {
		// Verbatim output from `git clone` against a repo the user cannot see.
		const output = [
			"Cloning into '/tmp/staging'...",
			"ERROR: Repository not found.",
			"fatal: Could not read from remote repository.",
			"",
			"Please make sure you have the correct access rights",
			"and the repository exists.",
		].join("\n");
		expect(lastMeaningfulLine(output)).toBe("Repository not found.");
	});

	it("keeps a cause that carries no ERROR or fatal prefix", () => {
		const output = [
			"git@github.com: Permission denied (publickey).",
			"fatal: Could not read from remote repository.",
			"Please make sure you have the correct access rights",
			"and the repository exists.",
		].join("\n");
		expect(lastMeaningfulLine(output)).toBe(
			"git@github.com: Permission denied (publickey).",
		);
	});

	it("falls back to the boilerplate when git said nothing else", () => {
		const output = "fatal: Could not read from remote repository.\n";
		expect(lastMeaningfulLine(output)).toBe(
			"fatal: Could not read from remote repository.",
		);
	});

	it("ignores progress chatter when picking the failure line", () => {
		const output = [
			"Cloning into 'neutron'...",
			"remote: Enumerating objects: 120, done.",
			"Receiving objects:  100% (120/120), done.",
			"fatal: destination path 'neutron' already exists and is not an empty directory.",
		].join("\n");
		expect(lastMeaningfulLine(output)).toBe(
			"fatal: destination path 'neutron' already exists and is not an empty directory.",
		);
	});
});

describe("clone failure context", () => {
	const url = "git@github.com:shipt/neutron.git";

	it("names the org that was tried, which the card never shows", () => {
		expect(cloneFailureMessage("Repository not found.", url, 128)).toBe(
			`Repository not found. (${url})`,
		);
	});

	it("does not repeat a URL git already quoted", () => {
		const line = `fatal: repository '${url}' does not exist`;
		expect(cloneFailureMessage(line, url, 128)).toBe(line);
	});

	it("falls back to the exit code when git printed nothing usable", () => {
		expect(cloneFailureMessage("", url, 128)).toBe("git clone failed (exit 128)");
		expect(cloneFailureMessage("", url, null)).toBe("git clone failed (exit unknown)");
	});
});

describe("core repo list", () => {
	// shipt/nebula never existed. It sat in this list unnoticed because the list
	// started life as folder names to look for, and only later became the source
	// of clone URLs, where a name that is merely wrong turns into a 404.
	it("lists repos that exist, not folder labels", () => {
		for (const name of ["cosmos-ai", "segway-next", "neutron", "design-system"]) {
			expect(isCoreRepoName(name)).toBe(true);
		}
		expect(isCoreRepoName("nebula")).toBe(false);
	});

	it("builds a clone URL for every core repo", () => {
		for (const name of ["cosmos-ai", "segway-next", "neutron", "design-system"]) {
			expect(coreRepoCloneUrl(name)).toBe(`git@github.com:shipt/${name}.git`);
		}
	});
});
