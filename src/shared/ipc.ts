// Contract shared by the main process, preload bridge, and renderer.
// Pi protocol records are passed through as plain JSON (see pi-types.ts).

import type { PiRecord } from "./pi-types";

export type PermissionMode = "ask" | "acceptEdits" | "auto";
export type ThemePreference = "system" | "light" | "dark";

export interface DesktopSettings {
	theme: ThemePreference;
	/** Permission mode applied to new sessions. */
	permissionMode: PermissionMode;
	notifications: boolean;
	/** Minutes a background, idle session keeps its pi process before it is suspended. 0 disables suspension. */
	idleSuspendMinutes: number;
	/** Absolute path to a pi CLI entry script. Empty uses the bundled pi. */
	piCliPath: string;
	/** Session file paths pinned to the top of the sidebar. */
	pinnedSessions: string[];
	/** Most recently used project folders, newest first. */
	recentProjects: string[];
	/** Message send behaviour while pi is working. */
	busySendMode: "steer" | "followUp";
	sidebarCollapsed: boolean;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
	theme: "system",
	permissionMode: "ask",
	notifications: true,
	idleSuspendMinutes: 15,
	piCliPath: "",
	pinnedSessions: [],
	recentProjects: [],
	busySendMode: "steer",
	sidebarCollapsed: false,
};

export interface SessionSummary {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	/** Epoch milliseconds (UTC). */
	created: number;
	modified: number;
	messageCount: number;
	firstMessage: string;
}

export interface AppInfo {
	appVersion: string;
	piVersion: string;
	electronVersion: string;
	platform: NodeJS.Platform;
	homeDir: string;
	agentDir: string;
	logPath: string;
}

export interface OpenSessionRequest {
	/** Chosen by the renderer (a UUID) so it can show the session before pi finishes booting. */
	tabId: string;
	/** Existing session file to resume. Omit to start a new session in `cwd`. */
	sessionPath?: string;
	cwd: string;
	permissionMode: PermissionMode;
}

/** A pi RPC command without the correlation id (the main process assigns it). */
export type PiCommand = { type: string; [key: string]: unknown };

export interface SessionEventBatch {
	tabId: string;
	records: PiRecord[];
}

export interface SessionExit {
	tabId: string;
	/** "suspended" exits are deliberate; the process restarts transparently on the next command. */
	reason: "suspended" | "crashed" | "closed";
	message?: string;
}

// ---- Authentication -------------------------------------------------------

export interface ProviderInfo {
	id: string;
	name: string;
	oauth?: { label: string };
	apiKey?: { label: string; interactive: boolean };
	configured: boolean;
	/** Where the active credential comes from, e.g. "OAuth", "ANTHROPIC_API_KEY". */
	source?: string;
	storedCredential?: "oauth" | "api_key";
}

export type AuthPromptRequest = {
	promptId: string;
	message: string;
	placeholder?: string;
} & (
	| { kind: "text" | "secret" | "manual_code" }
	| { kind: "select"; options: { id: string; label: string; description?: string }[] }
);

export type AuthProgressEvent =
	| { type: "info"; message: string; links?: { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string }
	| { type: "progress"; message: string }
	| { type: "done"; providerId: string }
	| { type: "failed"; providerId: string; message: string };

// ---- Files ---------------------------------------------------------------

export interface FileMatch {
	path: string; // relative to the project
	isDirectory: boolean;
}

export type SessionMenuAction = "rename" | "pin" | "unpin" | "reveal" | "copyPath" | "exportHtml" | "delete";

export type MenuCommand =
	| "new-session"
	| "open-folder"
	| "settings"
	| "search"
	| "toggle-sidebar"
	| "toggle-changes"
	| "stop"
	| "compact"
	| "export-html"
	| "next-session"
	| "prev-session"
	| "focus-composer";

/** Surface exposed on `window.pi` by the preload script. */
export interface DesktopApi {
	getAppInfo(): Promise<AppInfo>;
	getSettings(): Promise<DesktopSettings>;
	updateSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;

	listSessions(): Promise<SessionSummary[]>;
	searchSessions(query: string): Promise<string[]>;
	deleteSession(path: string): Promise<void>;
	sessionContextMenu(path: string, pinned: boolean): Promise<SessionMenuAction | null>;

	openSession(request: OpenSessionRequest): Promise<void>;
	sendCommand<T = unknown>(tabId: string, command: PiCommand): Promise<T>;
	respondToUi(tabId: string, response: Record<string, unknown>): Promise<void>;
	closeSession(tabId: string): Promise<void>;
	setVisibleSession(tabId: string | null): void;

	pickFolder(): Promise<string | null>;
	searchFiles(cwd: string, query: string): Promise<FileMatch[]>;
	/** Absolute path of a file dropped or pasted from Finder ("" if it has none). */
	getPathForFile(file: File): string;
	openPath(path: string): Promise<void>;
	revealPath(path: string): Promise<void>;
	openInEditor(path: string, line?: number): Promise<void>;
	openTerminal(cwd: string): Promise<void>;
	openExternal(url: string): Promise<void>;
	copyText(text: string): Promise<void>;
	showSaveDialog(defaultName: string): Promise<string | null>;

	listProviders(): Promise<ProviderInfo[]>;
	login(providerId: string, method: "oauth" | "api_key"): Promise<void>;
	answerAuthPrompt(promptId: string, value: string | null): void;
	cancelLogin(): void;
	logout(providerId: string): Promise<void>;

	notify(options: { title: string; body: string; tabId: string }): void;
	setBadgeCount(count: number): void;
	log(level: "info" | "warn" | "error", message: string): void;

	onSessionEvents(listener: (batch: SessionEventBatch) => void): () => void;
	onSessionExit(listener: (exit: SessionExit) => void): () => void;
	onSessionsChanged(listener: () => void): () => void;
	onAuthEvent(listener: (event: AuthProgressEvent) => void): () => void;
	onAuthPrompt(listener: (prompt: AuthPromptRequest) => void): () => void;
	onAuthChanged(listener: () => void): () => void;
	onMenuCommand(listener: (command: MenuCommand) => void): () => void;
	onNotificationClick(listener: (tabId: string) => void): () => void;
	onSettingsChanged(listener: (settings: DesktopSettings) => void): () => void;
}
