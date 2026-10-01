import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	DiscoveredTeam,
	TeamDiscovery,
	TeamSurvey,
	TeamMarker,
	TeamMembership,
} from "../shared/ipc";
import {
	type GlayvinTeam,
	readDisabledTeamNames,
	readRegisteredTeamNames,
} from "./glayvin-runtime";
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
/**
 * `glayvin` resolves its own home from $GLAYVIN_HOME first, so pass the home Cosmos is
 * reading. Without it a non-default glayvinHomePath registers into a different config
 * than the pane displays, and the join looks like it silently failed.
 */
export function createCommandRunner(
	env: NodeJS.ProcessEnv,
	glayvinHome?: string,
): CommandRunner {
	return (file, args, timeoutMs) =>
		new Promise((resolve) => {
			execFile(
				file,
				args,
				{
					timeout: timeoutMs,
					maxBuffer: 20 * 1024 * 1024,
					env: {
						...env,
						...(glayvinHome ? { GLAYVIN_HOME: glayvinHome } : {}),
						GH_PROMPT_DISABLED: "1",
						GH_PAGER: "cat",
						NO_COLOR: "1",
					},
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

export interface SearchReply {
	hits: SearchHit[];
	/**
	 * False when the reply was not a JSON array at all. `gh` exits 0 in that case, so
	 * without this an output-format change is indistinguishable from an org with no
	 * teams — which is exactly how `gh search code` silently returns nothing here.
	 */
	readable: boolean;
}

/** Parse one search reply, keeping only root-level hits in valid, non-forked repos. */
export function parseSearchHits(stdout: string): SearchReply {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return { hits: [], readable: false };
	}
	if (!Array.isArray(parsed)) return { hits: [], readable: false };
	const hits = parsed.flatMap((entry) => {
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
	return { hits, readable: true };
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

export interface MembershipContext {
	/** Names from disabled.json. */
	disabled: readonly string[];
	/** Every registered name, including those with relative paths. */
	registered: readonly string[];
	/** Injected so tests don't need real directories. */
	exists?: (path: string) => boolean;
}

/**
 * Rank of each team Glayvin actually applies, in glayvin.json order. Disabled and
 * missing teams are filtered out by `readEnabledTeamDirs`, so they occupy no slot
 * and shift nothing below them.
 */
export function effectivePrecedence(
	teams: readonly GlayvinTeam[],
	context: MembershipContext,
): Map<string, number> {
	const exists = context.exists ?? existsSync;
	const ranks = new Map<string, number>();
	let rank = 0;
	for (const team of teams) {
		if (context.disabled.includes(team.name) || !exists(team.path)) continue;
		ranks.set(team.name, ++rank);
	}
	return ranks;
}

/**
 * Which of the resolver's four conditions a registered team satisfies. Matching is
 * by name first because that is Glayvin's key (`manage teams add <name> <path>`,
 * and disabled.json keys on it too); path is the fallback that catches a team
 * registered under some other name.
 */
export function resolveMembership(
	repo: string,
	localPath: string,
	teams: readonly GlayvinTeam[],
	context: MembershipContext,
	precedence?: ReadonlyMap<string, number>,
): TeamMembership | undefined {
	const exists = context.exists ?? existsSync;
	const entry =
		teams.find((team) => team.name === repo) ??
		teams.find((team) => team.path === localPath);

	if (!entry) {
		// Registered under a relative path, so readGlayvinTeams dropped it. It is
		// still a membership; we just can't say where it points.
		return context.registered.includes(repo)
			? { name: repo, path: "", state: "unresolved", elsewhere: false }
			: undefined;
	}

	const disabled = context.disabled.includes(entry.name);
	return {
		name: entry.name,
		path: entry.path,
		state: disabled ? "disabled" : exists(entry.path) ? "active" : "missing",
		elsewhere: entry.path !== localPath,
		precedence: (precedence ?? effectivePrecedence(teams, context)).get(
			entry.name,
		),
	};
}


/**
 * Count what the search produced, so an empty or hedged pane can say why it looks
 * that way rather than leaving the reader to guess whether it worked.
 */
function surveyOf(candidates: readonly TeamCandidate[]): TeamSurvey {
	const count = (kind: TeamCandidate["classification"]) =>
		candidates.filter((c) => c.classification === kind).length;
	return {
		markers: [...SEARCH_MARKERS],
		matched: candidates.length,
		teams: count("team"),
		uncertain: count("uncertain"),
	};
}

function decorate(
	candidates: readonly TeamCandidate[],
	org: string,
	workspaceRootPath: string,
	teams: readonly GlayvinTeam[],
	membershipContext: MembershipContext,
): DiscoveredTeam[] {
	const precedence = effectivePrecedence(teams, membershipContext);
	return candidates.map((candidate) => {
		const localPath = join(workspaceRootPath, candidate.repo);
		const cloned = existsSync(localPath);
		return {
			...candidate,
			org,
			nameWithOwner: `${org}/${candidate.repo}`,
			cloneUrl: coreRepoCloneUrl(candidate.repo, org),
			membership: resolveMembership(
				candidate.repo,
				localPath,
				teams,
				membershipContext,
				precedence,
			),
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
	const membershipContext: MembershipContext = {
		disabled: readDisabledTeamNames(glayvinHome),
		registered: readRegisteredTeamNames(glayvinHome),
	};
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
		survey: cached ? surveyOf(cached.candidates) : undefined,
		available: !!cached,
		teams: cached
			? decorate(
					cached.candidates,
					org,
					workspaceRootPath,
					teams,
					membershipContext,
				)
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
		const reply = result.code === 0 ? parseSearchHits(result.stdout) : undefined;
		if (!reply?.readable) {
			// A partial union would cache a list that is missing whole teams, so stop here
			// and keep whatever complete snapshot already exists. An unreadable reply counts
			// as a failure too: `gh` exits 0 while printing something we cannot use, and
			// treating that as "no results" is how a broken search poses as an empty org.
			const note =
				result.code === 0
					? `Cosmos searched ${org} for \`${marker}\` but could not read the reply from the GitHub CLI. This usually means \`gh\` changed its output format; \`gh --version\` and \`gh api /search/code\` are worth a look.`
					: isRateLimited(result)
						? "GitHub's search rate limit is exhausted. It resets about once a minute — try refreshing again shortly."
						: `Cosmos could not search ${org} for teams. ${firstLine(result.stderr) || "The GitHub CLI reported an error."}`;
			return cached
				? serveCache([note])
				: { ...base, available: false, teams: [], notes: [note, ...joinNote], fromCache: false };
		}
		batches.push(reply.hits);
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
	const decorated = decorate(
		candidates,
		org,
		workspaceRootPath,
		teams,
		membershipContext,
	);
	const notes = [...joinNote];
	const survey = surveyOf(candidates);
	if (survey.matched === 0) {
		notes.push(
			`No repos in ${org} contain ${listMarkers()} at their root, so there was nothing to check. If your team keeps its layer somewhere else, clone it and run \`glayvin manage teams add <name> <path>\`.`,
		);
	} else if (survey.teams === 0) {
		// Matching repos but confirming none of them is the shape of a stale classifier.
		// They still appear, under "Might be teams", so this explains why nothing made
		// it into the confident list rather than leaving the hedge unexplained.
		notes.push(
			`Cosmos matched ${survey.matched} ${survey.matched === 1 ? "repo" : "repos"} in ${org} but could not confirm any of them as a team layer, so they are all listed as uncertain below. A team layer normally has \`packs\`, \`profiles\`, \`agents\` or \`skills\` at its root.`,
		);
	}
	return {
		...base,
		survey,
		available: true,
		teams: decorated,
		notes,
		fetchedAt,
		fromCache: false,
	};
}

function listMarkers(): string {
	const names = SEARCH_MARKERS.map((name) => `\`${name}\``);
	return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
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

/** Toggling is keyed by the registered name, which need not match the repo name. */
export async function setGlayvinTeamEnabled(options: {
	name: string;
	enabled: boolean;
	run: CommandRunner;
}): Promise<void> {
	const action = options.enabled ? "enable" : "disable";
	const result = await options.run(
		"glayvin",
		["manage", "teams", action, options.name],
		JOIN_TIMEOUT_MS,
	);
	if (result.code !== 0) {
		throw new Error(
			firstLine(result.stderr) ||
				firstLine(result.stdout) ||
				`glayvin manage teams ${action} exited with code ${result.code}.`,
		);
	}
}


export { GH_TIMEOUT_MS, JOIN_TIMEOUT_MS, LAYER_MARKERS, PRODUCT_MARKERS, SEARCH_MARKERS };
