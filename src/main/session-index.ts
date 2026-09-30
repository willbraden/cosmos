import { existsSync, type FSWatcher, mkdirSync, watch } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { shell } from "electron";
import log from "electron-log/main";
import type { SessionSummary } from "../shared/ipc";
import { compareSessionSummaries } from "../shared/session-order";

type SessionInfo = Awaited<ReturnType<typeof SessionManager.listAll>>[number];

const SEARCH_LIMIT = 200;
const REFRESH_DEBOUNCE_MS = 400;

/** Explicit override for pi's session folder. Note pi lays this out flat, unlike its default nested folder. */
function sessionDirOverride(): string | null {
	const override = process.env.PI_CODING_AGENT_SESSION_DIR;
	return override ? resolve(override) : null;
}

export function sessionsRoot(): string {
	return sessionDirOverride() ?? join(getAgentDir(), "sessions");
}

/**
 * Sidebar index of every pi session on disk, built with pi's own SessionManager so it
 * follows pi's file format. Kept warm and refreshed when the sessions folder changes.
 */
export class SessionIndex {
	private sessions: SessionInfo[] = [];
	private loading: Promise<void> | null = null;
	private dirty = true;
	private watcher: FSWatcher | null = null;
	private debounce: NodeJS.Timeout | null = null;

	constructor(private readonly onChanged: () => void) {}

	start(): void {
		const root = sessionsRoot();
		try {
			mkdirSync(root, { recursive: true });
			this.watcher = watch(root, { recursive: true }, () =>
				this.scheduleRefresh(),
			);
			this.watcher.on("error", (error) =>
				log.warn("Session folder watcher failed", error),
			);
		} catch (error) {
			log.warn(
				`Cannot watch ${root}; the sidebar refreshes only on demand`,
				error,
			);
		}
	}

	stop(): void {
		this.watcher?.close();
		this.watcher = null;
		if (this.debounce) clearTimeout(this.debounce);
		this.debounce = null;
	}

	restart(): void {
		this.stop();
		this.dirty = true;
		this.start();
		void this.ensureLoaded().then(() => this.onChanged());
	}

	async list(): Promise<SessionSummary[]> {
		await this.ensureLoaded();
		return this.sessions.map(toSummary).sort(compareSessionSummaries);
	}

	/** Full-text search over names and message text. Returns matching session paths. */
	async search(query: string): Promise<string[]> {
		await this.ensureLoaded();
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (terms.length === 0) return [];
		const matches: string[] = [];
		for (const session of this.sessions) {
			const haystack =
				`${session.name ?? ""}\n${session.cwd}\n${session.allMessagesText}`.toLowerCase();
			if (terms.every((term) => haystack.includes(term)))
				matches.push(session.path);
			if (matches.length >= SEARCH_LIMIT) break;
		}
		return matches;
	}

	/** Move a session file to the Trash (recoverable), only if it lives in pi's session folder. */
	async trash(path: string): Promise<void> {
		assertManagedSessionPath(path);
		// Already gone: a second delete, or a sidebar entry that outlived the file. Resync instead of failing.
		if (existsSync(path)) await shell.trashItem(path);
		this.scheduleRefresh();
	}

	private scheduleRefresh(): void {
		this.dirty = true;
		if (this.debounce) clearTimeout(this.debounce);
		this.debounce = setTimeout(() => {
			this.debounce = null;
			void this.ensureLoaded().then(() => this.onChanged());
		}, REFRESH_DEBOUNCE_MS);
	}

	private async ensureLoaded(): Promise<void> {
		while (this.dirty) {
			this.loading ??= this.load().finally(() => {
				this.loading = null;
			});
			await this.loading;
		}
	}

	private async load(): Promise<void> {
		this.dirty = false;
		const started = Date.now();
		try {
			// pi's no-argument listAll() ignores PI_CODING_AGENT_SESSION_DIR, so pass the override
			// through explicitly; otherwise the sidebar lists one folder while trash() validates
			// against another and every delete is rejected.
			const override = sessionDirOverride();
			this.sessions = override
				? await SessionManager.listAll(override)
				: await SessionManager.listAll();
			log.debug(
				`Indexed ${this.sessions.length} sessions in ${Date.now() - started}ms`,
			);
		} catch (error) {
			log.error("Failed to list pi sessions", error);
		}
	}
}

export function isSessionFile(path: string): boolean {
	return isManagedSessionPath(path) && existsSync(path);
}

/**
 * Whether a path is shaped like a session file inside the folder this index manages. Deliberately
 * says nothing about whether the file exists, so callers can tell "not ours" from "already gone".
 */
export function isManagedSessionPath(path: string): boolean {
	if (typeof path !== "string" || !isAbsolute(path) || !path.endsWith(".jsonl"))
		return false;
	const rel = relative(sessionsRoot(), resolve(path));
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function assertManagedSessionPath(path: string): void {
	if (typeof path !== "string" || !isAbsolute(path) || !path.endsWith(".jsonl"))
		throw new Error(`Not a pi session file: ${String(path)}`);
	if (!isManagedSessionPath(path))
		throw new Error(`Session file is outside ${sessionsRoot()}: ${path}`);
}

function isHiddenFirstMessage(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith("/desktop-") || trimmed.startsWith("/mcp-auth ");
}

function toSummary(info: SessionInfo): SessionSummary {
	const firstMessage = isHiddenFirstMessage(info.firstMessage) ? "" : info.firstMessage;
	return {
		path: info.path,
		id: info.id,
		cwd: info.cwd,
		name: info.name,
		parentSessionPath: info.parentSessionPath,
		created: info.created.getTime(),
		modified: info.modified.getTime(),
		messageCount: info.messageCount,
		firstMessage: firstMessage.slice(0, 300),
	};
}
