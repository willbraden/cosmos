import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultWorkspaceRoot, resolveCosmosContext } from "./lib/context";

const FILE_MUTATION_TOOLS = new Set(["edit", "write"]);

export default function cosmosGuardrails(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		const context = resolveCosmosContext();
		event.systemPromptOptions.sections.cosmos_guardrails = [
			"Cosmos guardrails:",
			`- Prefer staying inside the active workspace root (${context.workspaceRoot}).`,
			"- Do not modify files outside the active repo or workspace unless the user explicitly asks.",
			"- Surface missing repos or missing instruction files as blockers instead of guessing.",
		].join("\n");
	});

	pi.on("tool_call", async (event) => {
		if (!FILE_MUTATION_TOOLS.has(event.toolName)) return undefined;
		const context = resolveCosmosContext();
		const workspaceRoot = context.workspaceRoot || defaultWorkspaceRoot();
		const inputPath = readInputPath(event.input);
		if (!inputPath) return undefined;
		const absolutePath = toAbsolutePath(inputPath, context.cwd);
		if (!absolutePath.startsWith(ensureTrailingSlash(workspaceRoot))) {
			return {
				block: true,
				reason: `Cosmos blocked ${event.toolName} because ${absolutePath} is outside the workspace root ${workspaceRoot}. Ask the user before retrying outside the workspace.`,
			};
		}
		return undefined;
	});
}

function readInputPath(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const value = (input as Record<string, unknown>).path;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toAbsolutePath(path: string, cwd: string): string {
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function ensureTrailingSlash(path: string): string {
	return path.endsWith("/") ? path : `${path}/`;
}
