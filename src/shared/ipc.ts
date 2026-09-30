// Contract shared by the main process, preload bridge, and renderer.
// Pi protocol records are passed through as plain JSON (see pi-types.ts).

import type { ExtensionUiRequest, PiRecord } from "./pi-types";

export type PermissionMode = "ask" | "acceptEdits" | "auto";
export type ThemePreference = "system" | "light" | "dark";

/** Identifies a model well enough to re-select it; the full record comes from pi. */
export interface ModelRef {
	provider: string;
	id: string;
}

export interface DesktopSettings {
	theme: ThemePreference;
	/** Permission mode applied to new sessions. */
	permissionMode: PermissionMode;
	/** Model applied to sessions started from Home. Null uses pi's own default. */
	defaultModel: ModelRef | null;
	notifications: boolean;
	/** Minutes a background, idle session keeps its pi process before it is suspended. 0 disables suspension. */
	idleSuspendMinutes: number;
	/** Absolute path to a pi CLI entry script. Empty uses the bundled pi. */
	piCliPath: string;
	/** Absolute path to a pi agent dir (settings.json, auth.json, sessions/). Empty uses pi's default/inherited location. */
	agentDirPath: string;
	/** Optional absolute GLAYVIN_HOME override for custom installs. Empty uses the environment or an inferred value. */
	glayvinHomePath: string;
	/** Absolute path to the Cosmos workspace root. Empty uses ~/Cosmos. */
	workspaceRootPath: string;
	/** GitHub org used to build clone URLs for the core company repos. Empty uses the built-in default. */
	coreRepoOrg: string;
	/** Session file paths pinned to the top of the sidebar. */
	pinnedSessions: string[];
	/** Manual per-folder session order for sidebar accordion sections. */
	sidebarSessionOrder: Record<string, string[]>;
	/** Most recently used project folders, newest first. */
	recentProjects: string[];
	/** Message send behaviour while pi is working. */
	busySendMode: "steer" | "followUp";
	sidebarCollapsed: boolean;
	/** Enables hidden developer-only tools like UI inspect mode. */
	developerMode: boolean;
	/** When enabled, Cosmos can use chat context to pause likely Figma-design prompts until Figma MCP is available. */
	figmaChatContextGate: boolean;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
	theme: "system",
	permissionMode: "ask",
	defaultModel: null,
	notifications: true,
	idleSuspendMinutes: 15,
	piCliPath: "",
	agentDirPath: "",
	glayvinHomePath: "",
	workspaceRootPath: "",
	coreRepoOrg: "",
	pinnedSessions: [],
	sidebarSessionOrder: {},
	recentProjects: [],
	busySendMode: "steer",
	sidebarCollapsed: false,
	developerMode: false,
	figmaChatContextGate: false,
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
	glayvinHome?: string;
	workspaceRoot: string;
	agentDirSource: "cosmos-managed" | "glayvin" | "custom";
	logPath: string;
}

export interface WorkspaceRepoHealth {
	name: string;
	path: string;
	exists: boolean;
	isDirectory: boolean;
	isGitRepo: boolean;
	/** True when the workspace entry is a symlink pointing at a checkout elsewhere. */
	isSymlink: boolean;
	/** Absolute target of the symlink, when `isSymlink` is true. */
	linkTarget?: string;
	/** Clone URL for the curated core repos. Absent for experiments. */
	cloneUrl?: string;
}

/** Streamed while a long-running workspace operation (currently `git clone`) runs. */
export interface WorkspaceProgress {
	name: string;
	message: string;
}

export interface WorkspaceHealth {
	rootPath: string;
	rootExists: boolean;
	rootIsDirectory: boolean;
	/** Curated sibling repos expected in the shared Cosmos workspace. */
	repos: WorkspaceRepoHealth[];
	/** Other sibling directories under the workspace root, treated as experiments. */
	experiments: WorkspaceRepoHealth[];
	readyRepos: number;
}

export interface WorktreeSupport {
	available: boolean;
	repoPath: string;
	managedRoot: string;
	gitBinary: boolean;
	isGitRepo: boolean;
	reason?: string;
}

export interface McpServerDefinition {
	name: string;
	active: boolean;
	personal: boolean;
	disabled: boolean;
	transport: string;
	url?: string;
	command?: string;
	args: string[];
	auth?: string;
	tools: string[];
	oauthConnected?: boolean;
	oauthTokensPath?: string;
	sessionAvailable?: boolean;
	sessionAvailabilityMessage?: string;
	config: Record<string, unknown>;
}

export interface McpConfigOverview {
	available: boolean;
	glayvinHome?: string;
	agentDir: string;
	mergedConfigPath?: string;
	personalConfigPath?: string;
	personalDisabledPath?: string;
	adapterConfigPath?: string;
	servers: McpServerDefinition[];
	notes: string[];
}

/** Which configuration layer a Glayvin pack manifest was found in. */
export type GlayvinPackLayer = "built-in" | "team" | "local" | "unknown";

export interface GlayvinPackSummary {
	id: string;
	layer: GlayvinPackLayer;
	/** Set when `layer` is "team": the registered team name the manifest was found under. */
	teamName?: string;
	manifestPath?: string;
	description?: string;
	packageCount: number;
	extensionCount: number;
	skillCount: number;
	commandCount: number;
	hookCount: number;
}

export interface GlayvinTeamSummary {
	name: string;
	path: string;
	exists: boolean;
	/** Pack ids resolved from this team's directory. */
	packIds: string[];
}

export interface GlayvinPackageSummary {
	name: string;
	version?: string;
	/** Pack id that contributed this package. */
	pack?: string;
	/** True when Cosmos deliberately keeps this package out of its managed agent directory. */
	excludedByCosmos: boolean;
}

export interface GlayvinProfileOverview {
	available: boolean;
	glayvinHome?: string;
	resolvedPath?: string;
	configPath?: string;
	/** Active profile id, e.g. "default". */
	profile?: string;
	/** Fully resolved pack list, which can include packs the profile manifest never named. */
	packs: GlayvinPackSummary[];
	teams: GlayvinTeamSummary[];
	packages: GlayvinPackageSummary[];
	notes: string[];
}

export interface FigmaXcodeAuthStatus {
	xcodeInstalled: boolean;
	xcodeAppPath?: string;
	xcodePluginInstalled: boolean;
	xcodeHasFigmaServer: boolean;
	xcodeHasBearerToken: boolean;
	xcodeMcpConfigPath: string;
	xcodePluginPath: string;
	piOAuthConnected: boolean;
	piOAuthTokensPath: string;
}

export interface FigmaXcodeImportResult {
	imported: boolean;
	alreadyConnected: boolean;
	message: string;
	status: FigmaXcodeAuthStatus;
}

export interface FigmaAuthResetResult {
	removed: boolean;
	message: string;
	status: FigmaXcodeAuthStatus;
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

export type LiveDialogRequest = Extract<
	ExtensionUiRequest,
	{ method: "select" | "confirm" | "input" | "editor" }
>;

export interface SessionWidgetState {
	lines: string[];
	placement: "aboveEditor" | "belowEditor";
}

export interface LiveSessionSnapshot {
	tabId: string;
	openedAt: number;
	cwd: string;
	sessionPath?: string;
	permissionMode: PermissionMode;
	isStreaming: boolean;
	isCompacting: boolean;
	dialogs: LiveDialogRequest[];
	statuses: Record<string, string>;
	widgets: Record<string, SessionWidgetState>;
}

export interface LiveSessionState {
	visibleTabId: string | null;
	tabs: LiveSessionSnapshot[];
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
	| {
			kind: "select";
			options: { id: string; label: string; description?: string }[];
	  }
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

export type SessionMenuAction =
	| "rename"
	| "pin"
	| "unpin"
	| "reveal"
	| "copyPath"
	| "exportHtml"
	| "delete";

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
	| "trash-session"
	| "next-session"
	| "prev-session"
	| "focus-composer"
	| "reset-figma"
	| "share-feedback";

/** Surface exposed on `window.pi` by the preload script. */
export interface DesktopApi {
	getAppInfo(): Promise<AppInfo>;
	getSettings(): Promise<DesktopSettings>;
	updateSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
	getWorkspaceHealth(): Promise<WorkspaceHealth>;
	/** `git clone` a curated core repo into the workspace root. */
	cloneWorkspaceRepo(name: string): Promise<WorkspaceHealth>;
	/** Pick an existing checkout anywhere on disk and symlink it into the workspace root. */
	linkWorkspaceRepo(name: string): Promise<WorkspaceHealth>;
	/** Pick any folder and symlink it into the workspace root under its own name. */
	linkExistingProject(): Promise<WorkspaceHealth | null>;
	/** Remove a workspace symlink. Never touches real directories. */
	unlinkWorkspaceRepo(name: string): Promise<WorkspaceHealth>;
	getMcpOverview(): Promise<McpConfigOverview>;
	/** Read-only view of the Glayvin profile, packs, and registered teams. */
	getGlayvinProfileOverview(): Promise<GlayvinProfileOverview>;
	getFigmaXcodeAuthStatus(): Promise<FigmaXcodeAuthStatus>;
	launchFigmaXcodePluginInstall(): Promise<void>;
	importXcodeFigmaAuth(): Promise<FigmaXcodeImportResult>;
	resetFigmaAuth(): Promise<FigmaAuthResetResult>;
	upsertPersonalMcpServer(
		name: string,
		config: Record<string, unknown>,
	): Promise<McpConfigOverview>;
	removePersonalMcpServer(name: string): Promise<McpConfigOverview>;

	listSessions(): Promise<SessionSummary[]>;
	searchSessions(query: string): Promise<string[]>;
	deleteSession(path: string): Promise<void>;
	sessionContextMenu(
		path: string,
		pinned: boolean,
	): Promise<SessionMenuAction | null>;

	openSession(request: OpenSessionRequest): Promise<void>;
	getLiveSessions(): Promise<LiveSessionState>;
	sendCommand<T = unknown>(tabId: string, command: PiCommand): Promise<T>;
	respondToUi(tabId: string, response: Record<string, unknown>): Promise<void>;
	closeSession(tabId: string): Promise<void>;
	setVisibleSession(tabId: string | null): void;

	pickFolder(): Promise<string | null>;
	createExperiment(name: string): Promise<string>;
	searchFiles(cwd: string, query: string): Promise<FileMatch[]>;
	getWorktreeSupport(cwd: string): Promise<WorktreeSupport>;
	previewManagedWorktree(
		cwd: string,
		taskGroupId: string,
		workerId: string,
	): Promise<{ path: string; branch: string }>;
	listFiles(cwd: string, dir?: string): Promise<string[]>;
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
	onWorkspaceProgress(listener: (progress: WorkspaceProgress) => void): () => void;
	onAuthEvent(listener: (event: AuthProgressEvent) => void): () => void;
	onAuthPrompt(listener: (prompt: AuthPromptRequest) => void): () => void;
	onAuthChanged(listener: () => void): () => void;
	onMenuCommand(listener: (command: MenuCommand) => void): () => void;
	onNotificationClick(listener: (tabId: string) => void): () => void;
	onSettingsChanged(listener: (settings: DesktopSettings) => void): () => void;
}
