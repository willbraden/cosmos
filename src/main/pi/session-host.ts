import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { runtimeLog as log } from "../runtime-log";
import type {
	LiveDialogRequest,
	LiveSessionState,
	OpenSessionRequest,
	PermissionMode,
	PiCommand,
	SessionEventBatch,
	SessionExit,
	SessionWidgetState,
} from "../../shared/ipc";
import type {
	ExtensionUiRequest,
	PiRecord,
	SessionState,
} from "../../shared/pi-types";
import { PERMISSION_MODE_COMMAND } from "../../shared/pi-types";
import { PiProcess } from "./pi-process";

export interface HostEnvironment {
	nodePath: string;
	launcherPath: string;
	cliPath(): string;
	extensionPath: string;
	env(): Promise<NodeJS.ProcessEnv>;
	workspaceRoot(): string;
	idleSuspendMinutes(): number;
}

interface Tab {
	id: string;
	openedAt: number;
	cwd: string;
	sessionPath?: string;
	permissionMode: PermissionMode;
	proc: PiProcess | null;
	starting: Promise<PiProcess> | null;
	busy: boolean;
	isCompacting: boolean;
	/** Dialog requests awaiting an answer; a tab with open dialogs is never suspended. */
	openDialogs: Set<string>;
	dialogRequests: Map<string, LiveDialogRequest>;
	statuses: Record<string, string>;
	widgets: Record<string, SessionWidgetState>;
	lastActivity: number;
	/** Restart once idle, e.g. after credentials changed. */
	stale: boolean;
	stopping: boolean;
}

/** Commands after which pi may be attached to a different session file. */
const SESSION_CHANGING = new Set([
	"new_session",
	"switch_session",
	"fork",
	"clone",
]);
const RESTART_SAFE_COMMANDS = new Set([
	"get_state",
	"get_entries",
	"get_available_models",
	"get_available_thinking_levels",
	"get_commands",
	"get_session_stats",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_MODES = new Set<PermissionMode>(["ask", "acceptEdits", "auto"]);
const FLUSH_MS = 16;
/** A live mode switch is a local extension command; if pi is wedged, fall back to a restart. */
const MODE_SYNC_TIMEOUT_MS = 5_000;

export class SessionHost {
	private readonly tabs = new Map<string, Tab>();
	private visibleTabId: string | null = null;
	private queued: SessionEventBatch[] = [];
	private flushTimer: NodeJS.Timeout | null = null;
	private disposed = false;
	private readonly idleTimer: NodeJS.Timeout;

	constructor(
		private readonly host: HostEnvironment,
		private readonly sink: {
			events(batches: SessionEventBatch[]): void;
			exit(exit: SessionExit): void;
		},
	) {
		this.idleTimer = setInterval(() => this.suspendIdleTabs(), 60_000);
		this.idleTimer.unref();
	}

	async open(request: OpenSessionRequest): Promise<void> {
		if (typeof request.tabId !== "string" || !UUID.test(request.tabId))
			throw new Error("Invalid session id");
		if (this.tabs.has(request.tabId))
			throw new Error("Session id already in use");
		if (!isExistingDirectory(request.cwd))
			throw new Error(`Project folder does not exist: ${request.cwd}`);
		if (request.sessionPath !== undefined) {
			if (
				!isAbsolute(request.sessionPath) ||
				!request.sessionPath.endsWith(".jsonl")
			) {
				throw new Error("Invalid session path");
			}
			if (!existsSync(request.sessionPath))
				throw new Error(`Session file not found: ${request.sessionPath}`);
		}
		const now = Date.now();
		const tab: Tab = {
			id: request.tabId,
			openedAt: now,
			cwd: request.cwd,
			sessionPath: request.sessionPath,
			permissionMode: VALID_MODES.has(request.permissionMode)
				? request.permissionMode
				: "ask",
			proc: null,
			starting: null,
			busy: false,
			isCompacting: false,
			openDialogs: new Set(),
			dialogRequests: new Map(),
			statuses: {},
			widgets: {},
			lastActivity: now,
			stale: false,
			stopping: false,
		};
		this.tabs.set(tab.id, tab);
		try {
			await this.ensureProcess(tab);
		} catch (error) {
			this.tabs.delete(tab.id);
			throw error;
		}
	}

	async command(tabId: string, command: PiCommand): Promise<unknown> {
		const tab = this.requireTab(tabId);
		tab.lastActivity = Date.now();

		// Desktop-only pseudo command. The bridge extension registers a slash command that
		// updates its mode in place, and pi runs extension commands inline even mid-turn, so
		// the change applies to the tool call that is prompting right now. Restarting the
		// process (which re-reads PI_DESKTOP_PERMISSION_MODE) is only the fallback.
		if (command.type === "desktop_set_permission_mode") {
			const mode = command.mode as PermissionMode;
			if (!VALID_MODES.has(mode)) throw new Error("Invalid permission mode");
			tab.permissionMode = mode;
			const proc = tab.proc;
			if (!proc?.running) return null;
			try {
				await proc.request(
					{ type: "prompt", message: `/${PERMISSION_MODE_COMMAND} ${mode}` },
					MODE_SYNC_TIMEOUT_MS,
				);
				tab.stale = false;
			} catch (error) {
				log.warn(
					`[pi ${proc.pid}] live permission mode switch failed, falling back to restart: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				if (tab.busy || tab.openDialogs.size > 0) tab.stale = true;
				else await this.suspend(tab, "permission mode changed");
			}
			return null;
		}

		const proc = await this.ensureProcess(tab);
		if (
			command.type === "prompt" ||
			command.type === "steer" ||
			command.type === "follow_up"
		)
			tab.busy = true;
		try {
			const data = await proc.request(command);
			if (SESSION_CHANGING.has(command.type))
				await this.refreshSessionPath(tab, proc);
			return data;
		} catch (error) {
			if (!this.shouldRetryAfterRestart(command.type, error)) throw error;
			const restarted = await this.ensureProcess(tab);
			return await restarted.request(command);
		}
	}

	respondToUi(tabId: string, response: Record<string, unknown>): void {
		const tab = this.requireTab(tabId);
		if (typeof response.id !== "string")
			throw new Error("UI response needs the request id");
		tab.openDialogs.delete(response.id);
		tab.dialogRequests.delete(response.id);
		tab.lastActivity = Date.now();
		// Only these fields are part of the extension_ui_response record.
		const record: Record<string, unknown> = {
			type: "extension_ui_response",
			id: response.id,
		};
		if (response.cancelled === true) record.cancelled = true;
		else if (typeof response.confirmed === "boolean")
			record.confirmed = response.confirmed;
		else if (typeof response.value === "string") record.value = response.value;
		else record.cancelled = true;
		tab.proc?.send(record);
	}

	setVisible(tabId: string | null): void {
		this.visibleTabId = tabId && this.tabs.has(tabId) ? tabId : null;
		const tab = this.visibleTabId ? this.tabs.get(this.visibleTabId) : undefined;
		if (tab) tab.lastActivity = Date.now();
	}

	snapshot(): LiveSessionState {
		return {
			visibleTabId:
				this.visibleTabId && this.tabs.has(this.visibleTabId)
					? this.visibleTabId
					: null,
			tabs: [...this.tabs.values()].map((tab) => ({
				tabId: tab.id,
				openedAt: tab.openedAt,
				cwd: tab.cwd,
				sessionPath: tab.sessionPath,
				permissionMode: tab.permissionMode,
				isStreaming: tab.busy,
				isCompacting: tab.isCompacting,
				dialogs: [...tab.dialogRequests.values()],
				statuses: { ...tab.statuses },
				widgets: Object.fromEntries(
					Object.entries(tab.widgets).map(([key, widget]) => [
						key,
						{ lines: [...widget.lines], placement: widget.placement },
					]),
				),
			})),
		};
	}

	async close(tabId: string): Promise<void> {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		this.tabs.delete(tabId);
		await this.stopProcess(tab);
	}

	/** Credentials changed: restart idle processes now, busy ones once they settle. */
	restartForNewCredentials(): void {
		for (const tab of this.tabs.values()) {
			if (!tab.proc) continue;
			if (tab.busy || tab.openDialogs.size > 0) tab.stale = true;
			else void this.suspend(tab, "credentials changed");
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		clearInterval(this.idleTimer);
		// Let in-flight starts settle so none spawns pi after shutdown began.
		await Promise.allSettled([...this.tabs.values()].map((tab) => tab.starting));
		await Promise.all(
			[...this.tabs.values()].map((tab) => this.stopProcess(tab)),
		);
		this.tabs.clear();
	}

	// ---------------------------------------------------------------------------

	private requireTab(tabId: string): Tab {
		const tab = typeof tabId === "string" ? this.tabs.get(tabId) : undefined;
		if (!tab) throw new Error("Unknown session");
		return tab;
	}

	private shouldRetryAfterRestart(commandType: string, error: unknown): boolean {
		if (!RESTART_SAFE_COMMANDS.has(commandType)) return false;
		const message = error instanceof Error ? error.message : String(error);
		return (
			message.includes("pi exited (") ||
			message.includes("pi process is not running")
		);
	}

	private ensureProcess(tab: Tab): Promise<PiProcess> {
		if (tab.proc?.running) return Promise.resolve(tab.proc);
		tab.starting ??= this.startProcess(tab).finally(() => {
			tab.starting = null;
		});
		return tab.starting;
	}

	private async startProcess(tab: Tab): Promise<PiProcess> {
		const args = [
			this.host.launcherPath,
			this.host.cliPath(),
			"--mode",
			"rpc",
			"-e",
			this.host.extensionPath,
		];
		// A new session only gets a file once it has messages; resume it only if it exists.
		if (tab.sessionPath && existsSync(tab.sessionPath))
			args.push("--session", tab.sessionPath);

		const baseEnv = await this.host.env();
		if (this.disposed) throw new Error("Cosmos is shutting down");
		const proc = new PiProcess({
			command: this.host.nodePath,
			args,
			cwd: tab.cwd,
			env: {
				...baseEnv,
				...(process.env.PI_CODING_AGENT_DIR
					? { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR }
					: {}),
				...(process.env.GLAYVIN_HOME
					? { GLAYVIN_HOME: process.env.GLAYVIN_HOME }
					: {}),
				// MCP servers that ship UI resources otherwise pop a browser tab,
				// which sends the user out of Cosmos to read a tool result.
				// Suppressing the viewer returns the result inline instead.
				MCP_UI_VIEWER: baseEnv.MCP_UI_VIEWER ?? "none",
				ELECTRON_RUN_AS_NODE: "1",
				PI_DESKTOP: "1",
				COSMOS_DESKTOP: "1",
				COSMOS_WORKSPACE_ROOT: this.host.workspaceRoot(),
				COSMOS_SESSION_CWD: tab.cwd,
				PI_DESKTOP_PERMISSION_MODE: tab.permissionMode,
			},
		});

		proc.on("record", (record: PiRecord) => this.handleRecord(tab, record));
		proc.on("stderr", (text: string) =>
			log.debug(`[pi ${proc.pid}] ${text.trimEnd()}`),
		);
		proc.once(
			"exit",
			(code: number | null, signal: string | null, stderrTail: string) => {
				if (tab.proc === proc) tab.proc = null;
				tab.busy = false;
				tab.isCompacting = false;
				tab.openDialogs.clear();
				tab.dialogRequests.clear();
				if (tab.stopping || !this.tabs.has(tab.id)) return;
				log.error(
					`pi exited unexpectedly (code ${code}, signal ${signal}) for ${tab.sessionPath ?? tab.cwd}`,
					stderrTail,
				);
				this.flush();
				this.sink.exit({
					tabId: tab.id,
					reason: "crashed",
					message: lastLines(stderrTail, 12),
				});
			},
		);

		proc.start();
		tab.proc = proc;
		try {
			// Pi answers get_state once its runtime is ready; this doubles as the startup check.
			const state = await proc.request<SessionState>(
				{ type: "get_state" },
				60_000,
			);
			tab.sessionPath = state.sessionFile ?? tab.sessionPath;
		} catch (error) {
			const stderr = lastLines(proc.recentStderr, 12);
			await proc.stop(500).catch(() => undefined);
			if (tab.proc === proc) tab.proc = null;
			throw new Error(
				`pi failed to start: ${(error as Error).message}${stderr ? `\n${stderr}` : ""}`,
			);
		}
		return proc;
	}

	private async refreshSessionPath(tab: Tab, proc: PiProcess): Promise<void> {
		const state = await proc.request<SessionState>({ type: "get_state" }, 15_000);
		tab.sessionPath = state.sessionFile ?? tab.sessionPath;
	}

	private handleRecord(tab: Tab, record: PiRecord): void {
		switch (record.type) {
			case "agent_start":
				tab.busy = true;
				break;
			case "agent_settled":
				tab.busy = false;
				tab.lastActivity = Date.now();
				if (tab.stale && tab.openDialogs.size === 0)
					void this.suspend(tab, "permission mode changed");
				break;
			case "compaction_start":
				tab.isCompacting = true;
				break;
			case "compaction_end":
				tab.isCompacting = false;
				break;
			case "queue_update":
				tab.lastActivity = Date.now();
				break;
			case "extension_ui_request":
				this.applyUiRequest(tab, record);
				break;
		}
		this.enqueue(tab.id, record);
	}

	private applyUiRequest(tab: Tab, record: ExtensionUiRequest): void {
		switch (record.method) {
			case "select":
			case "confirm":
			case "input":
			case "editor":
				tab.openDialogs.add(record.id);
				tab.dialogRequests.set(record.id, record);
				break;
			case "setStatus": {
				const { [record.statusKey]: _old, ...rest } = tab.statuses;
				tab.statuses = record.statusText
					? { ...rest, [record.statusKey]: record.statusText }
					: rest;
				break;
			}
			case "setWidget": {
				const { [record.widgetKey]: _old, ...rest } = tab.widgets;
				tab.widgets = record.widgetLines?.length
					? {
							...rest,
							[record.widgetKey]: {
								lines: [...record.widgetLines],
								placement: record.widgetPlacement ?? "aboveEditor",
							},
						}
					: rest;
				break;
			}
		}
	}

	private enqueue(tabId: string, record: PiRecord): void {
		const last = this.queued[this.queued.length - 1];
		if (last?.tabId === tabId) last.records.push(record);
		else this.queued.push({ tabId, records: [record] });
		this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
	}

	private flush(): void {
		this.flushTimer = null;
		if (this.queued.length === 0) return;
		const batches = this.queued;
		this.queued = [];
		this.sink.events(batches);
	}

	private suspendIdleTabs(): void {
		const minutes = this.host.idleSuspendMinutes();
		if (minutes <= 0) return;
		const cutoff = Date.now() - minutes * 60_000;
		for (const tab of this.tabs.values()) {
			if (!tab.proc?.running || tab.busy || tab.openDialogs.size > 0) continue;
			if (tab.id === this.visibleTabId || tab.lastActivity > cutoff) continue;
			void this.suspend(tab, "idle");
		}
	}

	private async suspend(
		tab: Tab,
		reason: "idle" | "credentials changed" | "permission mode changed",
	): Promise<void> {
		log.info(
			`Stopping pi process (${reason}; restarts on next use) for ${tab.sessionPath ?? tab.cwd}`,
		);
		tab.stale = false;
		await this.stopProcess(tab);
		this.flush();
		this.sink.exit({ tabId: tab.id, reason: "suspended" });
	}

	private async stopProcess(tab: Tab): Promise<void> {
		const proc = tab.proc;
		if (!proc) return;
		tab.stopping = true;
		try {
			await proc.stop();
		} finally {
			tab.stopping = false;
			if (tab.proc === proc) tab.proc = null;
			tab.busy = false;
			tab.isCompacting = false;
			tab.openDialogs.clear();
			tab.dialogRequests.clear();
		}
	}
}

function lastLines(text: string, count: number): string {
	return text.trimEnd().split("\n").slice(-count).join("\n");
}

function isExistingDirectory(path: string): boolean {
	try {
		return (
			typeof path === "string" && isAbsolute(path) && statSync(path).isDirectory()
		);
	} catch {
		return false;
	}
}
