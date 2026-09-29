import type {
	LiveSessionState,
	PermissionMode,
	SessionEventBatch,
	SessionExit,
} from "@shared/ipc";
import {
	type ImageContent,
	type Model,
	PERMISSION_OPTIONS,
	PERMISSION_PROMPT_MARKER,
	type PermissionPromptPayload,
	type SessionEntry,
	type SessionState,
	type SessionStats,
	type SlashCommandInfo,
	type ThinkingLevel,
} from "@shared/pi-types";
import { api, basename, errorMessage } from "../lib/api";
import {
	applyRecord,
	type ChatState,
	chatFromEntries,
	firstUserMessage,
	lastAssistantText,
	mergeReloadedChat,
	noticeItem,
} from "./chat-model";
import {
	type Attachment,
	activeTab,
	autoTitleFromFirstMessage,
	getTab,
	newTab,
	sessionTitle,
	type TabState,
	toast,
	updateTab,
	useStore,
} from "./store";

const cmd = <T = unknown>(
	tabId: string,
	command: { type: string; [key: string]: unknown },
) => api.sendCommand<T>(tabId, command);

function applyLatestAssistantDuration(
	chat: ChatState,
	durationMs: number | undefined,
): ChatState {
	if (!durationMs || durationMs <= 0) return chat;
	for (let index = chat.items.length - 1; index >= 0; index--) {
		const item = chat.items[index];
		if (item.kind !== "assistant") continue;
		const items = chat.items.slice();
		items[index] = { ...item, durationMs };
		return { ...chat, items };
	}
	return chat;
}

function suppressHiddenPrompts(chat: ChatState, hiddenPrompts: string[]): { chat: ChatState; hiddenPrompts: string[] } {
	if (hiddenPrompts.length === 0) return { chat, hiddenPrompts };
	let items = chat.items;
	const remaining = [...hiddenPrompts];
	for (let hiddenIndex = remaining.length - 1; hiddenIndex >= 0; hiddenIndex--) {
		const hidden = remaining[hiddenIndex]?.trim();
		if (!hidden) {
			remaining.splice(hiddenIndex, 1);
			continue;
		}
		for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex--) {
			const item = items[itemIndex];
			if (item.kind !== "user" || item.images.length > 0) continue;
			if (item.text.trim() !== hidden) continue;
			items = [...items.slice(0, itemIndex), ...items.slice(itemIndex + 1)];
			remaining.splice(hiddenIndex, 1);
			break;
		}
	}
	return { chat: items === chat.items ? chat : { ...chat, items }, hiddenPrompts: remaining };
}

// ---- Boot ------------------------------------------------------------------

export async function bootstrap(): Promise<void> {
	const [appInfo, settings] = await Promise.all([
		api.getAppInfo(),
		api.getSettings(),
	]);
	useStore.setState({ appInfo, settings });
	applyTheme(settings.theme);

	api.onSessionEvents(handleEventBatch);
	api.onSessionExit(handleExit);
	api.onSessionsChanged(() => void refreshSessions());
	api.onSettingsChanged((next) => {
		const prev = useStore.getState().settings;
		useStore.setState({ settings: next });
		applyTheme(next.theme);
		if (prev.permissionMode !== next.permissionMode) {
			void syncPermissionModeToOpenTabs(next.permissionMode);
		}
		if (
			prev.agentDirPath !== next.agentDirPath ||
			prev.glayvinHomePath !== next.glayvinHomePath ||
			prev.workspaceRootPath !== next.workspaceRootPath
		) {
			void api
				.getAppInfo()
				.then((updated) => useStore.setState({ appInfo: updated }));
		}
	});
	api.onAuthChanged(() => void onCredentialsChanged());
	api.onNotificationClick((tabId) => {
		if (getTab(tabId)) activateTab(tabId);
	});
	window.addEventListener("focus", () => markActiveRead());

	await refreshSessions();
	void refreshProviders();

	const live = await api.getLiveSessions();
	if (await restoreLiveSessions(live)) return;

	// Start where the user left off: a fresh session in their most recent project.
	const lastProject = settings.recentProjects[0];
	if (lastProject) void startNewSession(lastProject);
	else useStore.setState({ pendingNewSession: true });
}

async function restoreLiveSessions(live: LiveSessionState): Promise<boolean> {
	if (live.tabs.length === 0) return false;
	const tabs = Object.fromEntries(
		live.tabs.map((tab) => [
			tab.tabId,
			{
				...newTab(
					tab.tabId,
					tab.cwd,
					tab.permissionMode,
					tab.sessionPath,
					tab.openedAt,
				),
				opened: true,
				status: "starting" as const,
				isStreaming: tab.isStreaming,
				isCompacting: tab.isCompacting,
				dialogs: tab.dialogs.map((dialog) => ({ ...dialog, receivedAt: Date.now() })),
				statuses: tab.statuses,
				widgets: tab.widgets,
			},
		]),
	);
	const activeTabId =
		live.visibleTabId && tabs[live.visibleTabId]
			? live.visibleTabId
			: [...live.tabs].sort((a, b) => b.openedAt - a.openedAt)[0]?.tabId ?? null;
	useStore.setState({
		tabs,
		activeTabId,
		pendingNewSession: false,
		focusComposerTick: activeTabId ? useStore.getState().focusComposerTick + 1 : 0,
	});
	api.setVisibleSession(activeTabId);
	await Promise.allSettled(live.tabs.map((tab) => loadTab(tab.tabId)));
	updateBadge();
	return true;
}

export function applyTheme(theme: "system" | "light" | "dark"): void {
	if (theme === "system") delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = theme;
}

export async function refreshSessions(): Promise<void> {
	try {
		const sessions = await api.listSessions();
		useStore.setState({ sessions, sessionsLoaded: true });
		const query = useStore.getState().searchQuery;
		if (query.trim()) await runSearch(query);
	} catch (error) {
		api.log("error", `listSessions failed: ${errorMessage(error)}`);
		useStore.setState({ sessionsLoaded: true });
	}
}

export async function runSearch(query: string): Promise<void> {
	useStore.setState({ searchQuery: query });
	if (!query.trim()) {
		useStore.setState({ searchMatches: null });
		return;
	}
	const matches = await api.searchSessions(query);
	if (useStore.getState().searchQuery === query)
		useStore.setState({ searchMatches: matches });
}

export async function refreshProviders(): Promise<void> {
	try {
		useStore.setState({ providers: await api.listProviders() });
	} catch (error) {
		api.log("warn", `listProviders failed: ${errorMessage(error)}`);
	}
}

async function onCredentialsChanged(): Promise<void> {
	await refreshProviders();
	// Processes restart with the new credentials; re-read models once they are back.
	const tab = activeTab();
	if (tab && !tab.isStreaming) await loadTab(tab.tabId);
}

async function syncPermissionModeToOpenTabs(
	mode: PermissionMode,
): Promise<void> {
	const tabs = Object.values(useStore.getState().tabs);
	useStore.setState((state) => ({
		tabs: Object.fromEntries(
			Object.entries(state.tabs).map(([tabId, tab]) => [
				tabId,
				{ ...tab, permissionMode: mode },
			]),
		),
	}));
	await Promise.allSettled(
		tabs
			.filter((tab) => tab.opened)
			.map((tab) => cmd(tab.tabId, { type: "desktop_set_permission_mode", mode })),
	);
}

// ---- Opening sessions ------------------------------------------------------

export function tabForSession(sessionPath: string): TabState | undefined {
	return Object.values(useStore.getState().tabs).find(
		(tab) => tab.sessionPath === sessionPath,
	);
}

export function activateTab(tabId: string): void {
	useStore.setState((state) => ({
		activeTabId: tabId,
		pendingNewSession: false,
		focusComposerTick: state.focusComposerTick + 1,
	}));
	api.setVisibleSession(tabId);
	updateTab(tabId, () => ({ unread: false }));
	updateBadge();
}

export async function openExistingSession(
	sessionPath: string,
	cwd: string,
): Promise<void> {
	const existing = tabForSession(sessionPath);
	if (existing) return activateTab(existing.tabId);
	await createTab(cwd, sessionPath);
}

export async function startNewSession(cwd?: string): Promise<void> {
	const folder = cwd ?? useStore.getState().settings.recentProjects[0];
	if (!folder) {
		useStore.setState({ pendingNewSession: true, activeTabId: null });
		api.setVisibleSession(null);
		return;
	}
	// Reuse an untouched new session in the same folder instead of stacking empty ones.
	const blank = Object.values(useStore.getState().tabs).find(
		(tab) =>
			tab.cwd === folder &&
			tab.status !== "error" &&
			tab.chat.items.length === 0 &&
			!tab.isStreaming,
	);
	if (blank) {
		activateTab(blank.tabId);
		return;
	}
	await createTab(folder);
}

export async function startFreshSession(
	cwd?: string,
): Promise<string | undefined> {
	const folder = cwd ?? useStore.getState().settings.recentProjects[0];
	if (!folder) {
		useStore.setState({ pendingNewSession: true, activeTabId: null });
		api.setVisibleSession(null);
		return undefined;
	}
	return await createTab(folder);
}

export async function chooseFolderAndStart(): Promise<void> {
	const folder = await api.pickFolder();
	if (folder) await startNewSession(folder);
}

export function showWorkspaceDashboard(): void {
	useStore.setState({ activeTabId: null, pendingNewSession: true });
	api.setVisibleSession(null);
}

async function createTab(
	cwd: string,
	sessionPath?: string,
): Promise<string | undefined> {
	const permissionMode = useStore.getState().settings.permissionMode;
	const tabId = crypto.randomUUID();
	// Show the session right away; pi can take a moment to boot.
	useStore.setState((state) => ({
		tabs: {
			...state.tabs,
			[tabId]: newTab(tabId, cwd, permissionMode, sessionPath),
		},
	}));
	activateTab(tabId);
	try {
		await api.openSession({ tabId, cwd, sessionPath, permissionMode });
	} catch (error) {
		updateTab(tabId, () => ({
			status: "error",
			error: errorMessage(error),
			opened: false,
		}));
		return undefined;
	}
	updateTab(tabId, () => ({ opened: true }));
	await loadTab(tabId);
	return tabId;
}

/** Retry after a failed start: reopen the process if it never came up, else reload. */
export async function retryTab(tabId: string): Promise<void> {
	const tab = getTab(tabId);
	if (!tab) return;
	if (tab.opened) return loadTab(tabId);
	updateTab(tabId, () => ({ status: "starting", error: undefined }));
	try {
		await api.openSession({
			tabId,
			cwd: tab.cwd,
			sessionPath: tab.sessionPath,
			permissionMode: tab.permissionMode,
		});
		updateTab(tabId, () => ({ opened: true }));
		await loadTab(tabId);
	} catch (error) {
		updateTab(tabId, () => ({ status: "error", error: errorMessage(error) }));
	}
}

/** (Re)load everything about a session from its pi process. */
export async function loadTab(tabId: string): Promise<void> {
	try {
		const [state, entries, models, levels, commands, stats] = await Promise.all([
			cmd<SessionState>(tabId, { type: "get_state" }),
			cmd<{ entries: SessionEntry[]; leafId: string | null }>(tabId, {
				type: "get_entries",
			}),
			cmd<{ models: Model[] }>(tabId, { type: "get_available_models" }),
			cmd<{ levels: ThinkingLevel[] }>(tabId, {
				type: "get_available_thinking_levels",
			}),
			cmd<{ commands: SlashCommandInfo[] }>(tabId, { type: "get_commands" }),
			cmd<SessionStats>(tabId, { type: "get_session_stats" }).catch(
				() => undefined,
			),
		]);
		useStore.setState({ models: models.models });
		updateTab(tabId, (tab) => {
			const suppressed = suppressHiddenPrompts(
				mergeReloadedChat(tab.chat, chatFromEntries(entries.entries, entries.leafId)),
				tab.hiddenPrompts,
			);
			const autoTitle =
				tab.autoTitle || autoTitleFromFirstMessage(firstUserMessage(suppressed.chat));
			return {
				status: "ready",
				error: undefined,
				sessionPath: state.sessionFile ?? tab.sessionPath,
				sessionId: state.sessionId,
				name: state.sessionName,
				autoTitle,
				model:
					state.model && state.model.provider !== "unknown" ? state.model : undefined,
				thinkingLevel: state.thinkingLevel,
				thinkingLevels: levels.levels,
				isStreaming: state.isStreaming,
				isCompacting: state.isCompacting,
				commands: commands.commands.filter((c) => !c.name.startsWith("desktop-")),
				stats,
				chat: suppressed.chat,
				hiddenPrompts: suppressed.hiddenPrompts,
			};
		});
	} catch (error) {
		updateTab(tabId, () => ({ status: "error", error: errorMessage(error) }));
	}
}

async function refreshAfterRun(tabId: string): Promise<void> {
	try {
		const [entries, stats, state] = await Promise.all([
			cmd<{ entries: SessionEntry[]; leafId: string | null }>(tabId, {
				type: "get_entries",
			}),
			cmd<SessionStats>(tabId, { type: "get_session_stats" }).catch(
				() => undefined,
			),
			cmd<SessionState>(tabId, { type: "get_state" }),
		]);
		updateTab(tabId, (tab) => {
			const nextChat = tab.isStreaming
				? tab.chat
				: mergeReloadedChat(tab.chat, chatFromEntries(entries.entries, entries.leafId));
			const suppressed = suppressHiddenPrompts(nextChat, tab.hiddenPrompts);
			const autoTitle =
				tab.autoTitle || autoTitleFromFirstMessage(firstUserMessage(suppressed.chat));
			return {
				// A run that started while we were fetching owns the transcript now.
				chat: suppressed.chat,
				hiddenPrompts: suppressed.hiddenPrompts,
				stats: stats ?? tab.stats,
				sessionPath: state.sessionFile ?? tab.sessionPath,
				name: state.sessionName,
				autoTitle,
			};
		});
	} catch (error) {
		api.log("warn", `refresh after run failed: ${errorMessage(error)}`);
	}
}

export async function closeTab(tabId: string): Promise<void> {
	const { activeTabId } = useStore.getState();
	useStore.setState((state) => {
		const { [tabId]: _removed, ...rest } = state.tabs;
		return {
			tabs: rest,
			activeTabId: state.activeTabId === tabId ? null : state.activeTabId,
		};
	});
	if (activeTabId === tabId) {
		useStore.setState({ pendingNewSession: true });
		api.setVisibleSession(null);
	}
	await api.closeSession(tabId).catch(() => undefined);
	updateBadge();
}

// ---- Events from pi --------------------------------------------------------

function handleEventBatch(batch: SessionEventBatch): void {
	const tab = getTab(batch.tabId);
	if (!tab) return;
	let chat = tab.chat;
	const patch: Partial<TabState> = {};
	let settled = false;
	let settledDurationMs: number | undefined;
	const dialogs = [...tab.dialogs];
	let statuses = tab.statuses;
	let widgets = tab.widgets;

	for (const record of batch.records) {
		chat = applyRecord(chat, record);
		switch (record.type) {
			case "agent_start":
				patch.isStreaming = true;
				patch.runStartedAt ??= Date.now();
				break;
			case "agent_settled":
				settledDurationMs = tab.runStartedAt
					? Date.now() - tab.runStartedAt
					: patch.runStartedAt
						? Date.now() - patch.runStartedAt
						: undefined;
				patch.isStreaming = false;
				patch.runStartedAt = undefined;
				patch.retry = undefined;
				settled = true;
				break;
			case "queue_update":
				patch.queue = { steering: record.steering, followUp: record.followUp };
				break;
			case "session_info_changed":
				patch.name = record.name;
				break;
			case "thinking_level_changed":
				patch.thinkingLevel = record.level;
				break;
			case "compaction_start":
				patch.isCompacting = true;
				break;
			case "compaction_end":
				patch.isCompacting = false;
				break;
			case "auto_retry_start":
				patch.retry = {
					attempt: record.attempt,
					maxAttempts: record.maxAttempts,
					delayMs: record.delayMs,
					message: record.errorMessage,
					at: Date.now(),
				};
				break;
			case "auto_retry_end":
				patch.retry = undefined;
				break;
			case "bash_execution_update":
				chat = appendBashOutput(chat, record.delta);
				break;
			case "extension_ui_request":
				switch (record.method) {
					case "select":
					case "confirm":
					case "input":
					case "editor":
						dialogs.push({ ...record, receivedAt: Date.now() });
						notifyAttention(batch.tabId, record);
						break;
					case "notify":
						toast(record.notifyType ?? "info", record.message);
						break;
					case "setStatus": {
						const { [record.statusKey]: _old, ...rest } = statuses;
						statuses = record.statusText
							? { ...rest, [record.statusKey]: record.statusText }
							: rest;
						break;
					}
					case "setWidget": {
						const { [record.widgetKey]: _old, ...rest } = widgets;
						widgets = record.widgetLines?.length
							? {
									...rest,
									[record.widgetKey]: {
										lines: record.widgetLines,
										placement: record.widgetPlacement ?? "aboveEditor",
									},
								}
							: rest;
						break;
					}
					case "set_editor_text":
						patch.draft = record.text;
						break;
				}
				break;
		}
	}

	if (settledDurationMs)
		chat = applyLatestAssistantDuration(chat, settledDurationMs);
	updateTab(batch.tabId, (tab) => {
		const suppressed = suppressHiddenPrompts(chat, tab.hiddenPrompts);
		const autoTitle =
			tab.autoTitle || autoTitleFromFirstMessage(firstUserMessage(suppressed.chat));
		return {
			...patch,
			autoTitle,
			chat: suppressed.chat,
			hiddenPrompts: suppressed.hiddenPrompts,
			dialogs,
			statuses,
			widgets,
		};
	});
	if (settled) onRunSettled(batch.tabId);
}

/** `!command` output streams into the running shell item (one runs at a time per session). */
function appendBashOutput(chat: ChatState, delta: string): ChatState {
	for (let i = chat.items.length - 1; i >= 0; i--) {
		const item = chat.items[i];
		if (item.kind === "bash" && item.running) {
			const items = chat.items.slice();
			items[i] = { ...item, output: item.output + delta };
			return { ...chat, items };
		}
	}
	return chat;
}

function onRunSettled(tabId: string): void {
	void refreshAfterRun(tabId);
	const tab = getTab(tabId);
	if (!tab) return;
	const { activeTabId } = useStore.getState();
	const visible = document.hasFocus() && activeTabId === tabId;
	if (!visible) {
		updateTab(tabId, () => ({ unread: true }));
		updateBadge();
		const summary = useStore
			.getState()
			.sessions.find((s) => s.path === tab.sessionPath);
		const text = lastAssistantText(tab.chat)
			.replace(/[#*`>_]/g, "")
			.trim();
		api.notify({
			title: sessionTitle(
				summary ?? { name: tab.name },
				basename(tab.cwd),
				firstUserMessage(tab.chat),
				tab.autoTitle,
			),
			body: text || "Finished",
			tabId,
		});
	}
}

function notifyAttention(
	tabId: string,
	record: { method: string; title?: string },
): void {
	const { activeTabId } = useStore.getState();
	updateBadge();
	if (document.hasFocus() && activeTabId === tabId) return;
	const permission = record.title ? parsePermissionPrompt(record.title) : null;
	api.notify({
		title: permission ? "Pi needs permission" : "Pi is waiting for you",
		body: permission
			? describeToolCall(permission.toolName, permission.args)
			: (record.title ?? "Input needed"),
		tabId,
	});
}

function handleExit(exit: SessionExit): void {
	const tab = getTab(exit.tabId);
	if (!tab) return;
	if (exit.reason === "suspended") {
		// The process restarts transparently on the next command; nothing to show.
		updateTab(exit.tabId, () => ({ isStreaming: false, dialogs: [] }));
		return;
	}
	updateTab(exit.tabId, (t) => ({
		isStreaming: false,
		isCompacting: false,
		dialogs: [],
		chat: {
			...t.chat,
			items: [
				...t.chat.items,
				noticeItem(
					"error",
					`pi stopped unexpectedly. It will restart on your next message.${exit.message ? `\n\n${exit.message}` : ""}`,
				),
			],
		},
	}));
	updateBadge();
}

export function updateBadge(): void {
	const count = Object.values(useStore.getState().tabs).filter(
		(tab) => tab.unread || tab.dialogs.length > 0,
	).length;
	api.setBadgeCount(count);
}

function markActiveRead(): void {
	const tab = activeTab();
	if (tab?.unread) {
		updateTab(tab.tabId, () => ({ unread: false }));
		updateBadge();
	}
}

// ---- Permission prompts ------------------------------------------------------

export function parsePermissionPrompt(
	title: string,
): PermissionPromptPayload | null {
	if (!title.startsWith(PERMISSION_PROMPT_MARKER)) return null;
	try {
		return JSON.parse(
			title.slice(PERMISSION_PROMPT_MARKER.length),
		) as PermissionPromptPayload;
	} catch {
		return null;
	}
}

export function describeToolCall(
	toolName: string,
	args: Record<string, unknown>,
): string {
	const path = typeof args.path === "string" ? args.path : undefined;
	switch (toolName) {
		case "bash":
			return `Run: ${String(args.command ?? "")}`;
		case "edit":
			return `Edit ${path ?? "a file"}`;
		case "write":
			return `Write ${path ?? "a file"}`;
		default:
			return `Use ${toolName}`;
	}
}

export async function answerDialog(
	tabId: string,
	requestId: string,
	response: { value?: string; confirmed?: boolean; cancelled?: boolean },
): Promise<void> {
	updateTab(tabId, (tab) => ({
		dialogs: tab.dialogs.filter((d) => d.id !== requestId),
	}));
	updateBadge();
	try {
		await api.respondToUi(tabId, { id: requestId, ...response });
	} catch (error) {
		toast("error", errorMessage(error));
	}
}

export function answerPermission(
	tabId: string,
	requestId: string,
	choice: keyof typeof PERMISSION_OPTIONS,
): Promise<void> {
	return answerDialog(tabId, requestId, { value: PERMISSION_OPTIONS[choice] });
}

/** Dialogs with a timeout are auto-resolved by pi; drop them locally when they expire. */
export function expireDialogs(): void {
	const now = Date.now();
	for (const tab of Object.values(useStore.getState().tabs)) {
		const live = tab.dialogs.filter(
			(d) =>
				!("timeout" in d && d.timeout) ||
				now - d.receivedAt < (d.timeout as number),
		);
		if (live.length !== tab.dialogs.length)
			updateTab(tab.tabId, () => ({ dialogs: live }));
	}
}

// ---- Sending -----------------------------------------------------------------

export interface DesktopCommand {
	name: string;
	description: string;
	run(tabId: string, args: string): Promise<void> | void;
}

export const DESKTOP_COMMANDS: DesktopCommand[] = [
	{
		name: "compact",
		description: "Summarize older context to free up space",
		run: (tabId, args) => compact(tabId, args),
	},
	{
		name: "name",
		description: "Rename this session",
		run: (tabId, args) => renameSession(tabId, args),
	},
	{
		name: "new",
		description: "Start a new session in this project",
		run: (tabId) => startNewSession(getTab(tabId)?.cwd),
	},
	{
		name: "fork",
		description: "Branch into a new session (same history)",
		run: (tabId) => cloneSession(tabId),
	},
	{
		name: "export",
		description: "Export this session as HTML",
		run: (tabId) => exportHtml(tabId),
	},
	{
		name: "copy",
		description: "Copy the last response",
		run: (tabId) => copyLastResponse(tabId),
	},
	{
		name: "session",
		description: "Show token usage and cost",
		run: (tabId) => showStats(tabId),
	},
];

export function setDraft(tabId: string, draft: string): void {
	updateTab(tabId, () => ({ draft }));
}

export function addAttachments(tabId: string, attachments: Attachment[]): void {
	updateTab(tabId, (tab) => ({
		attachments: [...tab.attachments, ...attachments],
	}));
}

export function removeAttachment(tabId: string, id: string): void {
	updateTab(tabId, (tab) => ({
		attachments: tab.attachments.filter((a) => a.id !== id),
	}));
}

export async function sendDraft(
	tabId: string,
	mode?: "steer" | "followUp",
): Promise<void> {
	const tab = getTab(tabId);
	if (!tab) return;
	const text = tab.draft;
	const trimmed = text.trim();
	const attachments = tab.attachments;
	if (!trimmed && attachments.length === 0) return;

	// `!cmd` runs a shell command and adds its output to context; `!!cmd` keeps it out.
	if (trimmed.startsWith("!") && attachments.length === 0) {
		updateTab(tabId, () => ({ draft: "" }));
		const exclude = trimmed.startsWith("!!");
		return runBash(tabId, trimmed.slice(exclude ? 2 : 1).trim(), exclude, text);
	}

	const slash = /^\/(\S+)\s*([\s\S]*)$/.exec(trimmed);
	const desktop = slash && DESKTOP_COMMANDS.find((c) => c.name === slash[1]);
	if (desktop && slash) {
		updateTab(tabId, () => ({ draft: "" }));
		await desktop.run(tabId, slash[2].trim());
		return;
	}

	updateTab(tabId, () => ({ draft: "", attachments: [] }));
	const images: ImageContent[] = attachments.map((a) => a.image);
	const command: Record<string, unknown> = { type: "prompt", message: text };
	if (images.length) command.images = images;
	if (tab.isStreaming)
		command.streamingBehavior = mode ?? useStore.getState().settings.busySendMode;
	try {
		await cmd(tabId, command as { type: string });
	} catch (error) {
		// Put the message back so nothing typed is lost.
		updateTab(tabId, (t) => ({
			draft: t.draft ? `${text}\n\n${t.draft}` : text,
			attachments: [...attachments, ...t.attachments],
		}));
		reportSendError(error);
	}
}

function reportSendError(error: unknown): void {
	const message = errorMessage(error);
	if (/No API key|login|No model/i.test(message)) {
		toast("error", "No model provider is connected yet.", {
			label: "Connect a provider",
			run: () => useStore.setState({ settingsPane: "providers" }),
		});
	} else {
		toast("error", message);
	}
}

let bashCounter = 0;
async function runBash(
	tabId: string,
	command: string,
	excludeFromContext: boolean,
	original: string,
): Promise<void> {
	if (!command) return;
	if (
		getTab(tabId)?.chat.items.some((item) => item.kind === "bash" && item.running)
	) {
		updateTab(tabId, () => ({ draft: original }));
		return toast(
			"warning",
			"A shell command is already running in this session.",
		);
	}
	const key = `bash:live:${Date.now()}:${++bashCounter}`;
	updateTab(tabId, (tab) => ({
		chat: {
			...tab.chat,
			items: [
				...tab.chat.items,
				{
					kind: "bash",
					key,
					command,
					output: "",
					cancelled: false,
					running: true,
					excludeFromContext,
				},
			],
		},
	}));
	try {
		const result = await cmd<{
			output: string;
			exitCode?: number;
			cancelled: boolean;
		}>(tabId, {
			type: "bash",
			command,
			excludeFromContext,
		});
		updateTab(tabId, (tab) => ({
			chat: {
				...tab.chat,
				items: tab.chat.items.map((item) =>
					item.key === key && item.kind === "bash"
						? {
								...item,
								output: result.output,
								exitCode: result.exitCode,
								cancelled: result.cancelled,
								running: false,
							}
						: item,
				),
			},
		}));
	} catch (error) {
		updateTab(tabId, (tab) => ({
			draft: original,
			chat: {
				...tab.chat,
				items: tab.chat.items.filter((item) => item.key !== key),
			},
		}));
		toast("error", errorMessage(error));
	}
}

export async function stop(tabId: string): Promise<void> {
	const tab = getTab(tabId);
	if (!tab) return;
	// Cancel open prompts first, otherwise a pending permission would block the abort.
	for (const dialog of tab.dialogs)
		void answerDialog(tabId, dialog.id, { cancelled: true });
	try {
		await restoreQueue(tabId);
		if (tab.retry)
			await cmd(tabId, { type: "abort_retry" }).catch(() => undefined);
		await cmd(tabId, { type: "abort" });
	} catch (error) {
		toast("error", errorMessage(error));
	}
}

/** Pull queued messages back into the composer without stopping the run. */
export async function restoreQueue(tabId: string): Promise<void> {
	try {
		const cleared = await cmd<{ steering: string[]; followUp: string[] }>(tabId, {
			type: "clear_queue",
		});
		const restored = [...cleared.steering, ...cleared.followUp].join("\n\n");
		if (restored)
			updateTab(tabId, (t) => ({
				draft: t.draft ? `${restored}\n\n${t.draft}` : restored,
			}));
	} catch (error) {
		toast("error", errorMessage(error));
	}
}

// ---- Session controls -------------------------------------------------------------

export async function setModel(tabId: string, model: Model): Promise<void> {
	try {
		const next = await cmd<Model>(tabId, {
			type: "set_model",
			provider: model.provider,
			modelId: model.id,
		});
		const levels = await cmd<{ levels: ThinkingLevel[] }>(tabId, {
			type: "get_available_thinking_levels",
		});
		const state = await cmd<SessionState>(tabId, { type: "get_state" });
		updateTab(tabId, () => ({
			model: next,
			thinkingLevels: levels.levels,
			thinkingLevel: state.thinkingLevel,
		}));
	} catch (error) {
		toast("error", errorMessage(error));
	}
}

export async function setThinkingLevel(
	tabId: string,
	level: ThinkingLevel,
): Promise<void> {
	try {
		await cmd(tabId, { type: "set_thinking_level", level });
		updateTab(tabId, () => ({ thinkingLevel: level }));
	} catch (error) {
		toast("error", errorMessage(error));
	}
}

export async function setPermissionMode(
	tabId: string,
	mode: PermissionMode,
): Promise<void> {
	try {
		await cmd(tabId, { type: "desktop_set_permission_mode", mode });
		updateTab(tabId, () => ({ permissionMode: mode }));
		// New sessions start in the most recently chosen mode.
		await api.updateSettings({ permissionMode: mode });
	} catch (error) {
		toast("error", errorMessage(error));
	}
}

export async function compact(
	tabId: string,
	instructions?: string,
): Promise<void> {
	try {
		updateTab(tabId, () => ({ isCompacting: true }));
		await cmd(
			tabId,
			instructions
				? { type: "compact", customInstructions: instructions }
				: { type: "compact" },
		);
		await refreshAfterRun(tabId);
	} catch (error) {
		toast("error", `Compaction failed: ${errorMessage(error)}`);
	} finally {
		updateTab(tabId, () => ({ isCompacting: false }));
	}
}

export async function renameSession(
	tabId: string,
	name: string,
): Promise<void> {
	const trimmed = name.trim();
	if (!trimmed) return;
	try {
		await cmd(tabId, { type: "set_session_name", name: trimmed });
		updateTab(tabId, () => ({ name: trimmed }));
		void refreshSessions();
	} catch (error) {
		toast("error", errorMessage(error));
	}
}

/** Rename a session from the sidebar, opening its process if needed. */
export async function renameSessionByPath(
	sessionPath: string,
	cwd: string,
	name: string,
): Promise<void> {
	let tab = tabForSession(sessionPath);
	if (!tab) {
		await openExistingSession(sessionPath, cwd);
		tab = tabForSession(sessionPath);
	}
	if (tab) await renameSession(tab.tabId, name);
}

/** Edit an earlier message: fork a new session from it and put its text back in the composer. */
export async function forkFromMessage(
	tabId: string,
	entryId: string,
): Promise<void> {
	try {
		const result = await cmd<{ text?: string; cancelled: boolean }>(tabId, {
			type: "fork",
			entryId,
		});
		if (result.cancelled) return;
		updateTab(tabId, () => ({
			chat: { items: [], tools: {} },
			draft: result.text ?? "",
		}));
		await loadTab(tabId);
		useStore.setState((s) => ({ focusComposerTick: s.focusComposerTick + 1 }));
		toast("info", "Forked into a new session. Edit the message and send.");
		void refreshSessions();
	} catch (error) {
		toast("error", errorMessage(error));
	}
}

export async function cloneSession(tabId: string): Promise<void> {
	try {
		const result = await cmd<{ cancelled: boolean }>(tabId, { type: "clone" });
		if (result.cancelled) return;
		await loadTab(tabId);
		toast("info", "Forked into a new session.");
		void refreshSessions();
	} catch (error) {
		toast("error", errorMessage(error));
	}
}

export async function exportHtml(tabId: string): Promise<void> {
	const tab = getTab(tabId);
	if (!tab) return;
	const name = `${(tab.name ?? basename(tab.cwd)).replace(/[^\w.-]+/g, "-")}.html`;
	const outputPath = await api.showSaveDialog(name);
	if (!outputPath) return;
	try {
		const { path } = await cmd<{ path: string }>(tabId, {
			type: "export_html",
			outputPath,
		});
		toast("info", "Exported session.", {
			label: "Open",
			run: () => void api.openPath(path),
		});
	} catch (error) {
		toast("error", errorMessage(error));
	}
}

export async function copyLastResponse(tabId: string): Promise<void> {
	const text = lastAssistantText(
		getTab(tabId)?.chat ?? { items: [], tools: {} },
	);
	if (!text) return toast("info", "Nothing to copy yet.");
	await api.copyText(text);
	toast("info", "Copied the last response.");
}

async function showStats(tabId: string): Promise<void> {
	try {
		const stats = await cmd<SessionStats>(tabId, { type: "get_session_stats" });
		updateTab(tabId, () => ({ stats }));
		const context =
			stats.contextUsage?.percent == null
				? ""
				: ` · context ${Math.round(stats.contextUsage.percent)}%`;
		toast(
			"info",
			`${stats.tokens.total.toLocaleString()} tokens · $${stats.cost.toFixed(4)}${context}`,
		);
	} catch (error) {
		toast("error", errorMessage(error));
	}
}

export async function deleteSession(sessionPath: string): Promise<void> {
	const tab = tabForSession(sessionPath);
	if (tab) await closeTab(tab.tabId);
	try {
		await api.deleteSession(sessionPath);
		const pinned = useStore.getState().settings.pinnedSessions;
		if (pinned.includes(sessionPath))
			await api.updateSettings({
				pinnedSessions: pinned.filter((p) => p !== sessionPath),
			});
		toast("info", "Session moved to the Trash.");
	} catch (error) {
		toast("error", errorMessage(error));
	}
}

export async function togglePin(sessionPath: string): Promise<void> {
	const pinned = useStore.getState().settings.pinnedSessions;
	const next = pinned.includes(sessionPath)
		? pinned.filter((p) => p !== sessionPath)
		: [sessionPath, ...pinned];
	await api.updateSettings({ pinnedSessions: next });
}
