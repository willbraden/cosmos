import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DiscoveredTeam, TeamDiscovery, TeamMarker } from "../shared/ipc";
import type { GlayvinTeam } from "./glayvin-runtime";
import { coreRepoCloneUrl, isValidRepoName, normalizeOrg } from "./workspace";

/**
 * Files and directories that make a repo look like a Glayvin team layer. Measured against
 * the real `shipt` org: genuine layers match four or more of these, while product repos
 * that merely carry one of the same filenames match exactly one.
 */
const LAYER_MARKERS = [
	"copilot-instructions.md",
	"instructions",
	"packs",
	"profiles",
	"agents",
	"skills",
	"disabled.json",
	"mcp-config.json",
	"team-config.json",
	"cosmos-repos.json",
] as const;

/** Signals of a deployable service rather than a config layer. */
const PRODUCT_MARKERS = [
	"go.mod",
	"go.sum",
	"Dockerfile",
	"docker-compose.yml",
	"docker-compose.yaml",
	"Makefile",
	"cmd",
	"internal",
	"package.json",
	"pyproject.toml",
	"terraform",
	"migrations",
] as const;

/** Filenames whose presence at a repo root suggests a team layer worth listing. */
const SEARCH_MARKERS = [
	"mcp-config.json",
	"disabled.json",
	"copilot-instructions.md",
] as const;

/** Joining a template produces a copy of nothing, so it is listed but not offered. */
const TEMPLATE_REPOS = new Set(["glayvin-team-template"]);

const CACHE_FILE = "team-discovery.json";
const CACHE_VERSION = 1;
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** One `gh api` call at a time is plenty; the searches are the rate-limited part. */
const CONTENTS_CONCURRENCY = 5;
const GH_TIMEOUT_MS = 30_000;
const JOIN_TIMEOUT_MS = 60_000;

export interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
}

/** Injected so the discovery logic stays testable without spawning anything. */
export type CommandRunner = (
	file: string,
	args: string[],
	timeoutMs: number,
) => Promise<CommandResult>;

/** The half of a team's description that comes from the network and is worth caching. */
export interface TeamCandidate {
	repo: string;
	description?: string;
	htmlUrl: string;
	markers: TeamMarker[];
	classification: DiscoveredTeam["classification"];
	curatesRepos: boolean;
}

interface CacheFile {
	version: number;
	org: string;
	fetchedAt: number;
	candidates: TeamCandidate[];
}

/**
 * Bind a runner to the user's login-shell environment. A Finder-launched app inherits a
 * minimal PATH, so `gh` and `glayvin` are only findable through the resolved env.
 */
export function createCommandRunner(env: NodeJS.ProcessEnv): CommandRunner {
	return (file, args, timeoutMs) =>
		new Promise((resolve) => {
			execFile(
				file,
				args,
				{
					timeout: timeoutMs,
					maxBuffer: 20 * 1024 * 1024,
					env: { ...env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", NO_COLOR: "1" },
				},
				(error, stdout, stderr) => {
					const raw = (error as { code?: unknown } | null)?.code;
					const code = !error ? 0 : typeof raw === "number" ? raw : 1;
					resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
				},
			);
		});
}

export function searchQuery(org: string, filename: string): string {
	return `org:${org} filename:${filename} path:/`;
}

export function searchArgs(org: string, filename: string): string[] {
	const q = encodeURIComponent(searchQuery(org, filename));
	return [
		"api",
		"-H",
		"Accept: application/vnd.github+json",
		`/search/code?q=${q}&per_page=100`,
		"--jq",
		// Slim the reply at the gh boundary: the raw item carries a ~4KB repository object.
		"[.items[] | {path, repo: .repository.name, description: .repository.description, htmlUrl: .repository.html_url, fork: .repository.fork}]",
	];
}

export function contentsArgs(org: string, repo: string): string[] {
	return [
		"api",
		`repos/${org}/${repo}/contents/`,
		"--jq",
		"[.[].name] | join(\"\\n\")",
	];
}

export interface SearchHit {
	repo: string;
	description?: string;
	htmlUrl: string;
}

/**
 * GitHub's placeholder descriptions carry no information, so they are dropped rather
 * than rendered as if someone wrote them.
 */
function cleanDescription(value: unknown, repo: string): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed === `Default description for ${repo}`) return undefined;
	return trimmed;
}

/** Parse one search reply, keeping only root-level hits in valid, non-forked repos. */
export function parseSearchHits(stdout: string): SearchHit[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.flatMap((entry) => {
		const raw = entry as Record<string, unknown>;
		const repo = typeof raw.repo === "string" ? raw.repo : "";
		const path = typeof raw.path === "string" ? raw.path : "";
		if (!isValidRepoName(repo) || path.includes("/") || raw.fork === true) return [];
		return [
			{
				repo,
				description: cleanDescription(raw.description, repo),
				htmlUrl:
					typeof raw.htmlUrl === "string" && raw.htmlUrl.startsWith("https://")
						? raw.htmlUrl
						: `https://github.com/${repo}`,
			},
		];
	});
}

/** Union hits from every marker search, keeping the first description seen per repo. */
export function unionSearchHits(batches: readonly SearchHit[][]): SearchHit[] {
	const byRepo = new Map<string, SearchHit>();
	for (const batch of batches) {
		for (const hit of batch) {
			const existing = byRepo.get(hit.repo);
			if (!existing) byRepo.set(hit.repo, hit);
			else if (!existing.description && hit.description) {
				byRepo.set(hit.repo, { ...existing, description: hit.description });
			}
		}
	}
	return [...byRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

export function parseRootNames(stdout: string): string[] {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * Classify a repo from its root listing.
 *
 * Three or more layer markers is decisive on its own, because a real layer that also ships
 * a binary (glayvin-incident-management has `agents` and `skills` alongside `go.mod` and
 * `cmd`) must not be vetoed by its product files. Below that, any product signal is
 * disqualifying. Everything uncertain stays listed and joinable so a misread is recoverable.
 */
export function classifyRoot(
	repo: string,
	rootNames: readonly string[],
): Pick<TeamCandidate, "markers" | "classification" | "curatesRepos"> {
	const present = new Set(rootNames);
	const markers: TeamMarker[] = [
		...LAYER_MARKERS.filter((name) => present.has(name)).map(
			(name): TeamMarker => ({ name, kind: "layer" }),
		),
		...PRODUCT_MARKERS.filter((name) => present.has(name)).map(
			(name): TeamMarker => ({ name, kind: "product" }),
		),
	];
	const layers = markers.filter((marker) => marker.kind === "layer").length;
	const products = markers.length - layers;
	const isLayer = layers >= 3 || (layers >= 2 && products === 0);
	return {
		markers,
		classification: TEMPLATE_REPOS.has(repo)
			? "template"
			: isLayer
				? "team"
				: "uncertain",
		curatesRepos: present.has("cosmos-repos.json"),
	};
}

export function isRateLimited(result: CommandResult): boolean {
	const text = `${result.stdout}\n${result.stderr}`;
	return /rate limit|secondary rate|\b(?:403|429)\b/i.test(text);
}

/** Run tasks with a bounded number in flight, preserving input order in the output. */
async function mapLimited<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await task(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}

function cachePath(userDataDir: string): string {
	return join(userDataDir, CACHE_FILE);
}

export function readCache(
	userDataDir: string,
	org: string,
): { fetchedAt: number; candidates: TeamCandidate[] } | undefined {
	try {
		const parsed = JSON.parse(
			readFileSync(cachePath(userDataDir), "utf8"),
		) as CacheFile;
		if (
			parsed?.version !== CACHE_VERSION ||
			parsed.org !== org ||
			typeof parsed.fetchedAt !== "number" ||
			!Array.isArray(parsed.candidates)
		) {
			return undefined;
		}
		return { fetchedAt: parsed.fetchedAt, candidates: parsed.candidates };
	} catch {
		return undefined;
	}
}

export function writeCache(
	userDataDir: string,
	org: string,
	candidates: readonly TeamCandidate[],
	fetchedAt: number,
): void {
	const target = cachePath(userDataDir);
	const payload: CacheFile = {
		version: CACHE_VERSION,
		org,
		fetchedAt,
		candidates: [...candidates],
	};
	try {
		mkdirSync(dirname(target), { recursive: true });
		const staging = `${target}.tmp-${process.pid}`;
		writeFileSync(staging, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		renameSync(staging, target);
	} catch {
		// A cache that cannot be written is a slower pane, not a broken one.
	}
}

export interface DiscoverOptions {
	org: string | undefined;
	userDataDir: string;
	workspaceRootPath: string;
	glayvinHome: string | undefined;
	teams: readonly GlayvinTeam[];
	refresh?: boolean;
	run: CommandRunner;
	now?: () => number;
}

/** Local state is always read live, so joining takes effect without refetching. */
function decorate(
	candidates: readonly TeamCandidate[],
	org: string,
	workspaceRootPath: string,
	teams: readonly GlayvinTeam[],
): DiscoveredTeam[] {
	const joinedByPath = new Map(teams.map((team) => [team.path, team]));
	return candidates.map((candidate) => {
		const localPath = join(workspaceRootPath, candidate.repo);
		const joined = joinedByPath.get(localPath);
		const cloned = existsSync(localPath);
		return {
			...candidate,
			org,
			nameWithOwner: `${org}/${candidate.repo}`,
			cloneUrl: coreRepoCloneUrl(candidate.repo, org),
			joined: !!joined,
			joinedPath: joined?.path,
			clonedPath: cloned ? localPath : undefined,
		};
	});
}

async function whichCommand(
	run: CommandRunner,
	file: string,
): Promise<boolean> {
	const result = await run("/usr/bin/env", ["which", file], 5000);
	return result.code === 0 && result.stdout.trim().length > 0;
}

export async function discoverTeams(
	options: DiscoverOptions,
): Promise<TeamDiscovery> {
	const { run } = options;
	const now = options.now ?? Date.now;
	const org = normalizeOrg(options.org);
	const { userDataDir, workspaceRootPath, glayvinHome, teams } = options;
	const cached = readCache(userDataDir, org);
	const canJoin = await whichCommand(run, "glayvin");
	const base = {
		org,
		workspaceRootPath,
		glayvinHome,
		canJoin,
	};
	const joinNote = canJoin
		? []
		: [
				"The glayvin command is not on your PATH, so Cosmos cannot register a team for you. Install Glayvin, or clone a repo and run `glayvin manage teams add <name> <path>` yourself.",
			];

	const serveCache = (notes: string[]): TeamDiscovery => ({
		...base,
		available: !!cached,
		teams: cached
			? decorate(cached.candidates, org, workspaceRootPath, teams)
			: [],
		notes: [...notes, ...joinNote],
		fetchedAt: cached?.fetchedAt,
		fromCache: true,
	});

	// Opening Settings should not fire ~20 API calls, so only a first run or an explicit
	// refresh goes to the network.
	if (cached && !options.refresh) return serveCache([]);

	if (!(await whichCommand(run, "gh"))) {
		return {
			...base,
			available: false,
			teams: [],
			notes: [
				"Cosmos finds teams with the GitHub CLI, which is not on your PATH. Install it with `brew install gh`, then run `gh auth login`.",
				...joinNote,
			],
			fromCache: false,
		};
	}

	const auth = await run("gh", ["auth", "status"], GH_TIMEOUT_MS);
	if (auth.code !== 0) {
		return {
			...base,
			available: false,
			teams: [],
			notes: [
				"The GitHub CLI is not signed in. Run `gh auth login` in a terminal, then refresh.",
				...joinNote,
			],
			fromCache: false,
		};
	}

	const batches: SearchHit[][] = [];
	for (const marker of SEARCH_MARKERS) {
		const result = await run("gh", searchArgs(org, marker), GH_TIMEOUT_MS);
		if (result.code !== 0) {
			// A partial union would cache a list that is missing whole teams, so stop here
			// and keep whatever complete snapshot already exists.
			const note = isRateLimited(result)
				? "GitHub's search rate limit is exhausted. It resets about once a minute — try refreshing again shortly."
				: `Cosmos could not search ${org} for teams. ${firstLine(result.stderr) || "The GitHub CLI reported an error."}`;
			return cached
				? serveCache([note])
				: { ...base, available: false, teams: [], notes: [note, ...joinNote], fromCache: false };
		}
		batches.push(parseSearchHits(result.stdout));
	}

	const hits = unionSearchHits(batches);
	const candidates = await mapLimited(hits, CONTENTS_CONCURRENCY, async (hit) => {
		const result = await run("gh", contentsArgs(org, hit.repo), GH_TIMEOUT_MS);
		const classified =
			result.code === 0
				? classifyRoot(hit.repo, parseRootNames(result.stdout))
				: // An unreadable root is not evidence against the repo, so it stays listed.
					{ markers: [], classification: "uncertain" as const, curatesRepos: false };
		return { ...hit, ...classified } satisfies TeamCandidate;
	});

	const fetchedAt = now();
	writeCache(userDataDir, org, candidates, fetchedAt);
	const decorated = decorate(candidates, org, workspaceRootPath, teams);
	const notes = [...joinNote];
	if (decorated.length === 0) {
		notes.push(
			`No team config repos turned up in ${org}. If your team keeps its layer somewhere else, clone it and run \`glayvin manage teams add <name> <path>\`.`,
		);
	}
	return {
		...base,
		available: true,
		teams: decorated,
		notes,
		fetchedAt,
		fromCache: false,
	};
}

function firstLine(text: string): string {
	return text.trim().split("\n")[0]?.trim() ?? "";
}

export interface RegisterTeamOptions {
	name: string;
	path: string;
	run: CommandRunner;
}

/**
 * Hand registration to Glayvin rather than editing `glayvin.json`, so Cosmos never has to
 * track the shape of a file it does not own.
 */
export async function registerGlayvinTeam(
	options: RegisterTeamOptions,
): Promise<void> {
	const result = await options.run(
		"glayvin",
		["manage", "teams", "add", options.name, options.path],
		JOIN_TIMEOUT_MS,
	);
	if (result.code !== 0) {
		throw new Error(
			firstLine(result.stderr) ||
				firstLine(result.stdout) ||
				`glayvin manage teams add exited with code ${result.code}.`,
		);
	}
}

export { GH_TIMEOUT_MS, JOIN_TIMEOUT_MS, LAYER_MARKERS, PRODUCT_MARKERS, SEARCH_MARKERS };
