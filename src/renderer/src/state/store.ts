import type { AppInfo, DesktopSettings, PermissionMode, ProviderInfo, SessionSummary } from "@shared/ipc";
import { DEFAULT_SETTINGS } from "@shared/ipc";
import type {
	ExtensionUiRequest,
	ImageContent,
	Model,
	SessionStats,
	SlashCommandInfo,
	ThinkingLevel,
} from "@shared/pi-types";
import { create } from "zustand";
import { summarizeSessionTitle } from "../lib/session-title";
import { type ChatState, EMPTY_CHAT, isHiddenUserPromptText } from "./chat-model";

export type DialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }> & {
	receivedAt: number;
};

export interface Attachment {
	id: string;
	name: string;
	image: ImageContent;
}

export interface FigmaAssistState {
	blockedPrompt: string;
	blockedAttachments: Attachment[];
	message: string;
}

export interface TabState {
	tabId: string;
	openedAt: number;
	cwd: string;
	sessionPath?: string;
	sessionId?: string;
	name?: string;
	autoTitle?: string;
	status: "starting" | "ready" | "error";
	/** The main process has a pi process registered for this tab. */
	opened: boolean;
	error?: string;
	chat: ChatState;
	model?: Model;
	thinkingLevel: ThinkingLevel;
	thinkingLevels: ThinkingLevel[];
	isStreaming: boolean;
	isCompacting: boolean;
	runStartedAt?: number;
	retry?: { attempt: number; maxAttempts: number; delayMs: number; message: string; at: number };
	queue: { steering: string[]; followUp: string[] };
	stats?: SessionStats;
	dialogs: DialogRequest[];
	statuses: Record<string, string>;
	widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
	permissionMode: PermissionMode;
	commands: SlashCommandInfo[];
	draft: string;
	attachments: Attachment[];
	hiddenPrompts: string[];
	figmaAssist?: FigmaAssistState;
	unread: boolean;
}

export interface Toast {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
	action?: { label: string; run(): void };
}

export type SettingsPane =
	| "general"
	| "providers"
	| "teams"
	| "mcps"
	| "glayvin"
	| "about";

export interface AppStore {
	appInfo?: AppInfo;
	settings: DesktopSettings;
	sessions: SessionSummary[];
	sessionsLoaded: boolean;
	searchQuery: string;
	/** Session paths matching a full-text search, or null when not searching. */
	searchMatches: string[] | null;
	tabs: Record<string, TabState>;
	activeTabId: string | null;
	/** Shown when there is no active session: pick a folder to start one. */
	pendingNewSession: boolean;
	models: Model[];
	providers: ProviderInfo[];
	settingsPane: SettingsPane | null;
	feedbackOpen: boolean;
	changesOpen: boolean;
	toasts: Toast[];
	focusComposerTick: number;
	focusSearchTick: number;
	/** Bumped when a join changes what a team layer publishes, so Home refetches. */
	workspaceRevision: number;
}

export const useStore = create<AppStore>(() => ({
	settings: DEFAULT_SETTINGS,
	sessions: [],
	sessionsLoaded: false,
	searchQuery: "",
	searchMatches: null,
	tabs: {},
	activeTabId: null,
	pendingNewSession: false,
	models: [],
	providers: [],
	settingsPane: null,
	feedbackOpen: false,
	changesOpen: false,
	toasts: [],
	focusComposerTick: 0,
	focusSearchTick: 0,
	workspaceRevision: 0,
}));

export function newTab(
	tabId: string,
	cwd: string,
	permissionMode: PermissionMode,
	sessionPath?: string,
	openedAt = Date.now(),
): TabState {
	return {
		tabId,
		openedAt,
		cwd,
		sessionPath,
		status: "starting",
		opened: false,
		chat: EMPTY_CHAT,
		thinkingLevel: "off",
		thinkingLevels: ["off"],
		isStreaming: false,
		isCompacting: false,
		queue: { steering: [], followUp: [] },
		dialogs: [],
		statuses: {},
		widgets: {},
		permissionMode,
		commands: [],
		draft: "",
		attachments: [],
		hiddenPrompts: [],
		figmaAssist: undefined,
		unread: false,
	};
}

export function updateTab(tabId: string, update: (tab: TabState) => Partial<TabState> | TabState): void {
	useStore.setState((state) => {
		const tab = state.tabs[tabId];
		if (!tab) return state;
		return { tabs: { ...state.tabs, [tabId]: { ...tab, ...update(tab) } } };
	});
}

export function getTab(tabId: string | null | undefined): TabState | undefined {
	return tabId ? useStore.getState().tabs[tabId] : undefined;
}

export function activeTab(): TabState | undefined {
	return getTab(useStore.getState().activeTabId);
}

let toastId = 0;
export function toast(level: Toast["level"], message: string, action?: Toast["action"]): void {
	const id = ++toastId;
	useStore.setState((state) => ({ toasts: [...state.toasts.slice(-3), { id, level, message, action }] }));
	setTimeout(() => dismissToast(id), level === "error" ? 9000 : 5000);
}

export function dismissToast(id: number): void {
	useStore.setState((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
}

export function autoTitleFromFirstMessage(firstMessage: string | undefined): string {
	if (!firstMessage || isHiddenUserPromptText(firstMessage)) return "";
	return summarizeSessionTitle(firstMessage);
}

/** Display title for a session: explicit name, else a frozen auto-title from its first message. */
export function sessionTitle(
	summary: { name?: string; firstMessage?: string } | undefined,
	fallback = "New session",
	_liveFirstMessage?: string,
	frozenAutoTitle?: string,
): string {
	const explicit = summary?.name?.trim();
	const text =
		explicit ||
		frozenAutoTitle ||
		autoTitleFromFirstMessage(summary?.firstMessage);
	if (!text) return fallback;
	return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
