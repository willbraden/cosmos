// Lean mirror of the pi RPC protocol shapes the desktop app consumes.
// Canonical definitions: @earendil-works/pi-coding-agent src/modes/rpc/rpc-types.ts,
// docs/json.md, docs/message-types.md. Everything here tolerates unknown fields
// and unknown record types, because pi and its extensions can add both.

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	redacted?: boolean;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	provider: string;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	excludeFromContext?: boolean;
	timestamp: number;
}

export interface CustomMessage {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

export interface SystemMessage {
	role: "system";
	timestamp: number;
}

export type AgentMessage =
	| SystemMessage
	| UserMessage
	| AssistantMessage
	| ToolResultMessage
	| BashExecutionMessage
	| CustomMessage
	| BranchSummaryMessage
	| CompactionSummaryMessage;

export interface Model {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SessionState {
	model?: Model;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	messageCount: number;
	pendingMessageCount: number;
}

export interface SessionStats {
	sessionFile?: string;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
}

// ---- Session entries (get_entries) ----------------------------------------

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export type SessionEntry = SessionEntryBase & {
	message?: AgentMessage;
	summary?: string;
	tokensBefore?: number;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	name?: string;
	[key: string]: unknown;
};

// ---- Stdout records -------------------------------------------------------

export type AssistantMessageEvent =
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; content: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
	| { type: string; contentIndex?: number };

export interface ToolResultPayload {
	content: (TextContent | ImageContent)[];
	details?: unknown;
}

export type ExtensionUiRequest = { type: "extension_ui_request"; id: string } & (
	| { method: "select"; title: string; options: string[]; timeout?: number }
	| { method: "confirm"; title: string; message: string; timeout?: number }
	| { method: "input"; title: string; placeholder?: string; timeout?: number }
	| { method: "editor"; title: string; prefill?: string }
	| { method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
	| { method: "setStatus"; statusKey: string; statusText?: string }
	| { method: "setWidget"; widgetKey: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor" }
	| { method: "setTitle"; title: string }
	| { method: "set_editor_text"; text: string }
);

export type PiRecord =
	| { type: "agent_start" }
	| { type: "agent_end"; willRetry?: boolean }
	| { type: "agent_settled" }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; assistantMessageEvent: AssistantMessageEvent; usage?: Usage }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			partialResult: ToolResultPayload;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: ToolResultPayload;
			isError: boolean;
	  }
	| { type: "queue_update"; steering: string[]; followUp: string[] }
	| { type: "session_info_changed"; name?: string }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| {
			type: "compaction_end";
			reason: string;
			result?: { summary: string; tokensBefore: number };
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "bash_execution_update"; id?: string; delta: string }
	| { type: "extension_error"; extensionPath: string; event: string; error: string }
	| ExtensionUiRequest
	| { type: "desktop_session_changed" };

/** Title prefix the bundled desktop extension uses for permission prompts. */
export const PERMISSION_PROMPT_MARKER = "⁣pi-desktop-permission⁣";

export interface PermissionPromptPayload {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
}

export const PERMISSION_OPTIONS = {
	allow: "Allow once",
	always: "Always allow this tool in this session",
	deny: "Deny",
} as const;
