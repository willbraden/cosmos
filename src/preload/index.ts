import { contextBridge, ipcRenderer, type IpcRendererEvent, webUtils } from "electron";
import type { DesktopApi } from "../shared/ipc";

function subscribe<T>(channel: string) {
	return (listener: (payload: T) => void): (() => void) => {
		const handler = (_event: IpcRendererEvent, payload: T) => listener(payload);
		ipcRenderer.on(channel, handler);
		return () => ipcRenderer.removeListener(channel, handler);
	};
}

const api: DesktopApi = {
	getAppInfo: () => ipcRenderer.invoke("app:info"),
	getSettings: () => ipcRenderer.invoke("settings:get"),
	updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),

	listSessions: () => ipcRenderer.invoke("sessions:list"),
	searchSessions: (query) => ipcRenderer.invoke("sessions:search", query),
	deleteSession: (path) => ipcRenderer.invoke("sessions:delete", path),
	sessionContextMenu: (path, pinned) => ipcRenderer.invoke("sessions:context-menu", path, pinned),

	openSession: (request) => ipcRenderer.invoke("session:open", request),
	sendCommand: (tabId, command) => ipcRenderer.invoke("session:command", tabId, command),
	respondToUi: (tabId, response) => ipcRenderer.invoke("session:ui-response", tabId, response),
	closeSession: (tabId) => ipcRenderer.invoke("session:close", tabId),
	setVisibleSession: (tabId) => ipcRenderer.send("session:visible", tabId),

	pickFolder: () => ipcRenderer.invoke("dialog:pick-folder"),
	searchFiles: (cwd, query) => ipcRenderer.invoke("files:search", cwd, query),
	getPathForFile: (file) => {
		try {
			return webUtils.getPathForFile(file);
		} catch {
			return "";
		}
	},
	openPath: (path) => ipcRenderer.invoke("shell:open-path", path),
	revealPath: (path) => ipcRenderer.invoke("shell:reveal", path),
	openInEditor: (path, line) => ipcRenderer.invoke("shell:open-in-editor", path, line),
	openTerminal: (cwd) => ipcRenderer.invoke("shell:open-terminal", cwd),
	openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
	copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
	showSaveDialog: (defaultName) => ipcRenderer.invoke("dialog:save", defaultName),

	listProviders: () => ipcRenderer.invoke("auth:providers"),
	login: (providerId, method) => ipcRenderer.invoke("auth:login", providerId, method),
	answerAuthPrompt: (promptId, value) => ipcRenderer.send("auth:answer", promptId, value),
	cancelLogin: () => ipcRenderer.send("auth:cancel"),
	logout: (providerId) => ipcRenderer.invoke("auth:logout", providerId),

	notify: (options) => ipcRenderer.send("app:notify", options),
	setBadgeCount: (count) => ipcRenderer.send("app:badge", count),
	log: (level, message) => ipcRenderer.send("app:log", level, message),

	onSessionEvents: subscribe("session:events"),
	onSessionExit: subscribe("session:exit"),
	onSessionsChanged: subscribe("sessions:changed"),
	onAuthEvent: subscribe("auth:event"),
	onAuthPrompt: subscribe("auth:prompt"),
	onAuthChanged: subscribe("auth:changed"),
	onMenuCommand: subscribe("menu:command"),
	onNotificationClick: subscribe("notification:click"),
	onSettingsChanged: subscribe("settings:changed"),
};

contextBridge.exposeInMainWorld("pi", api);
