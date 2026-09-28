import { describe, expect, it } from "vitest";
import { summarizeBusyWork, summarizeReasoning, toolStatus } from "../src/renderer/src/lib/activity";
import type { Block, ChatItem, ToolRun } from "../src/renderer/src/state/chat-model";

function readBlock(path: string, id = "read-1"): Extract<Block, { type: "toolCall" }> {
	return { type: "toolCall", id, name: "read", args: { path }, argsText: JSON.stringify({ path }), complete: true };
}

describe("activity summaries", () => {
	it("turns tool calls into lighter status text", () => {
		const blocks: Block[] = [readBlock("README.md")];
		expect(summarizeReasoning(blocks, {}, new Set(), false)).toBe("Reviewing README.md");
		expect(summarizeReasoning(blocks, {}, new Set(), true)).toBe("Reviewed README.md");
		expect(summarizeReasoning(blocks, {}, new Set(["read-1"]), false)).toBe("Waiting for approval to review README.md");
	});

	it("falls back to thinking when there is no tool call", () => {
		const blocks: Block[] = [{ type: "thinking", text: "Compare the settings flow to the transcript UI." }];
		expect(summarizeReasoning(blocks, {}, new Set(), false)).toBe("Thinking through the next step");
	});

	it("summarizes the latest busy work in the transcript", () => {
		const items: ChatItem[] = [
			{
				kind: "assistant",
				key: "assistant:1",
				blocks: [readBlock("src/renderer/src/components/Transcript.tsx", "read-2")],
				stopReason: "pending",
				timestamp: 1,
				streaming: true,
			},
		];
		expect(summarizeBusyWork(items, {}, new Set())).toBe("Reviewing Transcript.tsx");
	});

	it("classifies settled tool calls with no execution as skipped", () => {
		const run: ToolRun | undefined = undefined;
		expect(toolStatus(readBlock("README.md"), run, false, true)).toBe("skipped");
	});
});
