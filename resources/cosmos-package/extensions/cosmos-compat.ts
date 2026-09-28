import { basename, dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	readTextIfExists,
	resolveCosmosContext,
	type InstructionSource,
} from "./lib/context";

export default function cosmosCompat(pi: ExtensionAPI) {
	pi.on("resources_discover", () => {
		const context = resolveCosmosContext();
		return context.skillPaths.length > 0
			? { skillPaths: context.skillPaths }
			: undefined;
	});

	pi.on("before_agent_start", (event) => {
		const context = resolveCosmosContext();
		const sections = event.systemPromptOptions.sections;
		sections.cosmos_context = [
			"Cosmos desktop is the official company environment for this session.",
			context.repoRoot
				? `Active repository: ${context.repoName}`
				: "Active repository: none detected from cwd",
			context.repoRoot
				? `Repository root: ${context.repoRoot}`
				: `Current working directory: ${context.cwd}`,
			`Workspace root: ${context.workspaceRoot}`,
			context.skillPaths.length > 0
				? `Auto-discovered skills: ${context.skillPaths.map((path) => basename(dirname(path))).join(", ")}`
				: "Auto-discovered skills: none",
			context.disabled.skills.length > 0
				? `Disabled repo skills: ${context.disabled.skills.join(", ")}`
				: "Disabled repo skills: none",
			context.glayvin.instructionSources.length > 0
				? `Glayvin/company instruction layers: ${context.glayvin.instructionSources.map((source) => source.label).join(", ")}`
				: "Glayvin/company instruction layers: none detected",
		].join("\n");

		const repoInstructions = readTextIfExists(context.instructionsPath);
		if (repoInstructions) {
			sections.cosmos_repo_instructions = [
				`Repository instructions loaded from ${context.instructionsPath}.`,
				"Treat them as repository-authoritative guidance for this session.",
				"",
				repoInstructions,
			].join("\n");
		} else {
			delete sections.cosmos_repo_instructions;
		}

		const layeredInstructions = renderInstructionLayers(
			context.glayvin.instructionSources,
		);
		if (layeredInstructions)
			sections.cosmos_company_instructions = layeredInstructions;
		else delete sections.cosmos_company_instructions;
		return undefined;
	});
}

function renderInstructionLayers(
	sources: InstructionSource[],
): string | undefined {
	const loaded = sources
		.map((source) => ({ ...source, text: readTextIfExists(source.path) }))
		.filter(
			(source): source is InstructionSource & { text: string } => !!source.text,
		);
	if (loaded.length === 0) return undefined;
	return [
		"Load these company and environment instruction layers before acting.",
		"Later sections are more specific than earlier ones when they overlap.",
		...loaded.flatMap((source) => [
			"",
			`[${source.label}] ${source.path}`,
			source.text,
		]),
	].join("\n");
}
