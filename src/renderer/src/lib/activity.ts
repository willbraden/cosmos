import type { ChatItem } from "../state/chat-model";
import type { Block, ToolRun } from "../state/chat-model";

type ToolCallBlock = Extract<Block, { type: "toolCall" }>;
export type ActivityStatus = ToolRun["status"] | "waiting" | "pending" | "skipped";

function basename(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return normalized.split("/").filter(Boolean).pop() ?? path;
}

function clean(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function ellipsize(text: string, max = 48): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function quote(text: string): string {
	return `“${ellipsize(clean(text), 32)}”`;
}

function describeCommand(
	command: string,
	mode: "present" | "past" | "infinitive" = "present",
): string {
	const single = clean(command.split("\n")[0] ?? "");
	if (!single) {
		if (mode === "infinitive") return "run a command";
		return mode === "past" ? "Ran a command" : "Running a command";
	}
	if (/^find\b/.test(single)) {
		if (mode === "infinitive") return "search the workspace";
		return mode === "past" ? "Searched the workspace" : "Searching the workspace";
	}
	if (/^grep\b/.test(single) || /^rg\b/.test(single)) {
		if (mode === "infinitive") return "search the codebase";
		return mode === "past" ? "Searched the codebase" : "Searching the codebase";
	}
	if (/^git\s+status\b/.test(single)) {
		if (mode === "infinitive") return "check git status";
		return mode === "past" ? "Checked git status" : "Checking git status";
	}
	if (/^npm\s+test\b/.test(single)) {
		if (mode === "infinitive") return "run tests";
		return mode === "past" ? "Ran tests" : "Running tests";
	}
	if (/^npm\s+run\s+typecheck\b/.test(single)) {
		if (mode === "infinitive") return "run the typechecker";
		return mode === "past"
			? "Ran the typechecker"
			: "Running the typechecker";
	}
	if (/^node\b/.test(single)) {
		if (mode === "infinitive") return "run a quick Node check";
		return mode === "past"
			? "Ran a quick Node check"
			: "Running a quick Node check";
	}
	if (mode === "infinitive") return `run ${ellipsize(single, 44)}`;
	return `${mode === "past" ? "Ran" : "Running"} ${ellipsize(single, 44)}`;
}

function describeTool(
	block: ToolCallBlock,
	mode: "present" | "past" | "infinitive" = "present",
): string {
	const path = typeof block.args.path === "string" ? block.args.path : "";
	switch (block.name) {
		case "bash":
			return describeCommand(
				typeof block.args.command === "string" ? block.args.command : "",
				mode,
			);
		case "read":
			return `${mode === "infinitive" ? "review" : mode === "past" ? "Reviewed" : "Reviewing"} ${path ? basename(path) : "a file"}`;
		case "edit":
			return `${mode === "infinitive" ? "update" : mode === "past" ? "Updated" : "Updating"} ${path ? basename(path) : "a file"}`;
		case "write":
			return `${mode === "infinitive" ? "write" : mode === "past" ? "Wrote" : "Writing"} ${path ? basename(path) : "a file"}`;
		case "grep": {
			const pattern = typeof block.args.pattern === "string" ? clean(block.args.pattern) : "";
			return pattern
				? `${mode === "infinitive" ? "search for" : mode === "past" ? "Searched for" : "Searching for"} ${quote(pattern)}`
				: `${mode === "infinitive" ? "search the codebase" : mode === "past" ? "Searched the codebase" : "Searching the codebase"}`;
		}
		case "find": {
			const pattern = typeof block.args.pattern === "string" ? clean(block.args.pattern) : "";
			return pattern
				? `${mode === "infinitive" ? "look for" : mode === "past" ? "Looked for" : "Looking for"} ${quote(pattern)}`
				: `${mode === "infinitive" ? "look for files" : mode === "past" ? "Looked for files" : "Looking for files"}`;
		}
		case "ls":
			return `${mode === "infinitive" ? "inspect" : mode === "past" ? "Inspected" : "Inspecting"} files`;
		default:
			return `${mode === "infinitive" ? "use" : mode === "past" ? "Used" : "Using"} ${block.name}`;
	}
}

export function toolActivityLabel(block: ToolCallBlock, status: ActivityStatus): string {
	if (status === "waiting")
		return `Waiting for approval to ${describeTool(block, "infinitive")}`;
	if (status === "error")
		return `Hit an issue while trying to ${describeTool(block, "infinitive")}`;
	if (status === "done" || status === "skipped")
		return describeTool(block, "past");
	return describeTool(block, "present");
}

export function toolStatus(
	block: ToolCallBlock,
	run: ToolRun | undefined,
	awaitingPermission: boolean,
	settled: boolean,
): ActivityStatus {
	if (awaitingPermission) return "waiting";
	if (run?.status) return run.status;
	if (settled && block.complete) return "skipped";
	return "pending";
}

function activeTool(
	blocks: Block[],
	tools: Record<string, ToolRun>,
	waitingToolIds: Set<string>,
	settled: boolean,
): {
	block: ToolCallBlock;
	status: ActivityStatus;
} | null {
	const toolBlocks = blocks.filter(
		(block): block is ToolCallBlock => block.type === "toolCall",
	);
	for (let index = toolBlocks.length - 1; index >= 0; index--) {
		const block = toolBlocks[index];
		const status = toolStatus(
			block,
			tools[block.id],
			waitingToolIds.has(block.id),
			settled,
		);
		if (status === "waiting" || status === "running" || status === "pending")
			return { block, status };
	}
	const last = toolBlocks.at(-1);
	return last
		? {
				block: last,
				status: toolStatus(
					last,
					tools[last.id],
					waitingToolIds.has(last.id),
					settled,
				),
			}
		: null;
}

export function summarizeReasoning(
	blocks: Block[],
	tools: Record<string, ToolRun>,
	waitingToolIds = new Set<string>(),
	settled = false,
): string {
	const tool = activeTool(blocks, tools, waitingToolIds, settled);
	if (tool) return toolActivityLabel(tool.block, tool.status);
	const lastThinking = [...blocks].reverse().find(
		(block): block is Extract<Block, { type: "thinking" }> =>
			block.type === "thinking" && Boolean(block.text.trim()),
	);
	if (lastThinking)
		return settled ? "Thought through the next step" : "Thinking through the next step";
	return settled ? "Thought" : "Thinking";
}

export interface Thought {
	title: string | null;
	body: string;
}

/**
 * Reasoning arrives as markdown whose bold standalone lines title each shift in
 * thought, so split on them and let every section collapse on its own.
 */
export function splitThoughts(text: string): Thought[] {
	const sections: Array<{ title: string | null; lines: string[] }> = [];
	for (const line of text.split("\n")) {
		const heading = /^\s*\*\*(.+?)\*\*\s*$/.exec(line);
		if (heading) {
			sections.push({ title: heading[1].trim(), lines: [] });
			continue;
		}
		if (sections.length === 0) sections.push({ title: null, lines: [] });
		sections[sections.length - 1].lines.push(line);
	}
	return sections
		.map((section) => ({
			title: section.title,
			body: section.lines.join("\n").trim(),
		}))
		.filter((section) => section.title || section.body);
}

export function summarizeBusyWork(
	items: ChatItem[],
	tools: Record<string, ToolRun>,
	waitingToolIds = new Set<string>(),
): string | null {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "assistant") {
			const detailBlocks = item.blocks.filter((block) => block.type !== "text");
			if (detailBlocks.length > 0)
				return summarizeReasoning(
					detailBlocks,
					tools,
					waitingToolIds,
					!item.streaming,
				);
		}
		if (item.kind === "bash" && item.running)
			return describeCommand(item.command, "present");
	}
	return null;
}
