import {
	app,
	BrowserWindow,
	Menu,
	type MenuItemConstructorOptions,
	shell,
} from "electron";
import log from "electron-log/main";
import type { MenuCommand } from "../shared/ipc";

export function buildAppMenu(
	dispatch: (command: MenuCommand) => void,
	options: { developerMode: boolean },
): Menu {
	const cmd = (
		label: string,
		command: MenuCommand,
		accelerator?: string,
	): MenuItemConstructorOptions => ({
		label,
		accelerator,
		click: () => dispatch(command),
	});
	const isMac = process.platform === "darwin";
	const closeFocusedWindow = (): void => {
		BrowserWindow.getFocusedWindow()?.close();
	};

	const template: MenuItemConstructorOptions[] = [];
	if (isMac) {
		template.push({
			label: app.name,
			submenu: [
				{ role: "about" },
				{ type: "separator" },
				cmd("Settings…", "settings", "CmdOrCtrl+,"),
				{ type: "separator" },
				{ role: "services" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit" },
			],
		});
	}
	template.push(
		{
			label: "File",
			submenu: [
				cmd("New Session", "new-session", "CmdOrCtrl+N"),
				cmd("Workspace Repos", "open-folder", "CmdOrCtrl+O"),
				{ type: "separator" },
				cmd("Export Session as HTML…", "export-html", "CmdOrCtrl+Shift+E"),
				{ type: "separator" },
				isMac
					? {
						label: "Close Window",
						click: () => closeFocusedWindow(),
					}
					: { role: "quit" },
			],
		},
		{ role: "editMenu" },
		{
			label: "View",
			submenu: [
				cmd("Search Sessions", "search", "CmdOrCtrl+K"),
				cmd("Toggle Sidebar", "toggle-sidebar", "CmdOrCtrl+\\"),
				cmd("Toggle Changes Panel", "toggle-changes", "CmdOrCtrl+Shift+D"),
				cmd("Focus Message Box", "focus-composer", "CmdOrCtrl+L"),
				{ type: "separator" },
				cmd("Previous Session", "prev-session", "CmdOrCtrl+Shift+["),
				cmd("Next Session", "next-session", "CmdOrCtrl+Shift+]"),
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
				...(app.isPackaged
					? []
					: ([
							{ role: "reload" },
							{ role: "toggleDevTools" },
						] as MenuItemConstructorOptions[])),
			],
		},
		{
			label: "Session",
			submenu: [
				cmd("Stop", "stop", "CmdOrCtrl+."),
				cmd("Compact Context", "compact", "CmdOrCtrl+Shift+K"),
			],
		},
	);
	if (isMac) {
		template.push({
			label: "Developer",
			enabled: options.developerMode,
			submenu: [cmd("Reset Figma", "reset-figma")],
		});
	}
	template.push(
		isMac
			? {
				label: "Window",
				submenu: [
					{ role: "minimize" },
					{ role: "zoom" },
					{ type: "separator" },
					{ role: "front" },
				],
			}
			: { role: "windowMenu" },
		{
			role: "help",
			submenu: [
				{
					label: "Pi Documentation",
					click: () => void shell.openExternal("https://pi.dev/docs/latest"),
				},
				{
					label: "Pi on GitHub",
					click: () =>
						void shell.openExternal("https://github.com/earendil-works/pi"),
				},
				{ type: "separator" },
				{
					label: "Show Logs",
					click: () => shell.showItemInFolder(log.transports.file.getFile().path),
				},
			],
		},
	);
	return Menu.buildFromTemplate(template);
}
