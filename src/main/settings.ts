import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { app } from "electron";
import log from "electron-log/main";
import {
	DEFAULT_SETTINGS,
	type DesktopSettings,
	type PermissionMode,
	type ThemePreference,
} from "../shared/ipc";

const THEMES: ThemePreference[] = ["system", "light", "dark"];
const MODES: PermissionMode[] = ["ask", "acceptEdits", "auto"];
const MAX_RECENT_PROJECTS = 12;

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSessionOrderMap(value: unknown): value is Record<string, string[]> {
	return (
		!!value &&
		typeof value === "object" &&
		Object.entries(value).every(
			([cwd, order]) => isAbsolute(cwd) && isStringArray(order),
		)
	);
}

/**
 * Validate an untrusted settings patch (from disk or the renderer) field by field.
 * Unknown keys and wrongly typed values are dropped rather than trusted.
 */
export function sanitizeSettingsPatch(
	input: unknown,
): Partial<DesktopSettings> {
	if (!input || typeof input !== "object") return {};
	const raw = input as Record<string, unknown>;
	const out: Partial<DesktopSettings> = {};
	if (THEMES.includes(raw.theme as ThemePreference))
		out.theme = raw.theme as ThemePreference;
	if (MODES.includes(raw.permissionMode as PermissionMode))
		out.permissionMode = raw.permissionMode as PermissionMode;
	if (typeof raw.notifications === "boolean")
		out.notifications = raw.notifications;
	if (typeof raw.sidebarCollapsed === "boolean")
		out.sidebarCollapsed = raw.sidebarCollapsed;
	if (typeof raw.developerMode === "boolean")
		out.developerMode = raw.developerMode;
	if (raw.busySendMode === "steer" || raw.busySendMode === "followUp")
		out.busySendMode = raw.busySendMode;
	if (
		typeof raw.idleSuspendMinutes === "number" &&
		Number.isFinite(raw.idleSuspendMinutes)
	) {
		out.idleSuspendMinutes = Math.min(
			24 * 60,
			Math.max(0, Math.round(raw.idleSuspendMinutes)),
		);
	}
	if (
		typeof raw.piCliPath === "string" &&
		(raw.piCliPath === "" || isAbsolute(raw.piCliPath))
	) {
		out.piCliPath = raw.piCliPath;
	}
	if (
		typeof raw.agentDirPath === "string" &&
		(raw.agentDirPath === "" || isAbsolute(raw.agentDirPath))
	) {
		out.agentDirPath = raw.agentDirPath;
	}
	if (
		typeof raw.glayvinHomePath === "string" &&
		(raw.glayvinHomePath === "" || isAbsolute(raw.glayvinHomePath))
	) {
		out.glayvinHomePath = raw.glayvinHomePath;
	}
	if (
		typeof raw.workspaceRootPath === "string" &&
		(raw.workspaceRootPath === "" || isAbsolute(raw.workspaceRootPath))
	) {
		out.workspaceRootPath = raw.workspaceRootPath;
	}
	if (isStringArray(raw.pinnedSessions))
		out.pinnedSessions = [...new Set(raw.pinnedSessions.filter(isAbsolute))];
	if (isSessionOrderMap(raw.sidebarSessionOrder)) {
		out.sidebarSessionOrder = Object.fromEntries(
			Object.entries(raw.sidebarSessionOrder).map(([cwd, order]) => [
				cwd,
				[...new Set(order)],
			]),
		);
	}
	if (isStringArray(raw.recentProjects)) {
		out.recentProjects = [
			...new Set(raw.recentProjects.filter(isAbsolute)),
		].slice(0, MAX_RECENT_PROJECTS);
	}
	return out;
}

export class SettingsStore {
	private settings: DesktopSettings;
	private readonly listeners = new Set<(settings: DesktopSettings) => void>();

	constructor(
		private readonly file = join(app.getPath("userData"), "settings.json"),
	) {
		this.settings = { ...DEFAULT_SETTINGS, ...this.readFromDisk() };
	}

	get(): DesktopSettings {
		return this.settings;
	}

	update(patch: unknown): DesktopSettings {
		this.settings = { ...this.settings, ...sanitizeSettingsPatch(patch) };
		this.writeToDisk();
		for (const listener of this.listeners) listener(this.settings);
		return this.settings;
	}

	addRecentProject(cwd: string): void {
		const recent = [
			cwd,
			...this.settings.recentProjects.filter((p) => p !== cwd),
		];
		this.update({ recentProjects: recent });
	}

	onChange(listener: (settings: DesktopSettings) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private readFromDisk(): Partial<DesktopSettings> {
		try {
			return sanitizeSettingsPatch(JSON.parse(readFileSync(this.file, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				log.warn("Ignoring unreadable settings file", error);
			return {};
		}
	}

	private writeToDisk(): void {
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			// Write-then-rename so a crash mid-write never leaves a truncated file.
			const tmp = `${this.file}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.settings, null, 2));
			renameSync(tmp, this.file);
		} catch (error) {
			log.error("Failed to save settings", error);
		}
	}
}
