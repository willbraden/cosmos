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
