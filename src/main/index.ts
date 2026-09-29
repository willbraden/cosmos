import { execFile } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getAgentDir,
	VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import {
	app,
	BrowserWindow,
	clipboard,
	crashReporter,
	dialog,
	ipcMain,
	Menu,
	Notification,
	nativeTheme,
	type Rectangle,
	screen,
	shell,
} from "electron";
import log from "electron-log/main";
import type {
	AppInfo,
	DesktopSettings,
	MenuCommand,
	SessionMenuAction,
} from "../shared/ipc";
import {
	ensureCosmosManagedAgentDir,
	isCosmosManagedAgentDir,
} from "./agent-home";
import { AuthService } from "./auth-service";
import { isDirectory, searchProjectFiles } from "./files";
import { buildAppMenu } from "./menu";
import {
	getMcpOverview,
	removePersonalMcpServer,
	upsertPersonalMcpServer,
} from "./mcp-config";
import {
	FIGMA_XCODE_PLUGIN_URL,
	getFigmaXcodeAuthStatus,
	importXcodeFigmaAuthToPi,
	resetFigmaAuth,
} from "./figma-xcode-auth";
import { probeFreshSessionActiveTools } from "./mcp-session-availability";
import {
	bridgeExtensionPath,
	childNodePath,
	cosmosPackagePath,
	launcherPath,
	resolvePiCliPath,
} from "./paths";
import {
	detectGlayvinHome,
	inferGlayvinHomeFromAgentDir,
	resolveGlayvinHomePath,
	type RuntimePaths,
} from "./glayvin-runtime";
import { SessionIndex } from "./session-index";
import { type SupervisorConfig } from "./session-supervisor-protocol";
import { SessionSupervisorClient } from "./session-supervisor-client";
import { SettingsStore } from "./settings";
import { resolveShellEnv } from "./shell-env";
import { inspectWorkspace, isPathInsideWorkspace } from "./workspace";

// ---- Observability: persistent logs + local crash dumps from the first line ----
log.initialize();
log.transports.file.level = "info";
log.transports.console.level = app.isPackaged ? false : "debug";
log.errorHandler.startCatching({ showDialog: false });
crashReporter.start({ uploadToServer: false });
log.info(
	`Cosmos ${app.getVersion()} starting (pi ${PI_VERSION}, electron ${process.versions.electron})`,
);

const here = dirname(fileURLToPath(import.meta.url));
const INITIAL_PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const INITIAL_GLAYVIN_HOME =
	process.env.GLAYVIN_HOME ||
	inferGlayvinHomeFromAgentDir(INITIAL_PI_CODING_AGENT_DIR) ||
	detectGlayvinHome();
let mainWindow: BrowserWindow | null = null;

if (app.requestSingleInstanceLock()) {
	app.on("second-instance", () => focusWindow());
	void app.whenReady().then(start);
} else {
	app.quit();
}

let settings: SettingsStore;
let sessions: SessionIndex;
let host: SessionSupervisorClient;
let auth: AuthService;

function send(channel: string, payload?: unknown): void {
	if (mainWindow && !mainWindow.isDestroyed())
		mainWindow.webContents.send(channel, payload);
}

function refreshAppMenu(): void {
	Menu.setApplicationMenu(
		buildAppMenu((command: MenuCommand) => send("menu:command", command), {
			developerMode: settings.get().developerMode,
		}),
	);
}

function resolveWorkspaceRootPath(settingsValue: DesktopSettings): string {
	return settingsValue.workspaceRootPath || join(homedir(), "Cosmos");
}

function sessionSupervisorSocketPath(): string {
	return join(app.getPath("userData"), "session-supervisor.sock");
}

function buildSupervisorConfig(
	settingsValue: DesktopSettings,
	workspaceRoot: string,
): SupervisorConfig {
	const resolved = resolvePiCliPath(settingsValue.piCliPath);
	if (!resolved.bundled) log.info(`Using custom pi CLI at ${resolved.path}`);
	else if (settingsValue.piCliPath)
		log.warn(
			`Custom pi CLI not found (${settingsValue.piCliPath}); using bundled pi`,
		);
	return {
		nodePath: childNodePath(),
		launcherPath: launcherPath(),
		extensionPath: bridgeExtensionPath(),
		cliPath: resolved.path,
		workspaceRoot,
		idleSuspendMinutes: settingsValue.idleSuspendMinutes,
		agentDir: process.env.PI_CODING_AGENT_DIR,
		glayvinHome: process.env.GLAYVIN_HOME,
	};
}

const FIGMA_TOOL_NAMES = new Set([
	"get_design_context",
	"get_screenshot",
	"use_figma",
	"search_design_system",
	"get_libraries",
	"get_metadata",
	"create_new_file",
	"whoami",
]);

async function annotateMcpSessionAvailability(
	overview: Awaited<ReturnType<typeof getMcpOverview>>,
): Promise<Awaited<ReturnType<typeof getMcpOverview>>> {
	const figma = overview.servers.find(
		(server) =>
			server.name === "figma" &&
			server.active &&
			server.auth === "oauth" &&
			server.oauthConnected,
	);
	if (!figma) return overview;
	try {
		const cwd = existsSync(resolveWorkspaceRootPath(settings.get()))
			? resolveWorkspaceRootPath(settings.get())
			: homedir();
		const tools = await probeFreshSessionActiveTools({
			nodePath: childNodePath(),
			launcherPath: launcherPath(),
			cliPath: resolvePiCliPath(settings.get().piCliPath).path,
			extensionPath: bridgeExtensionPath(),
			cwd,
			env: {
				...(await resolveShellEnv()),
				...(process.env.PI_CODING_AGENT_DIR
					? { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR }
					: {}),
				...(process.env.GLAYVIN_HOME ? { GLAYVIN_HOME: process.env.GLAYVIN_HOME } : {}),
				ELECTRON_RUN_AS_NODE: "1",
				PI_DESKTOP: "1",
				COSMOS_DESKTOP: "1",
				COSMOS_WORKSPACE_ROOT: resolveWorkspaceRootPath(settings.get()),
				COSMOS_SESSION_CWD: cwd,
				PI_DESKTOP_PERMISSION_MODE: settings.get().permissionMode,
			},
		});
		const expected = figma.tools.filter((name) => name !== "*");
		const matches = tools.some((name) =>
			expected.length > 0 ? expected.includes(name) : FIGMA_TOOL_NAMES.has(name),
		);
		return {
			...overview,
			servers: overview.servers.map((server) =>
				server.name === figma.name
					? {
						...server,
						sessionAvailable: matches,
						sessionAvailabilityMessage: matches
							? "Fresh sessions can see the Figma tools."
							: "Cosmos found the Figma sign-in, but a fresh Pi session still did not load the Figma tools.",
					}
					: server,
			),
		};
	} catch (error) {
		return {
			...overview,
			servers: overview.servers.map((server) =>
				server.name === figma.name
					? {
						...server,
						sessionAvailable: false,
						sessionAvailabilityMessage:
							error instanceof Error
								? `Cosmos could not verify Figma in a fresh session: ${error.message}`
								: "Cosmos could not verify Figma in a fresh session.",
					}
					: server,
			),
		};
	}
}

function resolveRuntimePaths(paths: RuntimePaths): {
	agentDir: string;
	glayvinHome?: string;
	managed: boolean;
} {
	const glayvinHome = resolveGlayvinHomePath(paths, INITIAL_GLAYVIN_HOME);
	if (paths.agentDirPath) {
		return {
			agentDir: paths.agentDirPath,
			glayvinHome,
			managed: false,
		};
	}
	if (paths.glayvinHomePath) {
		return {
			agentDir: join(paths.glayvinHomePath, ".pi", "agent"),
			glayvinHome,
			managed: false,
		};
	}
	return {
		agentDir: ensureCosmosManagedAgentDir(
			app.getPath("userData"),
			getSeedAgentDirs(),
			cosmosPackagePath(),
		),
		glayvinHome,
		managed: true,
	};
}

function getSeedAgentDirs(): string[] {
	return [
		INITIAL_PI_CODING_AGENT_DIR,
		INITIAL_GLAYVIN_HOME
			? join(INITIAL_GLAYVIN_HOME, ".pi", "agent")
			: undefined,
		join(homedir(), ".pi", "agent"),
	].filter(
		(path): path is string => typeof path === "string" && path.length > 0,
	);
}

function applyRuntimeEnv(paths: RuntimePaths): void {
	const runtime = resolveRuntimePaths(paths);
	process.env.PI_CODING_AGENT_DIR = runtime.agentDir;
	if (runtime.glayvinHome) process.env.GLAYVIN_HOME = runtime.glayvinHome;
	else delete process.env.GLAYVIN_HOME;
}

function sameRuntimePaths(a: RuntimePaths, b: RuntimePaths): boolean {
	return (
		a.agentDirPath === b.agentDirPath && a.glayvinHomePath === b.glayvinHomePath
	);
}

function resolveCurrentGlayvinHome(agentDir: string): string | undefined {
	return process.env.GLAYVIN_HOME || inferGlayvinHomeFromAgentDir(agentDir);
}

/** The app was called "Pi Desktop" before; carry its settings over once. */
function migrateLegacyUserData(): void {
	const current = app.getPath("userData");
	const legacy = join(dirname(current), "Pi Desktop");
	if (legacy === current || existsSync(join(current, "settings.json"))) return;
	for (const file of ["settings.json", "window-state.json"]) {
		try {
			if (!existsSync(join(legacy, file))) continue;
			mkdirSync(current, { recursive: true });
			copyFileSync(join(legacy, file), join(current, file));
			log.info(`Migrated ${file} from ${legacy}`);
		} catch (error) {
			log.warn(`Could not migrate ${file} from ${legacy}`, error);
		}
	}
}

async function start(): Promise<void> {
	migrateLegacyUserData();
	settings = new SettingsStore();
	applyRuntimeEnv(settings.get());
	app.setAboutPanelOptions({
		applicationName: "Cosmos",
		applicationVersion: app.getVersion(),
		version: `pi ${PI_VERSION}`,
		credits:
			"A desktop app for the pi coding agent (github.com/earendil-works/pi).",
		copyright: "© 2026 Will Braden",
	});
	// Packaged builds get the icon from the bundle; show it in the Dock during development too.
	if (!app.isPackaged && process.platform === "darwin") {
		const icon = join(app.getAppPath(), "build", "icon.png");
		if (existsSync(icon)) app.dock?.setIcon(icon);
	}
	nativeTheme.themeSource = settings.get().theme;
	let runtimePaths: RuntimePaths = {
		agentDirPath: settings.get().agentDirPath,
		glayvinHomePath: settings.get().glayvinHomePath,
	};
	let workspaceRoot = resolveWorkspaceRootPath(settings.get());
	settings.onChange((next) => {
		nativeTheme.themeSource = next.theme;
		send("settings:changed", next);
		refreshAppMenu();
		const nextRuntimePaths: RuntimePaths = {
			agentDirPath: next.agentDirPath,
			glayvinHomePath: next.glayvinHomePath,
		};
		const runtimePathsChanged = !sameRuntimePaths(runtimePaths, nextRuntimePaths);
		const nextWorkspaceRoot = resolveWorkspaceRootPath(next);
		const workspaceRootChanged = nextWorkspaceRoot !== workspaceRoot;
		if (runtimePathsChanged) {
			applyRuntimeEnv(nextRuntimePaths);
			sessions?.restart();
			send("auth:changed");
			runtimePaths = nextRuntimePaths;
		}
		if (workspaceRootChanged) workspaceRoot = nextWorkspaceRoot;
		const nextConfig = buildSupervisorConfig(next, workspaceRoot);
		void host
			?.configure(nextConfig)
			.then(() => {
				if (runtimePathsChanged || workspaceRootChanged)
					return host.restartForNewCredentials();
			})
			.catch((error) => log.error("Could not reconfigure session supervisor", error));
	});

	// Resolve the login-shell environment early; the first session waits on it anyway.
	void resolveShellEnv();

	sessions = new SessionIndex(() => send("sessions:changed"));
	sessions.start();

	host = new SessionSupervisorClient({
		socketPath: sessionSupervisorSocketPath(),
		nodePath: childNodePath(),
		sink: {
			events: (batches) => {
				for (const batch of batches) send("session:events", batch);
			},
			exit: (exit) => send("session:exit", exit),
		},
	});
	await host.start(buildSupervisorConfig(settings.get(), workspaceRoot));

	auth = new AuthService({
		event: (event) => send("auth:event", event),
		prompt: (prompt) => send("auth:prompt", prompt),
		credentialsChanged: () => {
			void host.restartForNewCredentials();
			send("auth:changed");
		},
	});

	registerIpc();
	refreshAppMenu();
	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
		else focusWindow();
	});
}

// ---- Window ---------------------------------------------------------------

const windowStateFile = () =>
	join(app.getPath("userData"), "window-state.json");

function loadBounds(): Partial<Rectangle> {
	try {
		const bounds = JSON.parse(
			readFileSync(windowStateFile(), "utf8"),
		) as Rectangle;
		const visible = screen.getAllDisplays().some((display) => {
			const area = display.workArea;
			return (
				bounds.x < area.x + area.width &&
				bounds.x + bounds.width > area.x &&
				bounds.y < area.y + area.height &&
				bounds.y + bounds.height > area.y
			);
		});
		return visible ? bounds : { width: bounds.width, height: bounds.height };
	} catch {
		return {};
	}
}

function saveBounds(win: BrowserWindow): void {
	try {
		mkdirSync(app.getPath("userData"), { recursive: true });
		writeFileSync(windowStateFile(), JSON.stringify(win.getNormalBounds()));
	} catch (error) {
		log.warn("Could not save window bounds", error);
	}
}

function createWindow(): void {
	const bounds = loadBounds();
	const win = new BrowserWindow({
		width: bounds.width ?? 1280,
		height: bounds.height ?? 840,
		x: bounds.x,
		y: bounds.y,
		minWidth: 720,
		minHeight: 480,
		show: false,
		title: "Cosmos",
		titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
		trafficLightPosition: { x: 16, y: 16 },
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1b1a" : "#faf9f7",
		webPreferences: {
			preload: join(here, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			spellcheck: true,
		},
	});
	mainWindow = win;

	win.once("ready-to-show", () => win.show());
	win.on("close", () => saveBounds(win));
	win.on("closed", () => {
		if (mainWindow === win) mainWindow = null;
	});

	// Links open in the user's browser; the app window never navigates away.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (isWebUrl(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (event, url) => {
		if (url !== win.webContents.getURL()) {
			event.preventDefault();
			if (isWebUrl(url)) void shell.openExternal(url);
		}
	});
	win.webContents.on("render-process-gone", (_event, details) =>
		log.error("Renderer process gone", details),
	);

	if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
		void win.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		void win.loadFile(join(here, "../renderer/index.html"));
	}

	scheduleDevCapture(win);
}

function focusWindow(): void {
	if (!mainWindow) return createWindow();
	if (mainWindow.isMinimized()) mainWindow.restore();
	mainWindow.show();
	mainWindow.focus();
}

/**
 * Development aid: PI_DESKTOP_CAPTURE=/path.png writes a screenshot of the window after
 * PI_DESKTOP_CAPTURE_DELAY ms (default 4000). Never active in packaged builds.
 */
function scheduleDevCapture(win: BrowserWindow): void {
	const target = process.env.PI_DESKTOP_CAPTURE;
	if (app.isPackaged || !target) return;
	const delay = Number(process.env.PI_DESKTOP_CAPTURE_DELAY ?? 4000);
	win.webContents.once("did-finish-load", () => {
		setTimeout(async () => {
			const image = await win.webContents.capturePage();
			writeFileSync(target, image.toPNG());
			log.info(`Captured window to ${target}`);
		}, delay);
	});
}

// ---- IPC ------------------------------------------------------------------

function isWebUrl(url: unknown): url is string {
	return typeof url === "string" && /^https?:\/\//i.test(url);
}

function requireAbsolute(path: unknown): string {
	if (typeof path !== "string" || !isAbsolute(path))
		throw new Error("Expected an absolute path");
	return path;
}

function registerIpc(): void {
	ipcMain.handle("app:info", (): AppInfo => {
		const agentDir = getAgentDir();
		const glayvinHome = resolveCurrentGlayvinHome(agentDir);
		return {
			appVersion: app.getVersion(),
			piVersion: PI_VERSION,
			electronVersion: process.versions.electron,
			platform: process.platform,
			homeDir: homedir(),
			agentDir,
			glayvinHome,
			workspaceRoot: resolveWorkspaceRootPath(settings.get()),
			profileSource: isCosmosManagedAgentDir(agentDir)
				? "cosmos-managed"
				: glayvinHome
					? "glayvin"
					: "custom",
			logPath: log.transports.file.getFile().path,
		};
	});

	ipcMain.handle("settings:get", () => settings.get());
	ipcMain.handle("settings:update", (_e, patch: unknown) =>
		settings.update(patch),
	);
	ipcMain.handle("workspace:health", () =>
		inspectWorkspace(resolveWorkspaceRootPath(settings.get())),
	);
	ipcMain.handle("mcp:overview", async () => {
		const agentDir = getAgentDir();
		const overview = await getMcpOverview(resolveCurrentGlayvinHome(agentDir), agentDir);
		return annotateMcpSessionAvailability(overview);
	});
	ipcMain.handle("figma:xcode-status", async () =>
		getFigmaXcodeAuthStatus(getAgentDir()),
	);
	ipcMain.handle("figma:xcode-plugin-install", () =>
		shell.openExternal(FIGMA_XCODE_PLUGIN_URL),
	);
	ipcMain.handle("figma:xcode-import-auth", async () => {
		const result = await importXcodeFigmaAuthToPi(getAgentDir());
		await host.restartForNewCredentials();
		return result;
	});
	ipcMain.handle("figma:reset-auth", async () => {
		const result = await resetFigmaAuth(getAgentDir());
		await host.restartForNewCredentials();
		return result;
	});
	ipcMain.handle("mcp:upsert-personal", async (_e, name: unknown, config: unknown) => {
		const agentDir = getAgentDir();
		upsertPersonalMcpServer(
			resolveCurrentGlayvinHome(agentDir),
			String(name ?? ""),
			config,
		);
		await host.restartForNewCredentials();
		return annotateMcpSessionAvailability(
			await getMcpOverview(resolveCurrentGlayvinHome(agentDir), agentDir),
		);
	});
	ipcMain.handle("mcp:remove-personal", async (_e, name: unknown) => {
		const agentDir = getAgentDir();
		removePersonalMcpServer(
			resolveCurrentGlayvinHome(agentDir),
			String(name ?? ""),
		);
		await host.restartForNewCredentials();
		return annotateMcpSessionAvailability(
			await getMcpOverview(resolveCurrentGlayvinHome(agentDir), agentDir),
		);
	});

	ipcMain.handle("sessions:list", () => sessions.list());
	ipcMain.handle("sessions:search", (_e, query: unknown) =>
		typeof query === "string" ? sessions.search(query) : [],
	);
	ipcMain.handle("sessions:delete", (_e, path: unknown) =>
		sessions.trash(requireAbsolute(path)),
	);
	ipcMain.handle(
		"sessions:context-menu",
		(event, path: unknown, pinned: unknown) => {
			requireAbsolute(path);
			return new Promise<SessionMenuAction | null>((resolve) => {
				let chosen: SessionMenuAction | null = null;
				const item = (label: string, action: SessionMenuAction) => ({
					label,
					click: () => (chosen = action),
				});
				const menu = Menu.buildFromTemplate([
					item("Rename…", "rename"),
					item(pinned ? "Unpin" : "Pin to Top", pinned ? "unpin" : "pin"),
					{ type: "separator" },
					item("Export as HTML…", "exportHtml"),
					item("Reveal Session File in Finder", "reveal"),
					item("Copy Session Path", "copyPath"),
					{ type: "separator" },
					item("Move to Trash…", "delete"),
				]);
				const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
				menu.popup({ window: win, callback: () => resolve(chosen) });
			});
		},
	);

	ipcMain.handle("session:open", async (_e, request: unknown) => {
		const req = request as {
			tabId?: unknown;
			sessionPath?: unknown;
			cwd?: unknown;
			permissionMode?: unknown;
		};
		const cwd = requireAbsolute(req?.cwd);
		const workspaceRoot = resolveWorkspaceRootPath(settings.get());
		if (!isPathInsideWorkspace(cwd, workspaceRoot)) {
			throw new Error(
				`Cosmos only opens repositories inside ${workspaceRoot}. Move or clone the repo there, then try again.`,
			);
		}
		await host.open({
			tabId: String(req.tabId),
			cwd,
			sessionPath:
				req.sessionPath === undefined
					? undefined
					: requireAbsolute(req.sessionPath),
			permissionMode: req.permissionMode as never,
		});
		settings.addRecentProject(cwd);
	});
	ipcMain.handle("session:live-state", () => host.getSnapshot());
	ipcMain.handle("session:command", (_e, tabId: unknown, command: unknown) => {
		const cmd = command as { type?: unknown };
		if (!cmd || typeof cmd !== "object" || typeof cmd.type !== "string")
			throw new Error("Invalid command");
		return host.command(String(tabId), cmd as { type: string });
	});
	ipcMain.handle(
		"session:ui-response",
		async (_e, tabId: unknown, response: unknown) => {
			if (!response || typeof response !== "object")
				throw new Error("Invalid UI response");
			await host.respondToUi(String(tabId), response as Record<string, unknown>);
		},
	);
	ipcMain.handle("session:close", (_e, tabId: unknown) =>
		host.close(String(tabId)),
	);
	ipcMain.on("session:visible", (_e, tabId: unknown) =>
		host.setVisible(typeof tabId === "string" ? tabId : null),
	);

	ipcMain.handle("dialog:pick-folder", async (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		const workspaceRoot = resolveWorkspaceRootPath(settings.get());
		const options = {
			title: "Choose a project folder inside the Cosmos workspace",
			defaultPath: workspaceRoot,
			properties: ["openDirectory", "createDirectory"] as const,
		};
		const result = win
			? await dialog.showOpenDialog(win, {
					...options,
					properties: [...options.properties],
				})
			: await dialog.showOpenDialog({
					...options,
					properties: [...options.properties],
				});
		const chosen = result.canceled ? null : (result.filePaths[0] ?? null);
		if (!chosen) return null;
		if (!isPathInsideWorkspace(chosen, workspaceRoot)) {
			throw new Error(
				`Choose a folder inside ${workspaceRoot}. Cosmos is locked to the company workspace.`,
			);
		}
		return resolve(chosen);
	});
	ipcMain.handle("workspace:create-experiment", (_event, name: unknown) => {
		if (typeof name !== "string") throw new Error("Experiment name is required");
		const trimmed = name.trim();
		if (!trimmed) throw new Error("Enter an experiment name");
		if (
			trimmed === "." ||
			trimmed === ".." ||
			/[\\/]/.test(trimmed) ||
			/[\0]/.test(trimmed)
		) {
			throw new Error(
				"Use a single folder name without slashes, '..', or hidden control characters",
			);
		}
		const workspaceRoot = resolveWorkspaceRootPath(settings.get());
		const experimentPath = resolve(join(workspaceRoot, trimmed));
		if (!isPathInsideWorkspace(experimentPath, workspaceRoot)) {
			throw new Error(
				`Create experiments inside ${workspaceRoot}. Cosmos is locked to the company workspace.`,
			);
		}
		if (existsSync(experimentPath)) {
			throw new Error(
				`A folder named ${trimmed} already exists in ${workspaceRoot}.`,
			);
		}
		mkdirSync(experimentPath, { recursive: false });
		return experimentPath;
	});
	ipcMain.handle("dialog:save", async (event, defaultName: unknown) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		const opts = {
			defaultPath: join(
				app.getPath("downloads"),
				typeof defaultName === "string"
					? defaultName.replace(/[/\\]/g, "-")
					: "session.html",
			),
			filters: [{ name: "HTML", extensions: ["html"] }],
		};
		const result = win
			? await dialog.showSaveDialog(win, opts)
			: await dialog.showSaveDialog(opts);
		return result.canceled ? null : (result.filePath ?? null);
	});
	ipcMain.handle("files:search", (_e, cwd: unknown, query: unknown) =>
		searchProjectFiles(requireAbsolute(cwd), String(query ?? "")),
	);

	ipcMain.handle("shell:open-path", async (_e, path: unknown) => {
		const error = await shell.openPath(requireAbsolute(path));
		if (error) throw new Error(error);
	});
	ipcMain.handle("shell:reveal", (_e, path: unknown) =>
		shell.showItemInFolder(requireAbsolute(path)),
	);
	ipcMain.handle("shell:open-in-editor", (_e, path: unknown, line: unknown) =>
		openInEditor(
			requireAbsolute(path),
			typeof line === "number" && line > 0 ? Math.floor(line) : undefined,
		),
	);
	ipcMain.handle("shell:open-terminal", async (_e, cwd: unknown) => {
		const dir = requireAbsolute(cwd);
		if (!(await isDirectory(dir))) throw new Error("Folder not found");
		if (process.platform === "darwin") await run("open", ["-a", "Terminal", dir]);
		else await shell.openPath(dir);
	});
	ipcMain.handle("shell:open-external", (_e, url: unknown) => {
		if (!isWebUrl(url)) throw new Error("Only http(s) links can be opened");
		return shell.openExternal(url);
	});
	ipcMain.handle("clipboard:write", (_e, text: unknown) =>
		clipboard.writeText(String(text ?? "")),
	);

	ipcMain.handle("auth:providers", () => auth.listProviders());
	ipcMain.handle("auth:login", (_e, providerId: unknown, method: unknown) =>
		auth.startLogin(String(providerId), method as "oauth" | "api_key"),
	);
	ipcMain.on("auth:answer", (_e, promptId: unknown, value: unknown) =>
		auth.answerPrompt(String(promptId), typeof value === "string" ? value : null),
	);
	ipcMain.on("auth:cancel", () => auth.cancelLogin());
	ipcMain.handle("auth:logout", (_e, providerId: unknown) =>
		auth.logout(String(providerId)),
	);

	ipcMain.on("app:notify", (_e, options: unknown) => {
		const { title, body, tabId } = (options ?? {}) as {
			title?: unknown;
			body?: unknown;
			tabId?: unknown;
		};
		if (!settings.get().notifications || !Notification.isSupported()) return;
		const notification = new Notification({
			title: String(title ?? "Cosmos"),
			body: String(body ?? "").slice(0, 300),
		});
		notification.on("click", () => {
			focusWindow();
			send("notification:click", String(tabId ?? ""));
		});
		notification.show();
	});
	ipcMain.on("app:badge", (_e, count: unknown) => {
		const n = typeof count === "number" && count > 0 ? Math.floor(count) : 0;
		app.setBadgeCount(n);
	});
	ipcMain.on("app:log", (_e, level: unknown, message: unknown) => {
		const text = `[renderer] ${String(message).slice(0, 10_000)}`;
		if (level === "error") log.error(text);
		else if (level === "warn") log.warn(text);
		else log.info(text);
	});
}

function run(
	command: string,
	args: string[],
	env?: NodeJS.ProcessEnv,
): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { timeout: 15_000, env }, (error) =>
			error ? reject(error) : resolve(),
		);
	});
}

/** Prefer a code editor CLI found on the user's PATH; fall back to the default app. */
async function openInEditor(path: string, line?: number): Promise<void> {
	const env = await resolveShellEnv();
	for (const cli of ["cursor", "code", "zed"]) {
		try {
			const target =
				line && cli !== "zed"
					? ["-g", `${path}:${line}`]
					: [line ? `${path}:${line}` : path];
			await run(cli, target, env);
			return;
		} catch {
			// Not installed; try the next editor.
		}
	}
	const error = await shell.openPath(path);
	if (error) throw new Error(error);
}

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

let quitting = false;
app.on("before-quit", () => {
	if (quitting) return;
	quitting = true;
	log.info("Quit requested; leaving the session supervisor running");
	if (mainWindow && !mainWindow.isDestroyed()) saveBounds(mainWindow);
	sessions?.stop();
	auth?.cancelLogin();
});
