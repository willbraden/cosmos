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
	type CommandResult,
	type CommandRunner,
	classifyRoot,
	createCommandRunner,
	discoverTeams,
	effectivePrecedence,
	isRateLimited,
	parseRootNames,
	parseSearchHits,
	readCache,
	registerGlayvinTeam,
	resolveMembership,
	searchArgs,
	searchQuery,
	setGlayvinTeamEnabled,
	unionSearchHits,
	writeCache,
} from "../src/main/team-discovery";
import {
	inferGlayvinHomeFromAgentDir,
	readDisabledTeamNames,
	readGlayvinTeams,
	readRegisteredTeamNames,
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
	findCoreRepo,
	resolveCoreRepos,
	DEFAULT_CORE_REPOS,
	TEAM_REPOS_FILE,
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

	it("treats only pack-pulled reasons as implicit, not hand-enabled ones", async () => {
		const { glayvinHome } = setupDefaultProfile();
		const overview = await getGlayvinProfileOverview(
			glayvinHome,
			async (_home, args) =>
				args[0] === "packs"
					? {
							packs: [
								// Neither is named by the profile, so a diff against the
								// profile's packs[] would call both implicit.
								{
									id: "vision",
									source: "built-in",
									status: "effective",
									via: "enabledPacks",
								},
								{
									id: "graphify",
									source: "built-in",
									status: "effective",
									via: "requires:builder",
								},
							],
						}
					: { profiles: [] },
		);

		expect(overview.packs.map((pack) => [pack.id, pack.implicit])).toEqual([
			["vision", false],
			["graphify", true],
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

describe("glayvin teams", () => {
	function homeWith(config: string): string {
		const home = mkdtempSync(join(tmpdir(), "cosmos-teams-"));
		mkdirSync(join(home, ".local"), { recursive: true });
		writeFileSync(join(home, ".local", "glayvin.json"), config);
		return home;
	}

	it("reads registered teams, skipping entries it cannot resolve", () => {
		const home = homeWith(
			JSON.stringify({
				teams: [
					{ name: "cosmos-ai", path: "/Users/test/Cosmos/cosmos-ai" },
					// Relative paths are repo-relative, so there is nothing to match against.
					{ name: "relative", path: "./shared-config" },
					{ name: "  padded  ", path: "/Users/test/padded" },
					{ name: "", path: "/Users/test/nameless" },
					{ path: "/Users/test/anonymous" },
					"not-an-object",
				],
			}),
		);
		expect(readGlayvinTeams(home)).toEqual([
			{ name: "cosmos-ai", path: "/Users/test/Cosmos/cosmos-ai" },
			{ name: "padded", path: "/Users/test/padded" },
		]);
	});

	it("degrades to no teams rather than throwing", () => {
		expect(readGlayvinTeams(undefined)).toEqual([]);
		expect(readGlayvinTeams("/nope/does-not-exist")).toEqual([]);
		expect(readGlayvinTeams(homeWith("{ not json"))).toEqual([]);
		expect(readGlayvinTeams(homeWith(JSON.stringify({})))).toEqual([]);
		expect(readGlayvinTeams(homeWith(JSON.stringify({ teams: "nope" })))).toEqual(
			[],
		);
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

	it("tags repos registered as a glayvin team layer", () => {
		const root = workspace();
		const health = inspectWorkspace(root, undefined, [
			{ name: "design-ops", path: join(root, "cosmos-ai") },
		]);

		expect(
			health.repos.find((repo) => repo.name === "cosmos-ai")?.team,
		).toBe("design-ops");
		// A repo nobody registered carries no team, so the UI keeps its own label.
		expect(
			health.repos.find((repo) => repo.name === "neutron"),
		).not.toHaveProperty("team");
	});

	it("matches a team registered against a linked checkout's target", () => {
		const root = workspace();
		const external = mkdtempSync(join(tmpdir(), "cosmos-external-"));
		mkdirSync(join(external, ".git"), { recursive: true });
		linkWorkspaceRepo({ rootPath: root, name: "neutron", targetPath: external });

		// Trailing slashes are how a path lands when copied out of a shell.
		const health = inspectWorkspace(root, undefined, [
			{ name: "platform", path: `${external}/` },
		]);

		expect(health.repos.find((repo) => repo.name === "neutron")?.team).toBe(
			"platform",
		);
	});

	it("tags experiments too, since a team can point anywhere", () => {
		const root = workspace();
		mkdirSync(join(root, "showcase"), { recursive: true });
		const health = inspectWorkspace(root, undefined, [
			{ name: "showcase-team", path: join(root, "showcase") },
		]);

		expect(
			health.experiments.find((repo) => repo.name === "showcase")?.team,
		).toBe("showcase-team");
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

describe("team-curated repo lists", () => {
	function team(name: string, contents?: unknown) {
		const path = mkdtempSync(join(tmpdir(), `cosmos-team-${name}-`));
		if (contents !== undefined) {
			writeFileSync(join(path, TEAM_REPOS_FILE), JSON.stringify(contents));
		}
		return { name, path };
	}

	it("replaces the built-in repos when a team publishes its own", () => {
		const repos = resolveCoreRepos([
			team("design-ops", { repos: ["cosmos-ai", "design-system"] }),
		]);

		expect(repos.map((repo) => repo.name)).toEqual([
			"cosmos-ai",
			"design-system",
		]);
	});

	// Nobody has authored one of these files yet, so the untouched path is the
	// one almost everybody takes.
	it("falls back to the built-in repos when no team declares any", () => {
		expect(resolveCoreRepos([])).toEqual(DEFAULT_CORE_REPOS);
		expect(resolveCoreRepos([team("no-file")])).toEqual(DEFAULT_CORE_REPOS);
		expect(resolveCoreRepos([team("empty", { repos: [] })])).toEqual(
			DEFAULT_CORE_REPOS,
		);
		expect(resolveCoreRepos([team("wrong-shape", { repos: "neutron" })])).toEqual(
			DEFAULT_CORE_REPOS,
		);
	});

	it("survives a malformed file rather than emptying the home screen", () => {
		const broken = mkdtempSync(join(tmpdir(), "cosmos-team-broken-"));
		writeFileSync(join(broken, TEAM_REPOS_FILE), "{ not json");

		expect(resolveCoreRepos([{ name: "broken", path: broken }])).toEqual(
			DEFAULT_CORE_REPOS,
		);
	});

	it("unions across teams and keeps the first spelling of a repeat", () => {
		const repos = resolveCoreRepos([
			team("first", { org: "shipt", repos: ["neutron"] }),
			team("second", { repos: [{ name: "neutron", org: "other" }, "segway-next"] }),
		]);

		expect(repos).toEqual([
			{ name: "neutron", org: "shipt" },
			{ name: "segway-next" },
		]);
	});

	it("applies a per-repo org over the team org", () => {
		const repos = resolveCoreRepos([
			team("mixed", {
				org: "shipt",
				repos: ["neutron", { name: "widget", org: "acme-co" }],
			}),
		]);

		expect(coreRepoCloneUrl("neutron", repos[0]?.org)).toBe(
			"git@github.com:shipt/neutron.git",
		);
		expect(coreRepoCloneUrl("widget", repos[1]?.org)).toBe(
			"git@github.com:acme-co/widget.git",
		);
	});

	// These names reach both mkdir and a clone URL, so a bad one is worse than a
	// missing one.
	it("drops names that would escape the workspace or the URL path", () => {
		const repos = resolveCoreRepos([
			team("sloppy", {
				repos: ["../evil", "a/b", ".git", "", "  ", 7, { name: "good-repo" }],
			}),
		]);

		expect(repos).toEqual([{ name: "good-repo" }]);
	});

	it("re-sorts siblings into experiments when the core list changes", () => {
		const root = mkdtempSync(join(tmpdir(), "cosmos-workspace-"));
		mkdirSync(join(root, "neutron"), { recursive: true });
		const declared = resolveCoreRepos([
			team("design-ops", { repos: ["design-system"] }),
		]);
		const health = inspectWorkspace(root, undefined, [], declared);

		// neutron is built-in but unlisted here, so it demotes to an experiment.
		expect(health.repos.map((repo) => repo.name)).toEqual(["design-system"]);
		expect(health.experiments.map((repo) => repo.name)).toEqual(["neutron"]);
	});
});

describe("core repo list", () => {
	// shipt/nebula never existed. It sat in this list unnoticed because the list
	// started life as folder names to look for, and only later became the source
	// of clone URLs, where a name that is merely wrong turns into a 404.
	it("lists repos that exist, not folder labels", () => {
		for (const name of ["cosmos-ai", "segway-next", "neutron", "design-system"]) {
			expect(findCoreRepo(name)).toBeDefined();
		}
		expect(findCoreRepo("nebula")).toBeUndefined();
	});

	it("builds a clone URL for every core repo", () => {
		for (const name of ["cosmos-ai", "segway-next", "neutron", "design-system"]) {
			expect(coreRepoCloneUrl(name)).toBe(`git@github.com:shipt/${name}.git`);
		}
	});
});

// Root listings captured from the real shipt org. Genuine team layers match four or
// more layer markers here; product repos that merely carry one of the same filenames
// match exactly one, which is the margin the classifier relies on.
const REAL_ROOTS: Record<string, string[]> = {
	"business-reports-team-context":
		".gitignore README.md bin copilot-instructions.md infraspec.yaml instructions packs profiles skills".split(" "),
	"cosmos-ai":
		".github .gitignore README.md copilot-instructions.md disabled.json docs infraspec.yaml mcp-config.json scripts skills".split(" "),
	designos:
		".github README.md agents bin copilot-instructions.md disabled.json infraspec.yaml mcp-config.json skills".split(" "),
	"glayvin-incident-management":
		".github AGENTS.md README.md agents bin cmd configs copilot-instructions.md disabled.json docs go.mod go.sum infraspec.yaml internal skills templates".split(" "),
	"glayvin-team-template":
		"README.md agents bin copilot-instructions.md disabled.json infraspec.yaml mcp-config.json skills".split(" "),
	"ux-ai-context":
		".github .local README.md agents bin copilot-instructions.md disabled.json doc infraspec.yaml mcp-config.json projects schemas skills team-config.json".split(" "),
	"fulfillment-engine":
		".github Dockerfile Makefile README.md alerts.yaml cmd copilot-instructions.md docker-compose.yml go.mod go.sum infraspec.yaml internal migrations terraform vendor".split(" "),
	locations:
		".github Dockerfile Makefile README.md cmd copilot-instructions.md docker-compose.yml go.mod go.sum internal migrations terraform test tools".split(" "),
	"marketplace-agent":
		".github Dockerfile Makefile README.md agent cmd docker-compose.yml go.mod go.sum internal mcp-config.json migrations terraform".split(" "),
	"spotter-agent":
		".github Dockerfile Makefile README.md agent cmd docker-compose.yml go.mod go.sum internal mcp-config.json migrations terraform".split(" "),
	"promo-planning-tool":
		".github Dockerfile Makefile README.md app copilot-instructions.md docker-compose.yaml docs infraspec.yaml models pyproject.toml stubs tests".split(" "),
	"shopper-temporal":
		".github AGENTS.md Dockerfile README.md alerts.yaml copilot-instructions.md dynamicconfig infraspec.yaml terraform thanos".split(" "),
	"timeslot-risk-ml-calculator":
		".github Dockerfile Makefile README.md app copilot-instructions.md dags docker-compose.yml docs infraspec.yaml pyproject.toml scripts terraform tests".split(" "),
};

describe("team classification", () => {
	const classOf = (repo: string) =>
		classifyRoot(repo, REAL_ROOTS[repo]).classification;

	// Canary. These four are known-good team layers, captured from the real org and
	// re-verified against live GitHub. If this fails, the classifier has drifted and
	// discovery will return a plausible-looking but wrong "nothing found" — check
	// LAYER_MARKERS and the layers >= 3 threshold before trusting an empty pane.
	it("accepts the real team layers in the org", () => {
		for (const repo of [
			"business-reports-team-context",
			"cosmos-ai",
			"designos",
			"ux-ai-context",
		]) {
			expect(classOf(repo)).toBe("team");
		}
	});

	// A layer that also ships a Go binary must not be vetoed by its product files,
	// which is why three layer markers decide on their own.
	it("keeps a team layer that also ships a service", () => {
		const result = classifyRoot(
			"glayvin-incident-management",
			REAL_ROOTS["glayvin-incident-management"],
		);
		expect(result.classification).toBe("team");
		expect(result.markers.filter((m) => m.kind === "product").length).toBeGreaterThan(0);
	});

	// These carry copilot-instructions.md or mcp-config.json and nothing else, which is
	// why no single marker search can be trusted on its own.
	it("rejects product repos that merely carry one marker", () => {
		for (const repo of [
			"fulfillment-engine",
			"locations",
			"marketplace-agent",
			"spotter-agent",
			"promo-planning-tool",
			"shopper-temporal",
			"timeslot-risk-ml-calculator",
		]) {
			expect(classOf(repo)).toBe("uncertain");
		}
	});

	it("marks the template rather than offering it as a team", () => {
		expect(classOf("glayvin-team-template")).toBe("template");
	});

	it("separates real layers from product repos by a wide margin", () => {
		const layerCount = (repo: string) =>
			classifyRoot(repo, REAL_ROOTS[repo]).markers.filter((m) => m.kind === "layer")
				.length;
		const layers = ["cosmos-ai", "designos", "ux-ai-context"].map(layerCount);
		const products = ["fulfillment-engine", "marketplace-agent", "locations"].map(
			layerCount,
		);
		expect(Math.min(...layers)).toBeGreaterThan(Math.max(...products) + 1);
	});

	it("flags a layer that curates the home screen repo list", () => {
		expect(classifyRoot("x", ["copilot-instructions.md", "packs", "cosmos-repos.json"]))
			.toMatchObject({ classification: "team", curatesRepos: true });
		expect(classifyRoot("x", REAL_ROOTS["cosmos-ai"]).curatesRepos).toBe(false);
	});

	it("reports every marker it matched so the heuristic stays visible", () => {
		const names = classifyRoot("designos", REAL_ROOTS.designos).markers.map(
			(m) => m.name,
		);
		expect(names).toContain("copilot-instructions.md");
		expect(names).toContain("skills");
		expect(names).not.toContain("README.md");
	});
});

describe("team search parsing", () => {
	const item = (over: Record<string, unknown> = {}) => ({
		path: "disabled.json",
		repo: "designos",
		description: "Design system context",
		htmlUrl: "https://github.com/shipt/designos",
		fork: false,
		...over,
	});

	it("builds a root-scoped query per marker", () => {
		expect(searchQuery("shipt", "disabled.json")).toBe(
			"org:shipt filename:disabled.json path:/",
		);
		const args = searchArgs("shipt", "disabled.json");
		expect(args.join(" ")).toContain(
			encodeURIComponent("org:shipt filename:disabled.json path:/"),
		);
	});

	it("keeps root-level hits and drops nested ones", () => {
		const hits = parseSearchHits(
			JSON.stringify([item(), item({ repo: "other", path: "nested/disabled.json" })]),
		);
		expect(hits.hits.map((h) => h.repo)).toEqual(["designos"]);
	});

	it("drops forks and invalid repo names", () => {
		const hits = parseSearchHits(
			JSON.stringify([
				item({ repo: "forked", fork: true }),
				item({ repo: "../escape" }),
				item(),
			]),
		);
		expect(hits.hits.map((h) => h.repo)).toEqual(["designos"]);
	});

	it("discards GitHub's placeholder descriptions", () => {
		const { hits: [hit] } = parseSearchHits(
			JSON.stringify([
				item({ repo: "glayvin-delivery", description: "Default description for glayvin-delivery" }),
			]),
		);
		expect(hit.description).toBeUndefined();
	});

	// `gh` exits 0 while printing this, so an unreadable reply must not look like an
	// org with no teams. `gh search code` returning `[]` is the real-world case.
	it("marks a reply that is not JSON as unreadable", () => {
		expect(parseSearchHits("gh: rate limit exceeded")).toEqual({
			hits: [],
			readable: false,
		});
	});

	it("marks JSON that is not an array as unreadable", () => {
		expect(parseSearchHits('{"message":"Not Found"}').readable).toBe(false);
	});

	it("treats an empty array as a readable, genuinely empty result", () => {
		expect(parseSearchHits("[]")).toEqual({ hits: [], readable: true });
	});

	it("unions the marker searches and keeps the best description", () => {
		const union = unionSearchHits([
			[{ repo: "b", htmlUrl: "u" }],
			[{ repo: "b", htmlUrl: "u", description: "found later" }],
			[{ repo: "a", htmlUrl: "u" }],
		]);
		expect(union.map((h) => h.repo)).toEqual(["a", "b"]);
		expect(union[1].description).toBe("found later");
	});

	it("reads the root listing as one name per line", () => {
		expect(parseRootNames("agents\nskills\n\n  packs  \n")).toEqual([
			"agents",
			"skills",
			"packs",
		]);
	});

	it("recognises a rate-limited reply", () => {
		expect(isRateLimited({ stdout: "", stderr: "API rate limit exceeded", code: 1 })).toBe(true);
		expect(isRateLimited({ stdout: "", stderr: "could not resolve host", code: 1 })).toBe(false);
	});
});

describe("team discovery cache", () => {
	const candidate = {
		repo: "designos",
		htmlUrl: "https://github.com/shipt/designos",
		markers: [{ name: "skills", kind: "layer" as const }],
		classification: "team" as const,
		curatesRepos: false,
	};

	it("round-trips a snapshot", () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-cache-"));
		writeCache(dir, "shipt", [candidate], 1234);
		expect(readCache(dir, "shipt")).toEqual({
			fetchedAt: 1234,
			candidates: [candidate],
		});
	});

	// Switching orgs must not show the previous org's teams.
	it("ignores a snapshot taken for another org", () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-cache-"));
		writeCache(dir, "shipt", [candidate], 1234);
		expect(readCache(dir, "other-org")).toBeUndefined();
	});

	it("ignores a corrupt or unversioned file", () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-cache-"));
		writeFileSync(join(dir, "team-discovery.json"), "{ not json", "utf8");
		expect(readCache(dir, "shipt")).toBeUndefined();
		writeFileSync(
			join(dir, "team-discovery.json"),
			JSON.stringify({ version: 99, org: "shipt", fetchedAt: 1, candidates: [] }),
			"utf8",
		);
		expect(readCache(dir, "shipt")).toBeUndefined();
	});

	it("reports no snapshot when none was ever written", () => {
		expect(readCache(mkdtempSync(join(tmpdir(), "teams-cache-")), "shipt")).toBeUndefined();
	});
});

describe("team discovery", () => {
	/** A fake gh/glayvin that answers from a script of matchers, in call order. */
	function fakeRunner(
		handlers: {
			match: (file: string, args: string[]) => boolean;
			reply: CommandResult;
		}[],
		calls: string[] = [],
	) {
		const run = async (file: string, args: string[]): Promise<CommandResult> => {
			calls.push(`${file} ${args.join(" ")}`);
			const hit = handlers.find((h) => h.match(file, args));
			return hit ? hit.reply : { stdout: "", stderr: "no match", code: 1 };
		};
		return { run, calls };
	}

	const ok = (stdout: string): CommandResult => ({ stdout, stderr: "", code: 0 });
	const fail = (stderr: string): CommandResult => ({ stdout: "", stderr, code: 1 });
	const found = (repo: string) =>
		ok(JSON.stringify([{ path: "disabled.json", repo, htmlUrl: `https://github.com/shipt/${repo}`, fork: false }]));

	const baseOptions = (dir: string, run: CommandRunner) => ({
		org: "shipt",
		userDataDir: dir,
		workspaceRootPath: join(dir, "workspace"),
		glayvinHome: join(dir, ".glayvin"),
		teams: [],
		run,
		now: () => 5000,
	});

	const happyHandlers = [
		{ match: (_f: string, a: string[]) => a[0] === "which", reply: ok("/usr/bin/tool") },
		{ match: (_f: string, a: string[]) => a[0] === "auth", reply: ok("Logged in") },
		{ match: (_f: string, a: string[]) => a[1]?.includes("Accept") === true || a.some((x) => x.includes("/search/code")), reply: found("designos") },
		{ match: (_f: string, a: string[]) => a.some((x) => x.includes("contents")), reply: ok(REAL_ROOTS.designos.join("\n")) },
	];

	it("classifies and lists what the searches turned up", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-"));
		const { run } = fakeRunner(happyHandlers);
		const result = await discoverTeams(baseOptions(dir, run));
		expect(result.available).toBe(true);
		expect(result.fromCache).toBe(false);
		expect(result.teams).toHaveLength(1);
		expect(result.teams[0]).toMatchObject({
			repo: "designos",
			classification: "team",
			nameWithOwner: "shipt/designos",
			cloneUrl: "git@github.com:shipt/designos.git",
			membership: undefined,
		});
	});

	// Opening Settings must not fire ~20 API calls every time.
	it("serves the cache without touching the network until asked to refresh", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-"));
		await discoverTeams(baseOptions(dir, fakeRunner(happyHandlers).run));

		const second = fakeRunner(happyHandlers);
		const cached = await discoverTeams(baseOptions(dir, second.run));
		expect(cached.fromCache).toBe(true);
		expect(cached.fetchedAt).toBe(5000);
		expect(cached.teams).toHaveLength(1);
		expect(second.calls.some((c) => c.includes("/search/code"))).toBe(false);

		const third = fakeRunner(happyHandlers);
		const refreshed = await discoverTeams({
			...baseOptions(dir, third.run),
			refresh: true,
		});
		expect(refreshed.fromCache).toBe(false);
		expect(third.calls.some((c) => c.includes("/search/code"))).toBe(true);
	});

	it("marks a registered team as joined", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-"));
		const teamPath = join(dir, "workspace", "designos");
		mkdirSync(teamPath, { recursive: true });
		const result = await discoverTeams({
			...baseOptions(dir, fakeRunner(happyHandlers).run),
			teams: [{ name: "designos", path: teamPath }],
		});
		expect(result.teams[0].membership).toMatchObject({
			name: "designos",
			path: teamPath,
			state: "active",
		});
	});

	it("spots a clone that was never registered", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-"));
		mkdirSync(join(dir, "workspace", "designos"), { recursive: true });
		const result = await discoverTeams(baseOptions(dir, fakeRunner(happyHandlers).run));
		expect(result.teams[0].membership).toBeUndefined();
		expect(result.teams[0].clonedPath).toBe(join(dir, "workspace", "designos"));
	});

	it("explains itself when gh is missing instead of throwing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-"));
		const { run } = fakeRunner([
			{ match: (_f, a) => a[0] === "which" && a[1] === "glayvin", reply: ok("/bin/glayvin") },
			{ match: (_f, a) => a[0] === "which" && a[1] === "gh", reply: fail("not found") },
		]);
		const result = await discoverTeams(baseOptions(dir, run));
		expect(result.available).toBe(false);
		expect(result.notes.join(" ")).toContain("gh auth login");
		expect(result.teams).toEqual([]);
	});

	it("explains itself when gh is signed out", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-"));
		const { run } = fakeRunner([
			{ match: (_f, a) => a[0] === "which", reply: ok("/bin/tool") },
			{ match: (_f, a) => a[0] === "auth", reply: fail("not logged in") },
		]);
		const result = await discoverTeams(baseOptions(dir, run));
		expect(result.available).toBe(false);
		expect(result.notes.join(" ")).toContain("not signed in");
	});

	// Discovery is still useful without the CLI; only joining is off.
	it("still lists teams when glayvin is missing, but cannot join", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-"));
		const { run } = fakeRunner([
			{ match: (_f, a) => a[0] === "which" && a[1] === "glayvin", reply: fail("not found") },
			...happyHandlers,
		]);
		const result = await discoverTeams(baseOptions(dir, run));
		expect(result.available).toBe(true);
		expect(result.canJoin).toBe(false);
		expect(result.notes.join(" ")).toContain("glayvin manage teams add");
	});

	// A half-finished union would cache a list missing whole teams.
	it("keeps the previous snapshot when a refresh is rate limited", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-"));
		await discoverTeams(baseOptions(dir, fakeRunner(happyHandlers).run));

		const { run } = fakeRunner([
			{ match: (_f, a) => a[0] === "which", reply: ok("/bin/tool") },
			{ match: (_f, a) => a[0] === "auth", reply: ok("Logged in") },
			{
				match: (_f, a) => a.some((x) => x.includes("/search/code")),
				reply: { stdout: "", stderr: "API rate limit exceeded", code: 1 },
			},
		]);
		const result = await discoverTeams({ ...baseOptions(dir, run), refresh: true });
		expect(result.available).toBe(true);
		expect(result.fromCache).toBe(true);
		expect(result.teams).toHaveLength(1);
		expect(result.notes.join(" ")).toContain("rate limit");
		expect(readCache(dir, "shipt")?.candidates).toHaveLength(1);
	});

	it("fails softly on the very first refresh when there is no snapshot", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-"));
		const { run } = fakeRunner([
			{ match: (_f, a) => a[0] === "which", reply: ok("/bin/tool") },
			{ match: (_f, a) => a[0] === "auth", reply: ok("Logged in") },
			{ match: (_f, a) => a.some((x) => x.includes("/search/code")), reply: fail("could not resolve host") },
		]);
		const result = await discoverTeams(baseOptions(dir, run));
		expect(result.available).toBe(false);
		expect(result.teams).toEqual([]);
		expect(result.notes.join(" ")).toContain("could not resolve host");
	});

	// A repo whose root will not list is not thereby proven innocent or guilty.
	it("keeps a candidate whose root cannot be read, marked uncertain", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-"));
		const { run } = fakeRunner([
			...happyHandlers.slice(0, 3),
			{ match: (_f, a) => a.some((x) => x.includes("contents")), reply: fail("404") },
		]);
		const result = await discoverTeams(baseOptions(dir, run));
		expect(result.teams[0].classification).toBe("uncertain");
		expect(result.teams[0].markers).toEqual([]);
	});

	// The failure this guards: `gh search code` prints `[]` and exits 0 on this org.
	// Treated as an empty match it becomes a confident, wrong "no teams found".
	it("treats an unreadable search reply as a failure, not an empty org", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-"));
		const { run } = fakeRunner([
			{ match: (_f, a) => a[0] === "which", reply: ok("/bin/tool") },
			{ match: (_f, a) => a[0] === "auth", reply: ok("Logged in") },
			{
				match: (_f, a) => a.some((x) => x.includes("/search/code")),
				reply: ok('{"message":"Not Found"}'),
			},
		]);
		const result = await discoverTeams(baseOptions(dir, run));
		expect(result.available).toBe(false);
		const note = result.notes.join(" ");
		expect(note).toContain("could not read the reply");
		expect(note).not.toContain("No repos in shipt");
	});

	// Matching repos while confirming none of them is what a stale classifier looks
	// like. They still render, hedged, so the note explains the hedge.
	it("flags a search that confirmed none of what it matched", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-"));
		const { run } = fakeRunner([
			...happyHandlers.slice(0, 3),
			{
				match: (_f, a) => a.some((x) => x.includes("contents")),
				reply: ok(REAL_ROOTS.locations.join("\n")),
			},
		]);
		const result = await discoverTeams(baseOptions(dir, run));
		expect(result.survey).toMatchObject({ matched: 1, teams: 0, uncertain: 1 });
		expect(result.notes.join(" ")).toContain("could not confirm any of them");
	});

	it("counts what it classified so an empty pane can explain itself", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-"));
		const result = await discoverTeams(
			baseOptions(dir, fakeRunner(happyHandlers).run),
		);
		expect(result.survey).toMatchObject({ matched: 1, teams: 1, uncertain: 0 });
		expect(result.survey?.markers).toContain("copilot-instructions.md");
		// A healthy result should not be nagging about anything.
		expect(result.notes.join(" ")).not.toContain("could not confirm");
	});

	it("keeps the survey when serving from cache", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-"));
		await discoverTeams(baseOptions(dir, fakeRunner(happyHandlers).run));
		const cached = await discoverTeams(
			baseOptions(dir, fakeRunner(happyHandlers).run),
		);
		expect(cached.fromCache).toBe(true);
		expect(cached.survey).toMatchObject({ matched: 1, teams: 1 });
	});

	it("falls back to the default org when the setting is unusable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-"));
		const result = await discoverTeams({
			...baseOptions(dir, fakeRunner(happyHandlers).run),
			org: "not a valid org!",
		});
		expect(result.org).toBe("shipt");
	});

	it("says so plainly when the org has no team repos", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-"));
		const { run } = fakeRunner([
			{ match: (_f, a) => a[0] === "which", reply: ok("/bin/tool") },
			{ match: (_f, a) => a[0] === "auth", reply: ok("Logged in") },
			{ match: (_f, a) => a.some((x) => x.includes("/search/code")), reply: ok("[]") },
		]);
		const result = await discoverTeams(baseOptions(dir, run));
		expect(result.available).toBe(true);
		expect(result.teams).toEqual([]);
		// An empty result has to say what it looked for, or it is indistinguishable
		// from a search that did not work.
		const note = result.notes.join(" ");
		expect(note).toContain("No repos in shipt");
		expect(note).toContain("mcp-config.json");
		expect(note).toContain("copilot-instructions.md");
		expect(result.survey).toMatchObject({ matched: 0, teams: 0, uncertain: 0 });
	});
});

describe("registering a Glayvin team", () => {
	it("hands the work to the glayvin CLI", async () => {
		const calls: string[][] = [];
		await registerGlayvinTeam({
			name: "designos",
			path: "/Users/x/Cosmos/designos",
			run: async (file, args) => {
				calls.push([file, ...args]);
				return { stdout: "Added", stderr: "", code: 0 };
			},
		});
		expect(calls[0]).toEqual([
			"glayvin",
			"manage",
			"teams",
			"add",
			"designos",
			"/Users/x/Cosmos/designos",
		]);
	});

	it("surfaces the CLI's own complaint rather than an exit code", async () => {
		await expect(
			registerGlayvinTeam({
				name: "designos",
				path: "/tmp/designos",
				run: async () => ({ stdout: "", stderr: "Team already exists\nmore", code: 1 }),
			}),
		).rejects.toThrow("Team already exists");
	});
});

describe("reading Glayvin team state", () => {
	const home = (files: Record<string, string>) => {
		const dir = mkdtempSync(join(tmpdir(), "gv-"));
		mkdirSync(join(dir, ".local"), { recursive: true });
		for (const [name, body] of Object.entries(files)) {
			writeFileSync(join(dir, ".local", name), body);
		}
		return dir;
	};

	it("reads disabled team names", () => {
		const dir = home({
			"disabled.json": JSON.stringify({ teams: ["designos", " cosmos-ai "] }),
		});
		expect(readDisabledTeamNames(dir)).toEqual(["designos", "cosmos-ai"]);
	});

	it("treats a missing or malformed disabled.json as nothing disabled", () => {
		expect(readDisabledTeamNames(home({}))).toEqual([]);
		expect(readDisabledTeamNames(home({ "disabled.json": "{" }))).toEqual([]);
		expect(
			readDisabledTeamNames(home({ "disabled.json": JSON.stringify({}) })),
		).toEqual([]);
		expect(readDisabledTeamNames(undefined)).toEqual([]);
	});

	it("reports relative-path teams that readGlayvinTeams drops", () => {
		const dir = home({
			"glayvin.json": JSON.stringify({
				teams: [
					{ name: "absolute", path: "/tmp/absolute" },
					{ name: "relative", path: "./team" },
				],
			}),
		});
		expect(readGlayvinTeams(dir).map((t) => t.name)).toEqual(["absolute"]);
		expect(readRegisteredTeamNames(dir)).toEqual(["absolute", "relative"]);
	});
});

describe("resolving team membership", () => {
	const ctx = (over: Partial<Parameters<typeof resolveMembership>[3]> = {}) => ({
		disabled: [],
		registered: [],
		exists: () => true,
		...over,
	});

	it("matches by the registered name, not the expected path", () => {
		const membership = resolveMembership(
			"designos",
			"/ws/designos",
			[{ name: "designos", path: "/elsewhere/designos" }],
			ctx({ registered: ["designos"] }),
		);
		expect(membership).toMatchObject({
			state: "active",
			path: "/elsewhere/designos",
			elsewhere: true,
		});
	});

	it("falls back to the path when the team was registered under another name", () => {
		const membership = resolveMembership(
			"designos",
			"/ws/designos",
			[{ name: "design-system", path: "/ws/designos" }],
			ctx(),
		);
		expect(membership).toMatchObject({
			name: "design-system",
			state: "active",
			elsewhere: false,
		});
	});

	it("reports a disabled team as registered but not applied", () => {
		const membership = resolveMembership(
			"designos",
			"/ws/designos",
			[{ name: "designos", path: "/ws/designos" }],
			ctx({ disabled: ["designos"] }),
		);
		expect(membership?.state).toBe("disabled");
	});

	it("reports a team whose folder is gone, mirroring the resolver's existsSync", () => {
		const membership = resolveMembership(
			"designos",
			"/ws/designos",
			[{ name: "designos", path: "/ws/designos" }],
			ctx({ exists: () => false }),
		);
		expect(membership?.state).toBe("missing");
	});

	it("prefers disabled over missing, since re-enabling alone would not help", () => {
		const membership = resolveMembership(
			"designos",
			"/ws/designos",
			[{ name: "designos", path: "/ws/designos" }],
			ctx({ disabled: ["designos"], exists: () => false }),
		);
		expect(membership?.state).toBe("disabled");
	});

	it("keeps a relative-path team visible rather than showing it as unjoined", () => {
		const membership = resolveMembership("designos", "/ws/designos", [], {
			disabled: [],
			registered: ["designos"],
			exists: () => true,
		});
		expect(membership).toMatchObject({ state: "unresolved", path: "" });
	});

	it("returns nothing for a repo that was never registered", () => {
		expect(
			resolveMembership("designos", "/ws/designos", [], ctx()),
		).toBeUndefined();
	});
});

describe("toggling a Glayvin team", () => {
	it("enables and disables by the registered name", async () => {
		const calls: string[][] = [];
		const run: CommandRunner = async (file, args) => {
			calls.push([file, ...args]);
			return { code: 0, stdout: "", stderr: "" };
		};
		await setGlayvinTeamEnabled({ name: "designos", enabled: false, run });
		await setGlayvinTeamEnabled({ name: "designos", enabled: true, run });
		expect(calls).toEqual([
			["glayvin", "manage", "teams", "disable", "designos"],
			["glayvin", "manage", "teams", "enable", "designos"],
		]);
	});

	it("surfaces the CLI's own complaint", async () => {
		const run: CommandRunner = async () => ({
			code: 1,
			stdout: "",
			stderr: "Unknown team: designos\nusage: ...",
		});
		await expect(
			setGlayvinTeamEnabled({ name: "designos", enabled: true, run }),
		).rejects.toThrow("Unknown team: designos");
	});
});

describe("pointing the glayvin CLI at the right home", () => {
	it("passes GLAYVIN_HOME so writes land where the pane reads", async () => {
		const run = createCommandRunner({ PATH: "/usr/bin:/bin" }, "/tmp/fake-home");
		const result = await run(
			"/usr/bin/env",
			["sh", "-c", "printf %s \"$GLAYVIN_HOME\""],
			5000,
		);
		expect(result.stdout).toBe("/tmp/fake-home");
	});

	it("leaves GLAYVIN_HOME alone when no home is known", async () => {
		const run = createCommandRunner({ PATH: "/usr/bin:/bin" });
		const result = await run(
			"/usr/bin/env",
			["sh", "-c", "printf %s \"${GLAYVIN_HOME:-unset}\""],
			5000,
		);
		expect(result.stdout).toBe("unset");
	});
});

describe("team precedence", () => {
	const teams = [
		{ name: "first", path: "/ws/first" },
		{ name: "second", path: "/ws/second" },
		{ name: "third", path: "/ws/third" },
	];
	const ctx = (over = {}) => ({
		disabled: [],
		registered: teams.map((t) => t.name),
		exists: () => true,
		...over,
	});

	it("ranks in registration order, not alphabetically", () => {
		expect([...effectivePrecedence(teams, ctx()).entries()]).toEqual([
			["first", 1],
			["second", 2],
			["third", 3],
		]);
	});

	// readEnabledTeamDirs drops these before the resolver ever sees them.
	it("gives a disabled team no slot and closes the gap behind it", () => {
		const ranks = effectivePrecedence(teams, ctx({ disabled: ["first"] }));
		expect(ranks.get("first")).toBeUndefined();
		expect(ranks.get("second")).toBe(1);
		expect(ranks.get("third")).toBe(2);
	});

	it("gives a team whose folder is gone no slot either", () => {
		const ranks = effectivePrecedence(
			teams,
			ctx({ exists: (p: string) => p !== "/ws/second" }),
		);
		expect(ranks.get("first")).toBe(1);
		expect(ranks.get("second")).toBeUndefined();
		expect(ranks.get("third")).toBe(2);
	});

	it("carries the rank onto an active membership", () => {
		const membership = resolveMembership("second", "/ws/second", teams, ctx());
		expect(membership).toMatchObject({ state: "active", precedence: 2 });
	});

	it("leaves a disabled team unranked, since it is not in the order at all", () => {
		const membership = resolveMembership(
			"second",
			"/ws/second",
			teams,
			ctx({ disabled: ["second"] }),
		);
		expect(membership?.state).toBe("disabled");
		expect(membership?.precedence).toBeUndefined();
	});

	it("leaves a relative-path team unranked, its position depending on cwd", () => {
		const membership = resolveMembership("ghost", "/ws/ghost", teams, {
			disabled: [],
			registered: ["ghost"],
			exists: () => true,
		});
		expect(membership).toMatchObject({ state: "unresolved" });
		expect(membership?.precedence).toBeUndefined();
	});

	it("a newly appended team outranks every existing one", () => {
		const after = [...teams, { name: "joined", path: "/ws/joined" }];
		const ranks = effectivePrecedence(after, {
			disabled: [],
			registered: after.map((t) => t.name),
			exists: () => true,
		});
		expect(ranks.get("joined")).toBe(4);
		expect(Math.max(...ranks.values())).toBe(ranks.get("joined"));
	});
});
