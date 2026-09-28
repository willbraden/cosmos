// Pure conversion of pi's session entries and live RPC events into renderable chat items.
// No React or IPC here, so it is unit-tested directly (test/chat-model.test.ts).

import type {
	AgentMessage,
	AssistantMessage,
	ImageContent,
	PiRecord,
	SessionEntry,
	ToolResultPayload,
	Usage,
} from "@shared/pi-types";

export type Block =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string; redacted?: boolean }
	| { type: "toolCall"; id: string; name: string; args: Record<string, unknown>; argsText: string; complete: boolean };

export type ChatItem =
	| { kind: "user"; key: string; entryId?: string; text: string; images: ImageContent[]; timestamp: number }
	| {
			kind: "assistant";
			key: string;
			entryId?: string;
			blocks: Block[];
			model?: string;
			provider?: string;
			stopReason: AssistantMessage["stopReason"];
			errorMessage?: string;
			usage?: Usage;
			timestamp: number;
			streaming: boolean;
			durationMs?: number;
	  }
	| {
			kind: "bash";
			key: string;
			command: string;
			output: string;
			exitCode?: number;
			cancelled: boolean;
			running: boolean;
			excludeFromContext: boolean;
	  }
	| { kind: "custom"; key: string; customType: string; text: string }
	| { kind: "compaction"; key: string; summary: string; tokensBefore?: number }
	| { kind: "branchSummary"; key: string; summary: string }
	| { kind: "notice"; key: string; level: "info" | "warning" | "error"; text: string };

export type ToolStatus = "running" | "done" | "error";

export interface ToolRun {
	status: ToolStatus;
	name: string;
	partial?: ToolResultPayload;
	result?: ToolResultPayload;
}

export interface ChatState {
	items: ChatItem[];
	/** Execution state per tool call id. A call with no entry has not started (or never ran). */
	tools: Record<string, ToolRun>;
}

export const EMPTY_CHAT: ChatState = { items: [], tools: {} };

export function isHiddenUserPromptText(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith("/desktop-") || trimmed.startsWith("/mcp-auth ");
}

export function firstUserMessage(chat: ChatState): string | undefined {
	return chat.items.find((item): item is Extract<ChatItem, { kind: "user" }> => item.kind === "user" && !isHiddenUserPromptText(item.text))?.text;
}

let noticeCounter = 0;
export function noticeItem(level: "info" | "warning" | "error", text: string): ChatItem {
	return { kind: "notice", key: `notice:${Date.now()}:${++noticeCounter}`, level, text };
}

/** Stable across live streaming and later history reloads: pi keeps message timestamps. */
function messageKey(message: AgentMessage): string {
	return `${message.role}:${message.timestamp}`;
}

function contentText(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function contentImages(content: string | { type: string }[]): ImageContent[] {
	if (typeof content === "string") return [];
	return content.filter((part): part is ImageContent => part.type === "image");
}

function assistantBlocks(message: AssistantMessage): Block[] {
	const blocks: Block[] = [];
	for (const part of message.content ?? []) {
		if (part.type === "text") blocks.push({ type: "text", text: part.text });
		else if (part.type === "thinking") blocks.push({ type: "thinking", text: part.thinking, redacted: part.redacted });
		else if (part.type === "toolCall") {
			blocks.push({
				type: "toolCall",
				id: part.id,
				name: part.name,
				args: part.arguments ?? {},
				argsText: JSON.stringify(part.arguments ?? {}),
				complete: true,
			});
		}
	}
	return blocks;
}

function assistantItem(message: AssistantMessage, entryId: string | undefined, streaming: boolean): ChatItem {
	return {
		kind: "assistant",
		key: messageKey(message),
		entryId,
		blocks: assistantBlocks(message),
		model: message.model,
		provider: message.provider,
		stopReason: message.stopReason,
		errorMessage: message.errorMessage,
		usage: message.usage,
		timestamp: message.timestamp,
		streaming,
	};
}

/** Convert one message into chat items and tool-state updates. */
function applyMessage(state: ChatState, message: AgentMessage, entryId?: string): ChatState {
	switch (message.role) {
		case "user": {
			const text = contentText(message.content);
			const images = contentImages(message.content);
			if (images.length === 0 && isHiddenUserPromptText(text)) return state;
			return {
				...state,
				items: [
					...state.items,
					{
						kind: "user",
						key: messageKey(message),
						entryId,
						text,
						images,
						timestamp: message.timestamp,
					},
				],
			};
		}
		case "assistant":
			return { ...state, items: [...state.items, assistantItem(message, entryId, false)] };
		case "toolResult":
			return {
				...state,
				tools: {
					...state.tools,
					[message.toolCallId]: {
						status: message.isError ? "error" : "done",
						name: message.toolName,
						result: { content: message.content, details: message.details },
					},
				},
			};
		case "bashExecution":
			return {
				...state,
				items: [
					...state.items,
					{
						kind: "bash",
						key: messageKey(message),
						command: message.command,
						output: message.output,
						exitCode: message.exitCode,
						cancelled: message.cancelled,
						running: false,
						excludeFromContext: Boolean(message.excludeFromContext),
					},
				],
			};
		case "custom":
			if (!message.display) return state;
			return {
				...state,
				items: [
					...state.items,
					{ kind: "custom", key: messageKey(message), customType: message.customType, text: contentText(message.content) },
				],
			};
		case "compactionSummary":
			return {
				...state,
				items: [...state.items, { kind: "compaction", key: messageKey(message), summary: message.summary, tokensBefore: message.tokensBefore }],
			};
		case "branchSummary":
			return { ...state, items: [...state.items, { kind: "branchSummary", key: messageKey(message), summary: message.summary }] };
		default:
			return state;
	}
}

/** Entries on the active branch, root first. */
export function activeBranch(entries: SessionEntry[], leafId: string | null): SessionEntry[] {
	if (!leafId) return [];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = byId.get(leafId);
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return path.reverse();
}

/** Build the transcript from `get_entries`, including history from before compactions. */
export function chatFromEntries(entries: SessionEntry[], leafId: string | null): ChatState {
	let state: ChatState = { items: [], tools: {} };
	for (const entry of activeBranch(entries, leafId)) {
		switch (entry.type) {
			case "message":
				if (entry.message) state = applyMessage(state, entry.message, entry.id);
				break;
			case "compaction":
				state = {
					...state,
					items: [
						...state.items,
						{ kind: "compaction", key: `compaction:${entry.id}`, summary: String(entry.summary ?? ""), tokensBefore: entry.tokensBefore },
					],
				};
				break;
			case "branch_summary":
				state = {
					...state,
					items: [...state.items, { kind: "branchSummary", key: `branch:${entry.id}`, summary: String(entry.summary ?? "") }],
				};
				break;
			case "custom_message":
				if (entry.display) {
					state = {
						...state,
						items: [
							...state.items,
							{
								kind: "custom",
								key: `custom:${entry.id}`,
								customType: String(entry.customType ?? "extension"),
								text: contentText((entry.content as string) ?? ""),
							},
						],
					};
				}
				break;
		}
	}
	return state;
}

function updateStreamingAssistant(state: ChatState, update: (item: Extract<ChatItem, { kind: "assistant" }>) => ChatItem): ChatState {
	for (let i = state.items.length - 1; i >= 0; i--) {
		const item = state.items[i];
		if (item.kind === "assistant" && item.streaming) {
			const items = state.items.slice();
			items[i] = update(item);
			return { ...state, items };
		}
	}
	return state;
}

function setBlock(blocks: Block[], index: number, block: Block): Block[] {
	const next = blocks.slice();
	while (next.length < index) next.push({ type: "text", text: "" });
	next[index] = block;
	return next;
}

function tryParseArgs(text: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(text);
		return value && typeof value === "object" ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Apply one live RPC record. Records that do not affect the transcript return `state` unchanged. */
export function applyRecord(state: ChatState, record: PiRecord): ChatState {
	switch (record.type) {
		case "message_start": {
			const message = record.message;
			if (message.role === "assistant") {
				return { ...state, items: [...state.items, assistantItem(message, undefined, true)] };
			}
			if (message.role === "toolResult") return state; // handled at message_end
			// Avoid duplicates if a message_start is replayed for an item already shown.
			if (state.items.some((item) => item.key === messageKey(message))) return state;
			return applyMessage(state, message);
		}
		case "message_update": {
			const event = record.assistantMessageEvent;
			return updateStreamingAssistant(state, (item) => {
				const index = event.contentIndex ?? item.blocks.length;
				const current = item.blocks[index];
				switch (event.type) {
					case "text_start":
						return { ...item, blocks: setBlock(item.blocks, index, { type: "text", text: "" }) };
					case "text_delta":
						return {
							...item,
							blocks: setBlock(item.blocks, index, {
								type: "text",
								text: (current?.type === "text" ? current.text : "") + (event as { delta: string }).delta,
							}),
						};
					case "text_end":
						return { ...item, blocks: setBlock(item.blocks, index, { type: "text", text: (event as { content: string }).content }) };
					case "thinking_start":
						return { ...item, blocks: setBlock(item.blocks, index, { type: "thinking", text: "" }) };
					case "thinking_delta":
						return {
							...item,
							blocks: setBlock(item.blocks, index, {
								type: "thinking",
								text: (current?.type === "thinking" ? current.text : "") + (event as { delta: string }).delta,
							}),
						};
					case "thinking_end":
						return { ...item, blocks: setBlock(item.blocks, index, { type: "thinking", text: (event as { content: string }).content }) };
					case "toolcall_start": {
						const start = event as { id: string; toolName: string };
						return {
							...item,
							blocks: setBlock(item.blocks, index, { type: "toolCall", id: start.id, name: start.toolName, args: {}, argsText: "", complete: false }),
						};
					}
					case "toolcall_delta": {
						if (current?.type !== "toolCall") return item;
						const argsText = current.argsText + (event as { delta: string }).delta;
						return { ...item, blocks: setBlock(item.blocks, index, { ...current, argsText, args: tryParseArgs(argsText) ?? current.args }) };
					}
					case "toolcall_end": {
						const call = (event as { toolCall: { id: string; name: string; arguments: Record<string, unknown> } }).toolCall;
						return {
							...item,
							blocks: setBlock(item.blocks, index, {
								type: "toolCall",
								id: call.id,
								name: call.name,
								args: call.arguments ?? {},
								argsText: JSON.stringify(call.arguments ?? {}),
								complete: true,
							}),
						};
					}
					default:
						return item;
				}
			});
		}
		case "message_end": {
			const message = record.message;
			if (message.role === "toolResult") return applyMessage(state, message);
			if (message.role !== "assistant") return state;
			const final = assistantItem(message, undefined, false);
			const replaced = updateStreamingAssistant(state, (item) => ({ ...final, entryId: item.entryId }));
			return replaced === state ? { ...state, items: [...state.items, final] } : replaced;
		}
		case "tool_execution_start":
			return { ...state, tools: { ...state.tools, [record.toolCallId]: { status: "running", name: record.toolName } } };
		case "tool_execution_update": {
			const run = state.tools[record.toolCallId];
			return {
				...state,
				tools: { ...state.tools, [record.toolCallId]: { ...run, status: "running", name: record.toolName, partial: record.partialResult } },
			};
		}
		case "tool_execution_end":
			return {
				...state,
				tools: {
					...state.tools,
					[record.toolCallId]: { status: record.isError ? "error" : "done", name: record.toolName, result: record.result },
				},
			};
		case "compaction_end":
			if (record.result) {
				return {
					...state,
					items: [
						...state.items,
						{ kind: "compaction", key: `compaction:live:${Date.now()}`, summary: record.result.summary, tokensBefore: record.result.tokensBefore },
					],
				};
			}
			if (!record.aborted && record.errorMessage) {
				return { ...state, items: [...state.items, noticeItem("error", `Compaction failed: ${record.errorMessage}`)] };
			}
			return state;
		case "auto_retry_end":
			if (!record.success && record.finalError) {
				return { ...state, items: [...state.items, noticeItem("error", record.finalError)] };
			}
			return state;
		case "extension_error":
			return {
				...state,
				items: [...state.items, noticeItem("warning", `Extension error (${record.event}): ${record.error}`)],
			};
		case "agent_settled":
			// Anything still marked streaming (e.g. aborted mid-stream) is final now.
			if (!state.items.some((item) => item.kind === "assistant" && item.streaming)) return state;
			return {
				...state,
				items: state.items.map((item) => (item.kind === "assistant" && item.streaming ? { ...item, streaming: false } : item)),
			};
		default:
			return state;
	}
}

/** Carry desktop-only items (notices, in-flight bash) across a history reload. */
export function mergeReloadedChat(previous: ChatState, reloaded: ChatState): ChatState {
	const known = new Set(reloaded.items.map((item) => item.key));
	const localOnly = previous.items.filter((item) => item.kind === "notice" && !known.has(item.key));
	if (localOnly.length === 0) return { items: reloaded.items, tools: { ...previous.tools, ...reloaded.tools } };
	// Keep notices near where they happened: after the last reloaded item that preceded them.
	const items = reloaded.items.slice();
	for (const notice of localOnly) {
		const index = previous.items.indexOf(notice);
		let anchor = -1;
		for (let i = index - 1; i >= 0; i--) {
			const at = items.findIndex((item) => item.key === previous.items[i].key);
			if (at !== -1) {
				anchor = at;
				break;
			}
		}
		items.splice(anchor + 1, 0, notice);
	}
	return { items, tools: { ...previous.tools, ...reloaded.tools } };
}

export interface FileChange {
	path: string;
	toolCallId: string;
	kind: "edit" | "write";
	patch?: string;
	content?: string;
	status: ToolStatus | "pending";
}

/** Files the agent changed in this transcript, newest change last. */
export function collectFileChanges(chat: ChatState): FileChange[] {
	const changes: FileChange[] = [];
	for (const item of chat.items) {
		if (item.kind !== "assistant") continue;
		for (const block of item.blocks) {
			if (block.type !== "toolCall" || (block.name !== "edit" && block.name !== "write")) continue;
			const path = typeof block.args.path === "string" ? block.args.path : undefined;
			if (!path) continue;
			const run = chat.tools[block.id];
			const details = run?.result?.details as { patch?: string } | undefined;
			changes.push({
				path,
				toolCallId: block.id,
				kind: block.name,
				patch: details?.patch,
				content: block.name === "write" && typeof block.args.content === "string" ? block.args.content : undefined,
				status: run?.status ?? "pending",
			});
		}
	}
	return changes;
}

export function lastAssistantText(chat: ChatState): string {
	for (let i = chat.items.length - 1; i >= 0; i--) {
		const item = chat.items[i];
		if (item.kind === "assistant") {
			const text = item.blocks
				.filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
				.map((b) => b.text)
				.join("\n")
				.trim();
			if (text) return text;
		}
	}
	return "";
}
