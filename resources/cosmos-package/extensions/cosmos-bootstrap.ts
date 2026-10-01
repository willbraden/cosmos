import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { summarizeContext, resolveCosmosContext } from "./lib/context";

export default function cosmosBootstrap(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const context = resolveCosmosContext(ctx.cwd);
		const status = context.repoName
			? `Cosmos: ${context.repoName}`
			: "Cosmos: no repo detected";
		ctx.ui.setStatus("cosmos-repo", status);
	});

	pi.registerCommand("cosmos-doctor", {
		description:
			"Check whether the current session is inside a Cosmos repo with instructions and skills available",
		handler: async (_args, ctx) => {
			const context = resolveCosmosContext(ctx.cwd);
			const problems: string[] = [];
			if (!context.repoRoot) problems.push("No Cosmos repo root detected from the current working directory.");
			if (context.repoRoot && !context.instructionsPath)
				problems.push("Repo detected, but no copilot-instructions.md file was found.");
			if (context.repoRoot && context.skillPaths.length === 0)
				problems.push("Repo detected, but no SKILL.md files were found.");
			ctx.ui.notify(
				problems.length === 0
					? `Cosmos doctor: OK — ${context.repoName} is ready.`
					: `Cosmos doctor found ${problems.length} issue${problems.length === 1 ? "" : "s"}.`,
				problems.length === 0 ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("cosmos-status", {
		description: "Show the current Cosmos repo/workspace context",
		handler: async (_args, ctx) => {
			const context = resolveCosmosContext(ctx.cwd);
			ctx.ui.notify(summarizeContext(context).join(" | "), "info");
		},
	});
}
