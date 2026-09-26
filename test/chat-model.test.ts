import { describe, expect, it } from "vitest";
import type { PiRecord, SessionEntry } from "@shared/pi-types";
import {
	activeBranch,
	applyRecord,
	type ChatState,
	chatFromEntries,
	collectFileChanges,
	EMPTY_CHAT,
	lastAssistantText,
	mergeReloadedChat,
	noticeItem,
} from "../src/renderer/src/state/chat-model";
import stream from "./fixtures/stream.json";
import entriesFixture from "./fixtures/entries.json";

const records = stream as PiRecord[];
const { entries, leafId } = entriesFixture as { entries: SessionEntry[]; leafId: string };

function replay(list: PiRecord[]): ChatState {
	return list.reduce(applyRecord, EMPTY_CHAT);
}

describe("live stream reconstruction (real pi output)", () => {
	const live = replay(records);

	it("produces user and assistant items in order", () => {
		expect(live.items.map((i) => i.kind)).toEqual([
			"user", "assistant", "user", "assistant", "assistant", "user", "assistant", "assistant",
		]);
		expect(live.items.every((i) => i.kind !== "assistant" || !i.streaming)).toBe(true);
	});

	it("reconstructs thinking, text, and tool calls from deltas", () => {
		const first = live.items[1];
		if (first.kind !== "assistant") throw new Error("expected assistant");
		expect(first.blocks.map((b) => b.type)).toEqual(["thinking", "text"]);
		const writeCall = live.items[3];
		if (writeCall.kind !== "assistant") throw new Error("expected assistant");
		const call = writeCall.blocks.find((b) => b.type === "toolCall");
		expect(call).toMatchObject({ name: "write", complete: true, args: { path: "hello.txt" } });
	});

	it("tracks tool execution results by call id", () => {
		const runs = Object.values(live.tools);
		expect(runs.map((r) => [r.name, r.status])).toEqual([
			["write", "done"],
			["edit", "done"],
		]);
	});

	it("keeps streaming partial state consistent mid-stream", () => {
		const cut = records.findIndex((r) => r.type === "message_update" && r.assistantMessageEvent.type === "text_delta");
		const partial = replay(records.slice(0, cut + 3));
		const last = partial.items.at(-1);
		expect(last?.kind === "assistant" && last.streaming).toBe(true);
		expect(last?.kind === "assistant" && last.blocks.some((b) => b.type === "text" && b.text.length > 0)).toBe(true);
	});
});

describe("history from entries", () => {
	const history = chatFromEntries(entries, leafId);

	it("matches the live transcript keys exactly (no remount on reload)", () => {
		expect(history.items.map((i) => i.key)).toEqual(replay(records).items.map((i) => i.key));
	});

	it("attaches entry ids to user messages for forking", () => {
		const users = history.items.filter((i) => i.kind === "user");
		expect(users).toHaveLength(3);
		expect(users.every((u) => u.kind === "user" && typeof u.entryId === "string")).toBe(true);
	});

	it("walks only the active branch", () => {
		const forked: SessionEntry[] = [
			...entries,
			{ type: "message", id: "orphan", parentId: entries[0].id, timestamp: "", message: { role: "user", content: "other branch", timestamp: 1 } },
		];
		expect(activeBranch(forked, leafId).some((e) => e.id === "orphan")).toBe(false);
		expect(chatFromEntries(forked, "orphan").items.map((i) => i.kind)).toEqual(["user"]);
	});

	it("renders nothing for an empty session", () => {
		expect(chatFromEntries([], null).items).toEqual([]);
	});
});

describe("derived views", () => {
	const history = chatFromEntries(entries, leafId);

	it("collects file changes with patches", () => {
		const changes = collectFileChanges(history);
		expect(changes.map((c) => [c.kind, c.path, c.status])).toEqual([
			["write", "hello.txt", "done"],
			["edit", "hello.txt", "done"],
		]);
		expect(changes[1].patch).toContain("+Howdy");
		expect(changes[0].content).toContain("Hello from Pi Desktop");
	});

	it("finds the last assistant text", () => {
		expect(lastAssistantText(history)).toMatch(/^Done\./);
	});

	it("keeps desktop notices across a history reload", () => {
		const notice = noticeItem("error", "boom");
		const previous: ChatState = { ...history, items: [history.items[0], notice, ...history.items.slice(1)] };
		const merged = mergeReloadedChat(previous, history);
		expect(merged.items[1]).toBe(notice);
		expect(merged.items).toHaveLength(history.items.length + 1);
	});
});

describe("edge cases", () => {
	it("ignores deltas when no assistant message is streaming", () => {
		const state = applyRecord(EMPTY_CHAT, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
		});
		expect(state).toBe(EMPTY_CHAT);
	});

	it("tolerates unknown record types", () => {
		expect(applyRecord(EMPTY_CHAT, { type: "something_new" } as unknown as PiRecord)).toBe(EMPTY_CHAT);
	});

	it("finalizes a message that was aborted mid-stream on agent_settled", () => {
		const started = applyRecord(EMPTY_CHAT, {
			type: "message_start",
			message: { role: "assistant", content: [], provider: "p", model: "m", usage: undefined as never, stopReason: "pending", timestamp: 5 },
		});
		const settled = applyRecord(started, { type: "agent_settled" });
		expect(settled.items[0]).toMatchObject({ kind: "assistant", streaming: false });
	});

	it("surfaces final retry failures and extension errors as notices", () => {
		let state = applyRecord(EMPTY_CHAT, { type: "auto_retry_end", success: false, attempt: 3, finalError: "529 overloaded" });
		state = applyRecord(state, { type: "extension_error", extensionPath: "/x.ts", event: "tool_call", error: "bad" });
		expect(state.items.map((i) => i.kind === "notice" && i.level)).toEqual(["error", "warning"]);
	});

	it("keeps partially streamed tool args usable before they are valid JSON", () => {
		let state = applyRecord(EMPTY_CHAT, {
			type: "message_start",
			message: { role: "assistant", content: [], provider: "p", model: "m", usage: undefined as never, stopReason: "pending", timestamp: 9 },
		});
		state = applyRecord(state, { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "bash" } });
		state = applyRecord(state, { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"l' } });
		const block = state.items[0].kind === "assistant" ? state.items[0].blocks[0] : undefined;
		expect(block).toMatchObject({ type: "toolCall", argsText: '{"command":"l', args: {}, complete: false });
	});
});
