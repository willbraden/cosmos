import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCosmosContext } from "./lib/context";

export default function cosmosCommands(pi: ExtensionAPI) {
	pi.registerCommand("cosmos-repos", {
		description: "List sibling repositories in the current Cosmos workspace",
		handler: async (_args, ctx) => {
			const context = resolveCosmosContext(ctx.cwd);
			const repos = listRepos(context.workspaceRoot);
			ctx.ui.notify(
				repos.length > 0
					? `Cosmos repos: ${repos.join(", ")}`
					: `No repositories found under ${context.workspaceRoot}`,
				repos.length > 0 ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("cosmos-open", {
		description: "Resolve a repo name to its expected ~/Cosmos/<repo> location",
		handler: async (args, ctx) => {
			const repo = args.trim();
			if (!repo) {
				ctx.ui.notify("Usage: /cosmos-open <repo>", "warning");
				return;
			}
			const context = resolveCosmosContext(ctx.cwd);
			const repoPath = join(context.workspaceRoot, repo);
			ctx.ui.notify(
				existsSync(repoPath)
					? `${repo} → ${repoPath}`
					: `${repo} is missing at ${repoPath}`,
				existsSync(repoPath) ? "info" : "warning",
			);
		},
	});
}

function listRepos(workspaceRoot: string): string[] {
	try {
		return readdirSync(workspaceRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(join(workspaceRoot, entry.name, ".git")))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}
