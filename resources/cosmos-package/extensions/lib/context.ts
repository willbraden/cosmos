import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const INSTRUCTION_FILES = [
	"copilot-instructions.md",
	join(".github", "copilot-instructions.md"),
] as const;
const SKILL_DIRS = [
	"skills",
	join(".github", "skills"),
	join(".agents", "skills"),
] as const;
const GLAYVIN_STATUS_RELATIVE = join(".local", "glayvin-status.json");

export interface DisabledConfig {
	agents: string[];
	skills: string[];
	mcpServers: string[];
}

export interface InstructionSource {
	label: string;
	path: string;
}

export interface GlayvinContext {
	home?: string;
	instructionSources: InstructionSource[];
	skillPaths: string[];
}

export interface CosmosRepoContext {
	cwd: string;
	workspaceRoot: string;
	repoRoot?: string;
	repoName?: string;
	instructionsPath?: string;
	disabledPath?: string;
	disabled: DisabledConfig;
	skillPaths: string[];
	glayvin: GlayvinContext;
}

const EMPTY_DISABLED: DisabledConfig = {
	agents: [],
	skills: [],
	mcpServers: [],
};

export function defaultWorkspaceRoot(): string {
	return process.env.COSMOS_WORKSPACE_ROOT || join(homedir(), "Cosmos");
}

export function defaultGlayvinHome(): string {
	return process.env.GLAYVIN_HOME || join(homedir(), ".glayvin");
}

export function readTextIfExists(path: string | undefined): string | undefined {
	if (!path || !existsSync(path)) return undefined;
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export function resolveCosmosContext(cwd = process.cwd()): CosmosRepoContext {
	const absoluteCwd = resolve(cwd);
	const workspaceRoot = defaultWorkspaceRoot();
	const repoRoot = findRepoRoot(absoluteCwd);
	const inferredWorkspaceRoot = repoRoot ? dirname(repoRoot) : workspaceRoot;
	const disabledPath = repoRoot ? join(repoRoot, "disabled.json") : undefined;
	const disabled = readDisabledConfig(disabledPath);
	const repoSkillPaths = repoRoot
		? discoverSkillPaths(repoRoot, disabled.skills)
		: [];
	const glayvin = resolveGlayvinContext(disabled.skills);
	return {
		cwd: absoluteCwd,
		workspaceRoot: inferredWorkspaceRoot,
		repoRoot,
		repoName: repoRoot ? basename(repoRoot) : undefined,
		instructionsPath: repoRoot ? findInstructionsPath(repoRoot) : undefined,
		disabledPath,
		disabled,
		skillPaths: [...new Set([...glayvin.skillPaths, ...repoSkillPaths])].sort(),
		glayvin,
	};
}

export function summarizeContext(context: CosmosRepoContext): string[] {
	const lines = [`cwd: ${context.cwd}`];
	if (!context.repoRoot) {
		lines.push("repo: not detected");
		lines.push(`workspace root: ${context.workspaceRoot}`);
		if (context.glayvin.instructionSources.length > 0)
			lines.push(
				`glayvin instructions: ${context.glayvin.instructionSources.length}`,
			);
		if (context.glayvin.skillPaths.length > 0)
			lines.push(`glayvin skills: ${context.glayvin.skillPaths.length}`);
		return lines;
	}
	lines.push(`repo: ${context.repoName}`);
	lines.push(`repo root: ${context.repoRoot}`);
	lines.push(`instructions: ${context.instructionsPath ?? "missing"}`);
	lines.push(`skills: ${context.skillPaths.length}`);
	if (context.glayvin.instructionSources.length > 0)
		lines.push(
			`glayvin instructions: ${context.glayvin.instructionSources.length}`,
		);
	if (context.glayvin.skillPaths.length > 0)
		lines.push(`glayvin skills: ${context.glayvin.skillPaths.length}`);
	if (context.disabled.skills.length > 0)
		lines.push(`disabled skills: ${context.disabled.skills.join(", ")}`);
	return lines;
}

function resolveGlayvinContext(disabledSkills: string[]): GlayvinContext {
	const home = defaultGlayvinHome();
	if (!existsSync(join(home, GLAYVIN_STATUS_RELATIVE))) {
		return {
			home: existsSync(home) ? home : undefined,
			instructionSources: [],
			skillPaths: [],
		};
	}

	const status = readJson(join(home, GLAYVIN_STATUS_RELATIVE));
	const sources: InstructionSource[] = [];
	const files = (status?.config as Record<string, unknown> | undefined)?.files as
		| Record<string, unknown>
		| undefined;
	for (const [key, label] of [
		["shared_instructions", "Glayvin shared instructions"],
		["personal_instructions", "Glayvin personal instructions"],
	] as const) {
		const path = typeof files?.[key] === "string" ? files[key] : undefined;
		if (path && existsSync(path)) sources.push({ label, path });
	}

	const teams = Array.isArray(
		(status?.config as Record<string, unknown> | undefined)?.teams,
	)
		? (((status?.config as Record<string, unknown>).teams as unknown[]) ?? [])
		: [];
	const teamRoots = teams
		.map((entry) => {
			if (!entry || typeof entry !== "object") return undefined;
			const path = (entry as Record<string, unknown>).path;
			const name = (entry as Record<string, unknown>).name;
			return typeof path === "string" && path
				? { path, name: typeof name === "string" ? name : basename(path) }
				: undefined;
		})
		.filter((entry): entry is { path: string; name: string } => !!entry);
	for (const team of teamRoots) {
		const instructionsPath = findInstructionsPath(team.path);
		if (instructionsPath)
			sources.push({
				label: `${team.name} team instructions`,
				path: instructionsPath,
			});
	}

	const skillPaths = [
		...discoverSkillPaths(home, disabledSkills),
		...teamRoots.flatMap((team) => discoverSkillPaths(team.path, disabledSkills)),
	];
	return {
		home,
		instructionSources: dedupeInstructionSources(sources),
		skillPaths: [...new Set(skillPaths)].sort(),
	};
}

function dedupeInstructionSources(
	sources: InstructionSource[],
): InstructionSource[] {
	const seen = new Set<string>();
	const output: InstructionSource[] = [];
	for (const source of sources) {
		const resolvedPath = resolve(source.path);
		if (seen.has(resolvedPath)) continue;
		seen.add(resolvedPath);
		output.push({ ...source, path: resolvedPath });
	}
	return output;
}

function findRepoRoot(start: string): string | undefined {
	let current = start;
	for (;;) {
		if (findInstructionsPath(current) || hasSkillDirectory(current))
			return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function findInstructionsPath(root: string): string | undefined {
	for (const relativePath of INSTRUCTION_FILES) {
		const candidate = join(root, relativePath);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function hasSkillDirectory(root: string): boolean {
	return SKILL_DIRS.some((relativePath) => existsSync(join(root, relativePath)));
}

function readDisabledConfig(path: string | undefined): DisabledConfig {
	if (!path || !existsSync(path)) return EMPTY_DISABLED;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Record<
			string,
			unknown
		>;
		return {
			agents: toStringArray(value.agents),
			skills: toStringArray(value.skills),
			mcpServers: toStringArray(value.mcpServers),
		};
	} catch {
		return EMPTY_DISABLED;
	}
}

function discoverSkillPaths(root: string, disabledSkills: string[]): string[] {
	const disabled = new Set(disabledSkills);
	const output: string[] = [];
	for (const skillsDir of SKILL_DIRS) {
		const absoluteDir = join(root, skillsDir);
		if (!existsSync(absoluteDir)) continue;
		for (const entry of safeReadDir(absoluteDir)) {
			const skillDir = join(absoluteDir, entry);
			const skillFile = join(skillDir, "SKILL.md");
			if (!existsSync(skillFile) || disabled.has(entry)) continue;
			output.push(skillFile);
		}
	}
	return output.sort();
}

function safeReadDir(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

function toStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return value && typeof value === "object"
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}
