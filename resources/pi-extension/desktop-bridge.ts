/**
 * Cosmos desktop bridge extension.
 *
 * Loaded into every pi process the desktop app starts (`pi --mode rpc -e <this file>`).
 * Pi has no built-in permission system, so this adds the desktop's permission modes:
 *
 *   ask          confirm every tool call that edits files or runs commands
 *   acceptEdits  edit/write run freely; commands and other side-effecting tools ask
 *   auto         nothing asks
 *
 * Prompts travel over pi's extension UI protocol (`ctx.ui.select`). The title carries a
 * marker plus a JSON payload so the desktop can render a rich permission card attached to
 * the matching tool call. Keep PERMISSION_PROMPT_MARKER / OPTIONS in sync with
 * src/shared/pi-types.ts (test/bridge-contract.test.ts enforces this).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	AUTO_TITLE_CUSTOM_TYPE,
	buildTitlePrompt,
	fallbackTitleFromTranscript,
	sanitizeGeneratedTitle,
} from "./session-title";

export const PERMISSION_PROMPT_MARKER = "⁣pi-desktop-permission⁣";
export const OPTIONS = {
	allow: "Allow once",
	always: "Always allow this tool in this session",
	deny: "Deny",
} as const;

export type PermissionMode = "ask" | "acceptEdits" | "auto";
export type ToolKind = "read" | "edit" | "exec";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const EDIT_TOOLS = new Set(["edit", "write"]);
const AUTO_TITLE_SYSTEM_PROMPT = [
	"You write short, descriptive session titles for developer conversations.",
	"Return only the title text with no markdown, explanation, or quotes.",
].join(" ");

export function classifyTool(toolName: string): ToolKind {
	if (READ_ONLY_TOOLS.has(toolName)) return "read";
	if (EDIT_TOOLS.has(toolName)) return "edit";
	// bash, powershell, and any extension tool: treat as side-effecting.
	return "exec";
}

export function needsApproval(mode: PermissionMode, toolName: string, alwaysAllowed: ReadonlySet<string>): boolean {
	if (mode === "auto" || alwaysAllowed.has(toolName)) return false;
	const kind = classifyTool(toolName);
	if (kind === "read") return false;
	if (kind === "edit") return mode === "ask";
	return true;
}

export function parseMode(value: string | undefined): PermissionMode | undefined {
	const mode = value?.trim();
	return mode === "ask" || mode === "acceptEdits" || mode === "auto" ? mode : undefined;
}

function textOnly(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: string; text?: string } =>
				!!part && typeof part === "object" && "type" in part,
		)
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n")
		.trim();
}

function initialTranscript(sessionManager: {
	buildSessionProjection(): { messages: Array<{ role: string; content?: unknown }> };
}): string | null {
	const messages = sessionManager.buildSessionProjection().messages;
	let userText = "";
	let assistantText = "";
	for (const message of messages) {
		if (!userText && message.role === "user") userText = textOnly(message.content);
		if (!assistantText && message.role === "assistant")
			assistantText = textOnly(message.content);
		if (userText && assistantText) break;
	}
	if (!userText || !assistantText) return null;
	return `User: ${truncate(userText, 800)}\nAssistant: ${truncate(assistantText, 1200)}`;
}

function truncate(text: string, maxChars: number): string {
	const trimmed = text.replace(/\s+/g, " ").trim();
	if (trimmed.length <= maxChars) return trimmed;
	const clipped = trimmed.slice(0, maxChars);
	const boundary = clipped.lastIndexOf(" ");
	return `${(boundary > 40 ? clipped.slice(0, boundary) : clipped).trim()}…`;
}

function alreadyAttempted(entries: Array<{ type?: string; customType?: string }>): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom" && entry.customType === AUTO_TITLE_CUSTOM_TYPE,
	);
}

async function maybeAutoTitleSession(
	pi: ExtensionAPI,
	ctx: {
		model?: unknown;
		modelRegistry: {
			complete(model: unknown, context: unknown, options?: Record<string, unknown>): Promise<{ content?: unknown }>;
		};
		sessionManager: {
			getEntries(): Array<{ type?: string; customType?: string }>;
			buildSessionProjection(): { messages: Array<{ role: string; content?: unknown }> };
		};
		ui?: { setTitle?(title: string): void };
	},
): Promise<void> {
	if (pi.getSessionName()) return;
	const entries = ctx.sessionManager.getEntries();
	if (alreadyAttempted(entries)) return;
	if (!ctx.model) return;
	const transcript = initialTranscript(ctx.sessionManager);
	if (!transcript) return;
	try {
		const response = await ctx.modelRegistry.complete(
			ctx.model,
			{
				systemPrompt: AUTO_TITLE_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: buildTitlePrompt(transcript) }],
						timestamp: Date.now(),
					},
				],
			},
			{ maxTokens: 30 },
		);
		const rawTitle = textOnly(response.content);
		const title =
			sanitizeGeneratedTitle(rawTitle) || fallbackTitleFromTranscript(transcript);
		if (pi.getSessionName()) {
			pi.appendEntry(AUTO_TITLE_CUSTOM_TYPE, {
				status: "skipped",
				reason: "name-set-during-generation",
			});
			return;
		}
		if (!title) {
			console.warn("[cosmos] auto session title fallback: empty or invalid model output");
			pi.appendEntry(AUTO_TITLE_CUSTOM_TYPE, {
				status: "failed",
				reason: "empty-or-invalid",
				rawTitle,
			});
			return;
		}
		pi.setSessionName(title);
		pi.appendEntry(AUTO_TITLE_CUSTOM_TYPE, { status: "done", title, rawTitle });
		ctx.ui?.setTitle?.(title);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[cosmos] auto session title failed: ${message}`);
		pi.appendEntry(AUTO_TITLE_CUSTOM_TYPE, {
			status: "failed",
			reason: message,
		});
	}
}

export default function desktopBridge(pi: ExtensionAPI) {
	// Only active inside the desktop app, so a user loading this file elsewhere is unaffected.
	if (!process.env.PI_DESKTOP) return;

	let mode: PermissionMode = parseMode(process.env.PI_DESKTOP_PERMISSION_MODE) ?? "ask";
	const alwaysAllowed = new Set<string>();

	pi.registerCommand("desktop-permission-mode", {
		description: "Internal: set the Cosmos permission mode (ask | acceptEdits | auto)",
		handler: async (args) => {
			const next = parseMode(args);
			if (next) mode = next;
		},
	});

	pi.registerCommand("desktop-rewind", {
		description:
			"Internal: move the session leaf back to just before a user message, so it can be re-sent edited",
		handler: async (args, ctx) => {
			const entryId = args.trim();
			if (!entryId) throw new Error("Missing entry id to rewind to.");
			const result = await ctx.navigateTree(entryId);
			if (result.cancelled) throw new Error("Rewind was cancelled.");
		},
	});

	pi.registerCommand("desktop-mcp-auth", {
		description: "Internal: start MCP auth for a server without exposing the transport command",
		handler: async (args, ctx) => {
			const server = args.trim();
			if (!server) {
				ctx.ui.notify("Missing MCP server name.", "warning");
				return;
			}
			pi.sendUserMessage(`/mcp-auth ${server}`, { expandPromptTemplates: true });
		},
	});

	pi.registerCommand("desktop-report-active-tools", {
		description: "Internal: report the active tool list for session verification",
		handler: async () => {
			const tools = pi.getActiveTools();
			pi.sendMessage(
				{
					customType: "desktop-active-tools",
					content: JSON.stringify({ tools }),
					display: false,
					details: { tools },
				},
				{ triggerTurn: false },
			);
		},
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await maybeAutoTitleSession(pi, ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (ctx.mode !== "rpc") return undefined;
		if (!needsApproval(mode, event.toolName, alwaysAllowed)) return undefined;

		const payload = JSON.stringify({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.input,
		});
		// Passing the turn's signal dismisses the prompt if the run is aborted while waiting.
		const choice = await ctx.ui.select(
			`${PERMISSION_PROMPT_MARKER}${payload}`,
			[OPTIONS.allow, OPTIONS.always, OPTIONS.deny],
			{ signal: ctx.signal },
		);

		if (choice === OPTIONS.always) {
			alwaysAllowed.add(event.toolName);
			return undefined;
		}
		if (choice === OPTIONS.allow) return undefined;
		return {
			block: true,
			reason: "The user denied this tool call in Cosmos. Do not retry it; ask the user how they want to proceed.",
		};
	});
}
