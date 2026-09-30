import type {
	AppInfo,
	DesktopSettings,
	FigmaXcodeAuthStatus,
	GlayvinPackageSummary,
	GlayvinPackLayer,
	GlayvinPackSummary,
	GlayvinProfileOverview,
	GlayvinTeamSummary,
	McpConfigOverview,
	McpServerDefinition,
	ProviderInfo,
} from "@shared/ipc";
import {
	CircleCheck,
	Copy,
	ExternalLink,
	FolderOpen,
	Info,
	KeyRound,
	Layers,
	Pencil,
	Plus,
	Plug,
	RefreshCw,
	Server,
	SlidersHorizontal,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage, tildify } from "../lib/api";
import {
	applyPermissionModeToAllOpenSessions,
	refreshProviders,
} from "../state/actions";
import { type SettingsPane, toast, useStore } from "../state/store";
import { LoginDialog } from "./LoginDialog";
import { PERMISSION_MODES } from "./Pickers";
import { SpinnerIcon } from "./SpinnerIcon";

function Switch({
	on,
	onChange,
	label,
}: {
	on: boolean;
	onChange(on: boolean): void;
	label: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={on}
			aria-label={label}
			className={`switch${on ? " on" : ""}`}
			onClick={() => onChange(!on)}
		/>
	);
}

function Setting({
	name,
	help,
	children,
	stacked,
}: {
	name: string;
	help?: string;
	children: React.ReactNode;
	stacked?: boolean;
}) {
	return (
		<div className={`setting${stacked ? " stacked" : ""}`}>
			<div className="setting-text">
				<span className="name">{name}</span>
				{help && <span className="help">{help}</span>}
			</div>
			{children}
		</div>
	);
}

function PathSettingInput({
	value,
	onChange,
	onSave,
	placeholder,
	width,
}: {
	value: string;
	onChange(value: string): void;
	onSave(): void;
	placeholder: string;
	width: number;
}) {
	return (
		<div className="setting-control">
			<input
				type="text"
				placeholder={placeholder}
				value={value}
				style={{ width: `min(${width}px, 100%)`, maxWidth: "100%" }}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						onSave();
					}
				}}
				onBlur={onSave}
			/>
			<button type="button" className="btn small" onClick={onSave}>
				Save
			</button>
		</div>
	);
}

function describeAgentDirSource(info: AppInfo | undefined): {
	label: string;
	help: string;
	button: string;
} {
	switch (info?.agentDirSource) {
		case "cosmos-managed":
			return {
				label: "Cosmos workspace (recommended)",
				help:
					"Cosmos is using its own managed Pi agent directory. If a Glayvin home is available, Cosmos still passes it through for shared MCP, skills, prompts, and company context without reusing the terminal session store.",
				button: "Using recommended setup",
			};
		case "glayvin":
			return {
				label: "Shared Glayvin setup",
				help:
					"Cosmos is currently reusing a Glayvin home. This can also reuse terminal-oriented permission rules and extensions.",
				button: "Switch to Cosmos workspace",
			};
		default:
			return {
				label: "Custom Pi setup",
				help:
					"Cosmos is using a manually chosen Pi home. Advanced users can share a custom setup here, but most coworkers should use the Cosmos workspace.",
				button: "Switch to Cosmos workspace",
			};
	}
}

function General({
	settings,
	update,
}: {
	settings: DesktopSettings;
	update(patch: Partial<DesktopSettings>): void;
}) {
	const info = useStore((s) => s.appInfo);
	const agentDir = describeAgentDirSource(info);
	const [cliPath, setCliPath] = useState(settings.piCliPath);
	const [agentDirPath, setAgentDirPath] = useState(settings.agentDirPath);
	const [glayvinHomePath, setGlayvinHomePath] = useState(
		settings.glayvinHomePath,
	);
	const [workspaceRootPath, setWorkspaceRootPath] = useState(
		settings.workspaceRootPath,
	);
	const [coreRepoOrg, setCoreRepoOrg] = useState(settings.coreRepoOrg);
	const [showAdvanced, setShowAdvanced] = useState(false);

	useEffect(() => {
		setCliPath(settings.piCliPath);
		setAgentDirPath(settings.agentDirPath);
		setGlayvinHomePath(settings.glayvinHomePath);
		setWorkspaceRootPath(settings.workspaceRootPath);
		setCoreRepoOrg(settings.coreRepoOrg);
	}, [
		settings.piCliPath,
		settings.agentDirPath,
		settings.glayvinHomePath,
		settings.workspaceRootPath,
		settings.coreRepoOrg,
	]);

	useEffect(() => {
		if (info?.agentDirSource === "glayvin" || info?.agentDirSource === "custom") {
			setShowAdvanced(true);
		}
	}, [info?.agentDirSource]);

	const savePath = (
		key: "piCliPath" | "agentDirPath" | "glayvinHomePath" | "workspaceRootPath",
		value: string,
	) => {
		if (value && !value.startsWith("/")) {
			toast("warning", "Enter an absolute path.");
			return;
		}
		update({ [key]: value } as Partial<DesktopSettings>);
	};

	return (
		<>
			<h3>General</h3>
			<Setting name="Workspace setup" help={agentDir.help}>
				<div
					className="setting-control"
					style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
				>
					<span className="muted">{agentDir.label}</span>
					<button
						type="button"
						className="btn small"
						disabled={info?.agentDirSource === "cosmos-managed"}
						onClick={() => update({ agentDirPath: "", glayvinHomePath: "" })}
					>
						{agentDir.button}
					</button>
				</div>
			</Setting>
			<Setting
				name="Cosmos workspace root"
				help="Where Cosmos expects sibling repos like cosmos-ai, segway-next, and neutron. Leave empty to use ~/Cosmos. Changing this restarts background pi processes so the company package sees the new root."
				stacked
			>
				<PathSettingInput
					placeholder={info ? tildify(info.workspaceRoot, info.homeDir) : "~/Cosmos"}
					value={workspaceRootPath}
					width={320}
					onChange={setWorkspaceRootPath}
					onSave={() => savePath("workspaceRootPath", workspaceRootPath)}
				/>
			</Setting>
			<Setting
				name="Core repo GitHub org"
				help="Used to build the clone URL when you press Clone on a core repo card: git@github.com:<org>/<repo>.git. Leave empty to use shipt."
				stacked
			>
				<PathSettingInput
					placeholder="shipt"
					value={coreRepoOrg}
					width={320}
					onChange={setCoreRepoOrg}
					onSave={() => {
						const org = coreRepoOrg.trim();
						if (org && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(org)) {
							toast("warning", "Enter a valid GitHub org name.");
							return;
						}
						update({ coreRepoOrg: org });
					}}
				/>
			</Setting>
			<Setting name="Appearance">
				<div className="segmented">
					{(["system", "light", "dark"] as const).map((theme) => (
						<button
							key={theme}
							type="button"
							className={settings.theme === theme ? "on" : ""}
							onClick={() => update({ theme })}
						>
							{theme[0].toUpperCase() + theme.slice(1)}
						</button>
					))}
				</div>
			</Setting>
			<Setting
				name="Default permission mode"
				help="Used for new sessions. Change it per session from the message box, or apply the current mode to every open session below."
			>
				<div
					style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
				>
					<select
						value={settings.permissionMode}
						onChange={(e) =>
							update({
								permissionMode: e.target.value as DesktopSettings["permissionMode"],
							})
						}
					>
						{PERMISSION_MODES.map((m) => (
							<option key={m.mode} value={m.mode}>
								{m.label}
							</option>
						))}
					</select>
					<button
						type="button"
						className="btn small"
						onClick={() => {
							void applyPermissionModeToAllOpenSessions(settings.permissionMode).then(
								(count) => {
									toast(
										"info",
										count > 0
											? `Applied ${settings.permissionMode} to ${count} open session${count === 1 ? "" : "s"}.`
											: "No open sessions to update.",
									);
								},
							);
						}}
					>
						Apply to all open
					</button>
				</div>
			</Setting>
			<Setting
				name="Messages sent while pi is working"
				help="Steer delivers after the current tool calls; queue waits until pi finishes. ⌥↩ does the other."
			>
				<div className="segmented">
					<button
						type="button"
						className={settings.busySendMode === "steer" ? "on" : ""}
						onClick={() => update({ busySendMode: "steer" })}
					>
						Steer
					</button>
					<button
						type="button"
						className={settings.busySendMode === "followUp" ? "on" : ""}
						onClick={() => update({ busySendMode: "followUp" })}
					>
						Queue
					</button>
				</div>
			</Setting>
			<Setting
				name="Notifications"
				help="Notify when pi finishes or needs you while the window is in the background."
			>
				<Switch
					label="Notifications"
					on={settings.notifications}
					onChange={(notifications) => update({ notifications })}
				/>
			</Setting>
			<Setting
				name="Suspend idle sessions after"
				help="Background sessions release their pi process when idle and resume instantly when you return."
			>
				<select
					value={settings.idleSuspendMinutes}
					onChange={(e) => update({ idleSuspendMinutes: Number(e.target.value) })}
				>
					{[5, 15, 30, 60, 240, 0].map((m) => (
						<option key={m} value={m}>
							{m === 0
								? "Never"
								: m < 60
									? `${m} minutes`
									: `${m / 60} hour${m > 60 ? "s" : ""}`}
						</option>
					))}
				</select>
			</Setting>
			<div style={{ marginTop: 14 }}>
				<button
					type="button"
					className="btn small"
					onClick={() => setShowAdvanced((value) => !value)}
				>
					{showAdvanced ? "Hide advanced setup" : "Show advanced setup"}
				</button>
			</div>
			{showAdvanced && (
				<>
					<Setting
						name="Developer mode"
						help="Reveals hidden developer-only tools, including UI inspect mode with ⌘I / Ctrl+I."
					>
						<Switch
							label="Developer mode"
							on={settings.developerMode}
							onChange={(developerMode) => update({ developerMode })}
						/>
					</Setting>
					<Setting
						name="Custom pi CLI"
						help="Absolute path to a pi cli.js (e.g. a local build). Leave empty to use the bundled pi. Applies to newly started sessions."
					>
						<PathSettingInput
							placeholder="Bundled"
							value={cliPath}
							width={240}
							onChange={setCliPath}
							onSave={() => savePath("piCliPath", cliPath)}
						/>
					</Setting>
					<Setting
						name="pi configuration folder"
						help="Absolute path to the pi agent directory containing settings.json, auth.json, and sessions/. Leave empty to use Cosmos's own managed agent directory. When Glayvin is installed, Cosmos still shares its home automatically for MCP, skills, prompts, and company context; set this explicitly only if you want to fully reuse an existing Pi or Glayvin agent directory."
					>
						<PathSettingInput
							placeholder="Cosmos managed agent directory"
							value={agentDirPath}
							width={320}
							onChange={setAgentDirPath}
							onSave={() => savePath("agentDirPath", agentDirPath)}
						/>
					</Setting>
					<Setting
						name="Glayvin home"
						help="Optional absolute GLAYVIN_HOME override for custom installs. Leave empty to use the inherited or auto-detected Glayvin home, or let Cosmos infer it from the pi configuration folder when it ends with /.pi/agent."
					>
						<PathSettingInput
							placeholder="Auto / inferred"
							value={glayvinHomePath}
							width={320}
							onChange={setGlayvinHomePath}
							onSave={() => savePath("glayvinHomePath", glayvinHomePath)}
						/>
					</Setting>
				</>
			)}
		</>
	);
}

/** Human-readable credential source; pi reports ids like "models_json_key" or env var names. */
function describeSource(source: string | undefined): string {
	if (!source) return "configured credentials";
	if (source === "models_json_key") return "models.json";
	if (/^[A-Z0-9_]+$/.test(source)) return `$${source}`;
	return source.replace(/_/g, " ");
}

function Providers() {
	const providers = useStore((s) => s.providers);
	const [login, setLogin] = useState<{
		provider: ProviderInfo;
		method: "oauth" | "api_key";
	} | null>(null);
	const [filter, setFilter] = useState("");
	const [showAll, setShowAll] = useState(false);
	const closeLogin = useCallback(() => setLogin(null), []);

	useEffect(() => {
		void refreshProviders();
	}, []);

	const { connected, subscriptions, rest } = useMemo(() => {
		const q = filter.toLowerCase();
		const match = (p: ProviderInfo) =>
			!q || p.name.toLowerCase().includes(q) || p.id.includes(q);
		const list = providers.filter(match);
		return {
			connected: list.filter((p) => p.configured),
			subscriptions: list.filter((p) => !p.configured && p.oauth),
			rest: list.filter((p) => !p.configured && !p.oauth),
		};
	}, [providers, filter]);

	const logout = async (provider: ProviderInfo) => {
		if (
			!window.confirm(
				`Sign out of ${provider.name}? The stored credential is removed from pi's auth file.`,
			)
		)
			return;
		try {
			await api.logout(provider.id);
			await refreshProviders();
		} catch (error) {
			toast("error", errorMessage(error));
		}
	};

	const row = (provider: ProviderInfo) => (
		<div key={provider.id} className="provider-row">
			<div className="info">
				<span style={{ display: "flex", alignItems: "center", gap: 8 }}>
					{provider.name}
					{provider.configured && (
						<span className="badge">
							<CircleCheck size={11} /> Connected
						</span>
					)}
				</span>
				<span className="source">
					{provider.configured
						? `via ${describeSource(provider.source)}`
						: provider.id}
				</span>
			</div>
			{provider.storedCredential ? (
				<button
					type="button"
					className="btn small"
					onClick={() => void logout(provider)}
				>
					Sign out
				</button>
			) : provider.configured ? null : (
				<>
					{provider.oauth && (
						<button
							type="button"
							className="btn small primary"
							onClick={() => setLogin({ provider, method: "oauth" })}
						>
							{provider.oauth.label}
						</button>
					)}
					{provider.apiKey?.interactive && (
						<button
							type="button"
							className="btn small"
							onClick={() => setLogin({ provider, method: "api_key" })}
						>
							<KeyRound size={12} /> API key
						</button>
					)}
				</>
			)}
		</div>
	);

	return (
		<>
			<h3>Model providers</h3>
			<p className="small-text muted" style={{ marginTop: -8 }}>
				Cosmos uses pi's own credentials (<code>auth.json</code>), environment
				variables, and <code>models.json</code> — anything you set up in the pi CLI
				works here too.
			</p>
			<input
				className="text-input"
				placeholder="Filter providers"
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
				style={{ margin: "6px 0 10px" }}
			/>
			{connected.length > 0 && (
				<>
					<div className="popover-label" style={{ padding: "8px 0 0" }}>
						Connected
					</div>
					{connected.map(row)}
				</>
			)}
			{subscriptions.length > 0 && (
				<>
					<div className="popover-label" style={{ padding: "14px 0 0" }}>
						Sign in with a subscription
					</div>
					{subscriptions.map(row)}
				</>
			)}
			<div className="popover-label" style={{ padding: "14px 0 0" }}>
				API key providers
			</div>
			{(showAll || filter ? rest : rest.slice(0, 8)).map(row)}
			{!showAll && !filter && rest.length > 8 && (
				<button
					type="button"
					className="btn small"
					style={{ marginTop: 10 }}
					onClick={() => setShowAll(true)}
				>
					Show all {rest.length}
				</button>
			)}
			{login && (
				<LoginDialog
					provider={login.provider}
					method={login.method}
					onClose={closeLogin}
				/>
			)}
		</>
	);
}

function prettyServerJson(config: Record<string, unknown>): string {
	return `${JSON.stringify(config, null, 2)}\n`;
}

function transportLabel(server: McpServerDefinition): string {
	if (server.transport === "command") {
		return server.command
			? `${server.transport} · ${server.command}${server.args.length ? ` ${server.args.join(" ")}` : ""}`
			: server.transport;
	}
	if (server.transport === "http")
		return server.url ? `${server.transport} · ${server.url}` : server.transport;
	return server.transport;
}

function McpEditor({
	server,
	onClose,
	onSaved,
}: {
	server?: McpServerDefinition;
	onClose(): void;
	onSaved(): void;
}) {
	const [name, setName] = useState(server?.name ?? "");
	const [json, setJson] = useState(
		prettyServerJson(
			server?.personal ? server.config : { type: "http", url: "", tools: ["*"] },
		),
	);
	const [saving, setSaving] = useState(false);

	const save = async () => {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(json) as Record<string, unknown>;
		} catch (error) {
			toast("error", `Invalid JSON: ${errorMessage(error)}`);
			return;
		}
		setSaving(true);
		try {
			await api.upsertPersonalMcpServer(name, parsed);
			toast(
				"info",
				server ? `Updated MCP server ${name}.` : `Added MCP server ${name}.`,
			);
			onSaved();
		} catch (error) {
			toast("error", errorMessage(error));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div
			className="modal-backdrop"
			onMouseDown={(e) => e.target === e.currentTarget && onClose()}
		>
			<div
				className="modal small"
				role="dialog"
				aria-label={server ? `Edit MCP ${server.name}` : "Add MCP server"}
			>
				<div className="login-body">
					<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<Server size={18} />
						<h3 style={{ flex: 1 }}>
							{server ? `Edit ${server.name}` : "Add MCP server"}
						</h3>
						<button
							type="button"
							className="icon-btn"
							onClick={onClose}
							aria-label="Close"
						>
							<X size={16} />
						</button>
					</div>
					<label className="small-text">Server name</label>
					<input
						className="text-input"
						autoFocus
						value={name}
						disabled={!!server}
						placeholder="figma"
						onChange={(e) => setName(e.target.value)}
						spellCheck={false}
					/>
					<label className="small-text">Server config JSON</label>
					<textarea
						className="json-editor"
						value={json}
						onChange={(e) => setJson(e.target.value)}
						spellCheck={false}
					/>
					<div className="small-text muted">
						Use the same entry shape as Glayvin MCP config files. A server needs
						either a <code>url</code> or a <code>command</code>.
					</div>
					<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
						<button type="button" className="btn" onClick={onClose}>
							Cancel
						</button>
						<button
							type="button"
							className="btn primary"
							onClick={() => void save()}
							disabled={saving || !name.trim()}
						>
							{saving ? "Saving…" : server ? "Save changes" : "Add server"}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

function isFigmaMcp(server: McpServerDefinition): boolean {
	return server.name === "figma" || server.url === "https://mcp.figma.com/mcp";
}

function oauthProviderSite(server: McpServerDefinition): string | undefined {
	if (isFigmaMcp(server)) return "https://mcp.figma.com";
	if (!server.url) return undefined;
	try {
		return new URL(server.url).origin;
	} catch {
		return server.url;
	}
}

function oauthSetupGuidePath(
	info: AppInfo | undefined,
	server: McpServerDefinition,
): string | undefined {
	if (!info) return undefined;
	if (isFigmaMcp(server))
		return `${info.workspaceRoot}/cosmos-ai/docs/figma-mcp-setup.md`;
	return undefined;
}

function oauthHelpText(server: McpServerDefinition): string {
	if (
		isFigmaMcp(server) &&
		server.oauthConnected &&
		server.sessionAvailable === false
	) {
		return (
			server.sessionAvailabilityMessage ??
			"Cosmos found the Figma sign-in, but fresh sessions still are not loading the Figma tools."
		);
	}
	if (
		isFigmaMcp(server) &&
		server.oauthConnected &&
		server.sessionAvailable === true
	) {
		return (
			server.sessionAvailabilityMessage ??
			"Figma is connected and fresh sessions can load the Figma tools."
		);
	}
	if (isFigmaMcp(server)) {
		return "Click Connect Figma for guided Xcode beta setup. Cosmos watches for the finished sign-in and can import it back into Pi automatically.";
	}
	return "Click Connect to start sign-in in your current session. Finish the browser flow, then refresh here.";
}

function toolPreview(tools: string[]): string {
	if (tools.length === 0) return "Uses server defaults";
	const preview = tools.slice(0, 4).join(", ");
	const remaining = tools.length - 4;
	return remaining > 0 ? `${preview} +${remaining} more` : preview;
}

function oauthPrimaryLabel(server: McpServerDefinition): string {
	if (isFigmaMcp(server))
		return server.oauthConnected ? "Reconnect Figma" : "Connect Figma";
	return server.oauthConnected
		? `Reconnect ${server.name}`
		: `Connect ${server.name}`;
}

interface FigmaConnectFlowState {
	serverName: string;
	status: FigmaXcodeAuthStatus | null;
	phase: "checking" | "waiting" | "importing" | "connected" | "failed";
	message?: string;
}

function StepRow({
	done,
	title,
	detail,
}: {
	done: boolean;
	title: string;
	detail: string;
}) {
	return (
		<div
			className="small-text"
			style={{ display: "flex", gap: 8, alignItems: "flex-start" }}
		>
			<span style={{ color: done ? "var(--success)" : "var(--text-muted)" }}>
				{done ? "✓" : "•"}
			</span>
			<div>
				<div style={{ color: done ? "var(--text)" : undefined }}>{title}</div>
				<div className="muted">{detail}</div>
			</div>
		</div>
	);
}

function FigmaConnectDialog({
	flow,
	onClose,
	onRefresh,
	onLaunchPlugin,
	onContinue,
}: {
	flow: FigmaConnectFlowState;
	onClose(): void;
	onRefresh(): void;
	onLaunchPlugin(): void;
	onContinue(): void;
}) {
	const status = flow.status;
	const connected = flow.phase === "connected" || !!status?.piOAuthConnected;
	const waiting = flow.phase === "checking" || flow.phase === "importing";
	const needsXcode = status ? !status.xcodeInstalled : false;
	const needsPlugin = status
		? status.xcodeInstalled && !status.xcodeHasFigmaServer
		: false;
	const waitingForSignIn = status
		? status.xcodeInstalled &&
			status.xcodeHasFigmaServer &&
			!status.xcodeHasBearerToken &&
			!status.piOAuthConnected
		: false;
	return (
		<div
			className="modal-backdrop"
			onMouseDown={(e) => e.target === e.currentTarget && onClose()}
		>
			<div
				className="modal small"
				role="dialog"
				aria-label={`Connect ${flow.serverName}`}
			>
				<div className="login-body">
					<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<Plug size={18} />
						<h3 style={{ flex: 1 }}>Connect {flow.serverName}</h3>
						<button
							type="button"
							className="icon-btn"
							onClick={onClose}
							aria-label="Close"
						>
							<X size={16} />
						</button>
					</div>

					{waiting && (
						<div className="working">
							<SpinnerIcon size={14} />
							{flow.phase === "importing"
								? " Importing Figma sign-in from Xcode…"
								: " Checking Xcode and Figma sign-in…"}
						</div>
					)}
					{connected && (
						<div className="notice info" style={{ color: "var(--success)" }}>
							<CircleCheck size={16} /> Figma is connected in Cosmos.
						</div>
					)}
					{flow.phase === "failed" && (
						<div className="notice warning">
							{flow.message ?? "Could not finish Figma sign-in."}
						</div>
					)}
					{flow.message && flow.phase !== "failed" && flow.phase !== "connected" && (
						<div className="notice info">{flow.message}</div>
					)}

					<div className="small-text" style={{ whiteSpace: "pre-wrap" }}>
						Cosmos can watch Xcode for a finished Figma sign-in and import it back
						into Pi automatically. You can also press Continue after signing in.
					</div>

					<div style={{ display: "grid", gap: 10 }}>
						<StepRow
							done={!!status?.xcodeInstalled}
							title="Install Xcode beta"
							detail={
								needsXcode
									? "Install Xcode beta first, then come back here and press Continue."
									: "Xcode is available on this Mac."
							}
						/>
						<StepRow
							done={!!status?.xcodeHasFigmaServer}
							title="Add the Figma MCP plugin in Xcode"
							detail={
								needsPlugin
									? "Cosmos can open the Xcode add-plugin flow for you."
									: "The Figma plugin is already present in Xcode."
							}
						/>
						<StepRow
							done={!!status?.xcodeHasBearerToken}
							title="Sign in to Figma inside Xcode"
							detail={
								waitingForSignIn
									? "Finish the sign-in in Xcode, then press Continue or wait for Cosmos to detect it."
									: "Once Xcode has a usable Figma token, Cosmos can import it here."
							}
						/>
						<StepRow
							done={!!status?.piOAuthConnected}
							title="Import the sign-in back into Cosmos"
							detail={
								connected
									? "Cosmos can now use the Figma MCP server."
									: "Cosmos imports the Xcode sign-in automatically when it becomes available."
							}
						/>
					</div>

					{status && (
						<div
							className="small-text muted selectable wrap-anywhere"
							style={{ display: "grid", gap: 4 }}
						>
							<div>
								Xcode MCP config: {tildify(status.xcodeMcpConfigPath, undefined)}
							</div>
							<div>Pi token path: {tildify(status.piOAuthTokensPath, undefined)}</div>
						</div>
					)}

					<div
						style={{
							display: "flex",
							gap: 8,
							justifyContent: "flex-end",
							flexWrap: "wrap",
						}}
					>
						<button type="button" className="btn" onClick={onRefresh}>
							<RefreshCw size={12} /> Refresh status
						</button>
						{needsXcode && (
							<button
								type="button"
								className="btn"
								onClick={() =>
									void api.openExternal("https://developer.apple.com/xcode/")
								}
							>
								<ExternalLink size={12} /> Get Xcode beta
							</button>
						)}
						{status?.xcodeInstalled && status.xcodeAppPath && (
							<button
								type="button"
								className="btn"
								onClick={() => void api.openPath(status.xcodeAppPath!)}
							>
								Open Xcode
							</button>
						)}
						{status?.xcodeInstalled && !status.xcodeHasFigmaServer && !connected && (
							<button type="button" className="btn" onClick={onLaunchPlugin}>
								<ExternalLink size={12} /> Add Figma to Xcode
							</button>
						)}
						{!connected && (
							<button type="button" className="btn primary" onClick={onContinue}>
								{waitingForSignIn ? "I signed in" : "Continue"}
							</button>
						)}
						{connected && (
							<button type="button" className="btn primary" onClick={onClose}>
								Done
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

async function copyValue(value: string, label: string): Promise<void> {
	try {
		await api.copyText(value);
		toast("info", `${label} copied.`);
	} catch (error) {
		toast("error", errorMessage(error));
	}
}

function Mcps() {
	const info = useStore((s) => s.appInfo);
	const settings = useStore((s) => s.settings);
	const [overview, setOverview] = useState<McpConfigOverview | null>(null);
	const [loading, setLoading] = useState(true);
	const [editing, setEditing] = useState<McpServerDefinition | null>(null);
	const [adding, setAdding] = useState(false);
	const [figmaFlow, setFigmaFlow] = useState<FigmaConnectFlowState | null>(null);
	const connectingServer =
		figmaFlow && figmaFlow.phase !== "connected" && figmaFlow.phase !== "failed"
			? figmaFlow.serverName
			: null;
	const updateSettings = (patch: Partial<DesktopSettings>) => {
		void api
			.updateSettings(patch)
			.then((next) => useStore.setState({ settings: next }));
	};

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			setOverview(await api.getMcpOverview());
		} catch (error) {
			toast("error", errorMessage(error));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const refreshFigmaFlow = useCallback(
		async (options?: { launchPlugin?: boolean; importIfReady?: boolean }) => {
			try {
				const status = await api.getFigmaXcodeAuthStatus();
				setFigmaFlow((current) =>
					current
						? {
								...current,
								status,
								phase: status.piOAuthConnected
									? "connected"
									: current.phase === "importing"
										? "importing"
										: "waiting",
							}
						: current,
				);
				if (status.piOAuthConnected) {
					await refresh();
					setFigmaFlow((current) =>
						current
							? { ...current, status, phase: "connected", message: undefined }
							: current,
					);
					return;
				}
				if (
					options?.launchPlugin &&
					status.xcodeInstalled &&
					!status.xcodeHasFigmaServer
				) {
					await api.launchFigmaXcodePluginInstall();
					setFigmaFlow((current) =>
						current
							? {
									...current,
									status,
									phase: "waiting",
									message:
										"Xcode opened the Figma plugin install flow. Add the plugin there, then sign in.",
								}
							: current,
					);
					return;
				}
				if (options?.importIfReady !== false && status.xcodeHasBearerToken) {
					setFigmaFlow((current) =>
						current
							? { ...current, status, phase: "importing", message: undefined }
							: current,
					);
					const result = await api.importXcodeFigmaAuth();
					await refresh();
					setFigmaFlow((current) =>
						current
							? {
									...current,
									status: result.status,
									phase: result.status.piOAuthConnected ? "connected" : "waiting",
									message: result.message,
								}
							: current,
					);
					return;
				}
				setFigmaFlow((current) =>
					current
						? {
								...current,
								status,
								phase: "waiting",
								message: status.xcodeInstalled
									? status.xcodeHasFigmaServer
										? status.xcodeHasBearerToken
											? "Cosmos found the Xcode sign-in and is ready to import it."
											: "Finish the Figma sign-in inside Xcode, then press Continue."
										: "Add the Figma plugin in Xcode to continue."
									: "Install Xcode beta to continue.",
							}
						: current,
				);
			} catch (error) {
				setFigmaFlow((current) =>
					current
						? { ...current, phase: "failed", message: errorMessage(error) }
						: current,
				);
			}
		},
		[refresh],
	);

	useEffect(() => {
		if (!figmaFlow) return;
		if (figmaFlow.phase === "connected") return;
		const timer = setInterval(() => {
			void refreshFigmaFlow({ importIfReady: true });
		}, 2000);
		return () => clearInterval(timer);
	}, [figmaFlow, refreshFigmaFlow]);

	const connectOAuth = async (server: McpServerDefinition) => {
		if (!isFigmaMcp(server)) {
			const site = oauthProviderSite(server);
			if (site) void api.openExternal(site);
			return;
		}
		setFigmaFlow({ serverName: server.name, status: null, phase: "checking" });
		await refreshFigmaFlow({ launchPlugin: true, importIfReady: true });
	};

	const remove = async (server: McpServerDefinition) => {
		if (
			!window.confirm(
				`Remove ${server.name} from your personal MCP config? Team-shared servers are not affected.`,
			)
		)
			return;
		try {
			setOverview(await api.removePersonalMcpServer(server.name));
			toast("info", `Removed MCP server ${server.name}.`);
		} catch (error) {
			toast("error", errorMessage(error));
		}
	};

	return (
		<>
			<h3>MCP servers</h3>
			<p className="small-text muted" style={{ marginTop: -8 }}>
				Active tools come from Glayvin's merged MCP config. Personal additions are
				written to your local <code>mcp-config.json</code>.
			</p>
			<Setting
				name="Use chat context"
				help="When enabled, Cosmos can pause likely Figma design prompts until the Figma MCP is ready in fresh sessions. Turn this off to stop chat prompts from being gated by Figma availability."
			>
				<Switch
					label="Use chat context for Figma gating"
					on={settings.figmaChatContextGate}
					onChange={(figmaChatContextGate) =>
						updateSettings({ figmaChatContextGate })
					}
				/>
			</Setting>
			<div className="mcp-toolbar">
				<button type="button" className="btn small" onClick={() => void refresh()}>
					<RefreshCw size={12} /> Refresh
				</button>
				<button
					type="button"
					className="btn small primary"
					disabled={!overview?.available}
					onClick={() => setAdding(true)}
				>
					<Plus size={12} /> Add MCP
				</button>
				{overview?.personalConfigPath && (
					<button
						type="button"
						className="btn small"
						onClick={() => void api.openInEditor(overview.personalConfigPath!)}
					>
						Open personal config
					</button>
				)}
				{overview?.mergedConfigPath && (
					<button
						type="button"
						className="btn small"
						onClick={() => void api.openInEditor(overview.mergedConfigPath!)}
					>
						Open merged config
					</button>
				)}
			</div>
			{loading && (
				<div className="working">
					<SpinnerIcon size={14} /> Loading MCP config…
				</div>
			)}
			{!loading && overview && (
				<>
					<div className="mcp-meta">
						<div>
							<strong>Glayvin home:</strong>{" "}
							<span className="muted selectable">
								{overview.glayvinHome
									? tildify(overview.glayvinHome, info?.homeDir)
									: "Not available"}
							</span>
						</div>
						<div>
							<strong>pi agent:</strong>{" "}
							<span className="muted selectable">
								{tildify(overview.agentDir, info?.homeDir)}
							</span>
						</div>
						{overview.adapterConfigPath && (
							<div>
								<strong>Adapter config:</strong>{" "}
								<span className="muted selectable">
									{tildify(overview.adapterConfigPath, info?.homeDir)}
								</span>
							</div>
						)}
					</div>
					{overview.notes.map((note) => (
						<div key={note} className="notice info" style={{ marginTop: 10 }}>
							{note}
						</div>
					))}
					{overview.servers.length === 0 ? (
						<div className="muted" style={{ marginTop: 14 }}>
							No MCP servers are visible yet.
						</div>
					) : (
						<div className="mcp-list">
							{overview.servers.map((server) => (
								<div key={server.name} className="mcp-card">
									<div className="mcp-card-header">
										<div className="info">
											<div className="mcp-title-row">
												<strong>{server.name}</strong>
												<div className="mcp-badges">
													{server.active && (
														<span className="badge">
															<CircleCheck size={11} /> Active
														</span>
													)}
													{server.personal && (
														<span className="mcp-badge neutral">Personal</span>
													)}
													{server.personal && !server.active && !server.disabled && (
														<span className="mcp-badge warning">Pending merge</span>
													)}
													{server.disabled && (
														<span className="mcp-badge danger">Disabled</span>
													)}
													{server.auth === "oauth" && server.oauthConnected && (
														<span className="mcp-badge oauth">OAuth ready</span>
													)}
													{server.auth === "oauth" &&
														server.oauthConnected &&
														server.sessionAvailable === true && (
															<span className="mcp-badge neutral">Ready in new sessions</span>
														)}
													{server.auth === "oauth" &&
														server.oauthConnected &&
														server.sessionAvailable === false && (
															<span className="mcp-badge warning">
																Not loading in sessions
															</span>
														)}
													{server.auth === "oauth" && !server.oauthConnected && (
														<span className="mcp-badge warning">OAuth needed</span>
													)}
												</div>
											</div>
											<div className="source">{transportLabel(server)}</div>
											<div className="small-text muted">
												{server.tools.length
													? `Tools · ${server.tools.length} available`
													: "Tools · uses server defaults"}
											</div>
											{server.tools.length > 0 && (
												<details className="mcp-tools">
													<summary>{toolPreview(server.tools)}</summary>
													<div className="mcp-tools-body small-text muted selectable">
														{server.tools.join(", ")}
													</div>
												</details>
											)}
											{server.auth === "oauth" && (
												<div
													className={`mcp-oauth-note${server.oauthConnected ? " connected" : ""}`}
												>
													<div>{oauthHelpText(server)}</div>
												</div>
											)}
										</div>
										<div className="mcp-actions">
											{server.auth === "oauth" && (
												<>
													<button
														type="button"
														className="btn primary"
														onClick={() => void connectOAuth(server)}
														disabled={connectingServer === server.name}
													>
														<ExternalLink size={12} />{" "}
														{connectingServer === server.name
															? "Starting…"
															: oauthPrimaryLabel(server)}
													</button>
													<details className="mcp-troubleshoot">
														<summary>Troubleshoot</summary>
														<div className="mcp-troubleshoot-body">
															{oauthProviderSite(server) && (
																<button
																	type="button"
																	className="btn small"
																	onClick={() =>
																		void api.openExternal(oauthProviderSite(server)!)
																	}
																>
																	<ExternalLink size={12} /> Open provider site
																</button>
															)}
															{oauthSetupGuidePath(info, server) && (
																<button
																	type="button"
																	className="btn small"
																	onClick={() =>
																		void api.openInEditor(oauthSetupGuidePath(info, server)!)
																	}
																>
																	<ExternalLink size={12} /> Open setup guide
																</button>
															)}
															{server.oauthTokensPath && (
																<>
																	<button
																		type="button"
																		className="btn small"
																		onClick={() => void api.revealPath(server.oauthTokensPath!)}
																	>
																		<FolderOpen size={12} /> Reveal tokens
																	</button>
																	<button
																		type="button"
																		className="btn small"
																		onClick={() =>
																			void copyValue(
																				server.oauthTokensPath!,
																				`${server.name} token path`,
																			)
																		}
																	>
																		<Copy size={12} /> Copy token path
																	</button>
																	<div className="small-text muted selectable">
																		Token path: {tildify(server.oauthTokensPath, info?.homeDir)}
																	</div>
																</>
															)}
														</div>
													</details>
												</>
											)}
											{server.personal && (
												<>
													<button
														type="button"
														className="btn small"
														onClick={() => setEditing(server)}
													>
														<Pencil size={12} /> Edit
													</button>
													<button
														type="button"
														className="btn small danger"
														onClick={() => void remove(server)}
													>
														<Trash2 size={12} /> Remove
													</button>
												</>
											)}
										</div>
									</div>
								</div>
							))}
						</div>
					)}
				</>
			)}
			{adding && (
				<McpEditor
					onClose={() => setAdding(false)}
					onSaved={() => {
						setAdding(false);
						void refresh();
					}}
				/>
			)}
			{editing && (
				<McpEditor
					server={editing}
					onClose={() => setEditing(null)}
					onSaved={() => {
						setEditing(null);
						void refresh();
					}}
				/>
			)}
			{figmaFlow && (
				<FigmaConnectDialog
					flow={figmaFlow}
					onClose={() => setFigmaFlow(null)}
					onRefresh={() => void refreshFigmaFlow({ importIfReady: false })}
					onLaunchPlugin={() =>
						void refreshFigmaFlow({ launchPlugin: true, importIfReady: false })
					}
					onContinue={() => void refreshFigmaFlow({ importIfReady: true })}
				/>
			)}
		</>
	);
}

const PACK_LAYER_LABEL: Record<GlayvinPackLayer, string> = {
	"built-in": "Built-in",
	team: "Team",
	local: "Personal",
	unknown: "Unknown",
};

const PACK_LAYER_BLURB: Record<GlayvinPackLayer, string> = {
	"built-in": "Shipped with Glayvin.",
	team: "Authored by a team you have registered.",
	local: "Your own packs, on this machine only.",
	unknown: "Active, but the manifest is no longer on disk.",
};

const PACK_LAYER_ORDER: GlayvinPackLayer[] = [
	"built-in",
	"team",
	"local",
	"unknown",
];

/** Every pack counts down to 1 of something, so the plural has to bend. */
function countLabel(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Turns the resolver's terse inclusion reason into something a reader can act on. */
function inclusionReason(pack: GlayvinPackSummary): string | undefined {
	switch (pack.via) {
		case "profile":
			return "Named by the active profile";
		case "includes":
			return "Pulled in by another pack, not named by the profile";
		case "enabledPacks":
			return "Turned on by hand, outside the profile";
		case "core (auto)":
			return "Always on";
		default:
			return pack.via?.startsWith("requires:")
				? `Required by ${pack.via.slice("requires:".length)}`
				: pack.via;
	}
}

function teamContributionLabel(team: GlayvinTeamSummary): string {
	const { contributes } = team;
	const parts: string[] = [];
	if (contributes.packIds.length > 0)
		parts.push(countLabel(contributes.packIds.length, "pack"));
	if (contributes.profileIds.length > 0)
		parts.push(countLabel(contributes.profileIds.length, "profile"));
	if (contributes.mcpServerNames.length > 0)
		parts.push(`MCP: ${contributes.mcpServerNames.join(", ")}`);
	if (contributes.skillCount > 0)
		parts.push(countLabel(contributes.skillCount, "skill"));
	if (contributes.hasInstructions) parts.push("shared instructions");
	return parts.length > 0 ? parts.join(" · ") : "Contributes nothing yet";
}

function PackCard({
	pack,
	packages,
}: {
	pack: GlayvinPackSummary;
	packages: GlayvinPackageSummary[];
}) {
	const reason = inclusionReason(pack);
	return (
		<div className="mcp-card">
			<div className="mcp-card-header">
				<div className="info">
					<div className="mcp-title-row">
						<strong>{pack.id}</strong>
						<div className="mcp-badges">
							{pack.status === "effective" && (
								<span className="mcp-badge">On</span>
							)}
							{pack.status === "disabled" && (
								<span className="mcp-badge warning">Disabled</span>
							)}
							{pack.status === "available" && (
								<span className="mcp-badge neutral">Off</span>
							)}
							{pack.implicit && (
								<span className="mcp-badge neutral">Implicit</span>
							)}
							{pack.layer === "team" && pack.teamName && (
								<span className="mcp-badge neutral">{pack.teamName}</span>
							)}
						</div>
					</div>
					{pack.description && (
						<div className="small-text muted">{pack.description}</div>
					)}
					{pack.status === "effective" && reason && (
						<div className="small-text muted">{reason}</div>
					)}
					{pack.status === "effective" && (
						<div className="small-text muted">
							{countLabel(pack.packageCount, "package")} ·{" "}
							{countLabel(pack.extensionCount, "extension")} ·{" "}
							{countLabel(pack.skillCount, "skill")} ·{" "}
							{countLabel(pack.commandCount, "command")} ·{" "}
							{countLabel(pack.hookCount, "hook")}
						</div>
					)}
					{packages.length > 0 && (
						<div className="small-text muted selectable">
							{packages.map((pkg) => (
								<div key={pkg.name}>
									{pkg.name}
									{pkg.version ? `@${pkg.version}` : ""}
									{pkg.excludedByCosmos && (
										<span className="mcp-badge warning" style={{ marginLeft: 6 }}>
											Not used by Cosmos
										</span>
									)}
								</div>
							))}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function Glayvin() {
	const info = useStore((s) => s.appInfo);
	const [overview, setOverview] = useState<GlayvinProfileOverview | null>(null);
	const [loading, setLoading] = useState(true);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			setOverview(await api.getGlayvinProfileOverview());
		} catch (error) {
			toast("error", errorMessage(error));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const packagesByPack = useMemo(() => {
		const grouped = new Map<string, GlayvinPackageSummary[]>();
		for (const pkg of overview?.packages ?? []) {
			const key = pkg.pack ?? "";
			grouped.set(key, [...(grouped.get(key) ?? []), pkg]);
		}
		return grouped;
	}, [overview?.packages]);

	const packsByLayer = useMemo(() => {
		const grouped = new Map<GlayvinPackLayer, GlayvinPackSummary[]>();
		for (const pack of overview?.packs ?? []) {
			grouped.set(pack.layer, [...(grouped.get(pack.layer) ?? []), pack]);
		}
		// Active packs first, so the layers a user has actually turned on read from the top.
		for (const packs of grouped.values()) {
			packs.sort((a, b) => {
				const aOn = a.status === "effective" ? 0 : 1;
				const bOn = b.status === "effective" ? 0 : 1;
				return aOn - bOn || a.id.localeCompare(b.id);
			});
		}
		return grouped;
	}, [overview?.packs]);

	return (
		<>
			<h3>Glayvin</h3>
			<p className="small-text muted" style={{ marginTop: -8 }}>
				A Glayvin profile turns on a set of packs, and Cosmos inherits their pi
				packages. Read-only here — switch profiles with{" "}
				<code>glayvin profile set</code>.
			</p>
			<div className="mcp-toolbar">
				<button type="button" className="btn small" onClick={() => void refresh()}>
					<RefreshCw size={12} /> Refresh
				</button>
				{overview?.resolvedPath && (
					<button
						type="button"
						className="btn small"
						onClick={() => void api.openInEditor(overview.resolvedPath!)}
					>
						Open resolved profile
					</button>
				)}
			</div>
			{loading && (
				<div className="working">
					<SpinnerIcon size={14} /> Loading Glayvin details…
				</div>
			)}
			{!loading && overview && (
				<>
					<div className="mcp-meta">
						<div>
							<strong>Active profile:</strong>{" "}
							<span className="muted selectable">
								{overview.profile ?? "Not available"}
							</span>
						</div>
						<div>
							<strong>Glayvin home:</strong>{" "}
							<span className="muted selectable">
								{overview.glayvinHome
									? tildify(overview.glayvinHome, info?.homeDir)
									: "Not available"}
							</span>
						</div>
					</div>
					{overview.notes.map((note) => (
						<div key={note} className="notice info" style={{ marginTop: 10 }}>
							{note}
						</div>
					))}

					{overview.available && (
						<>
							<h3 style={{ marginTop: 18 }}>Profiles</h3>
							{overview.profiles.length === 0 ? (
								<div className="muted">No profiles were found.</div>
							) : (
								<div className="mcp-list">
									{overview.profiles.map((profile) => (
										<div key={profile.id} className="mcp-card">
											<div className="mcp-card-header">
												<div className="info">
													<div className="mcp-title-row">
														<strong>{profile.id}</strong>
														<div className="mcp-badges">
															{profile.active && (
																<span className="mcp-badge">Active</span>
															)}
															<span className="mcp-badge neutral">
																{PACK_LAYER_LABEL[profile.layer]}
															</span>
														</div>
													</div>
													{profile.description && (
														<div className="small-text muted">
															{profile.description}
														</div>
													)}
													{profile.packIds.length > 0 && (
														<div className="small-text muted">
															Turns on {profile.packIds.join(", ")}
														</div>
													)}
												</div>
											</div>
										</div>
									))}
								</div>
							)}

							<h3 style={{ marginTop: 18 }}>Packs</h3>
							{overview.packs.length === 0 ? (
								<div className="muted">No packs were found.</div>
							) : (
								PACK_LAYER_ORDER.filter((layer) => packsByLayer.has(layer)).map(
									(layer) => (
										<div key={layer} style={{ marginTop: 12 }}>
											<div className="mcp-title-row">
												<strong>{PACK_LAYER_LABEL[layer]}</strong>
												<span className="small-text muted">
													{PACK_LAYER_BLURB[layer]}
												</span>
											</div>
											<div className="mcp-list">
												{packsByLayer.get(layer)?.map((pack) => (
													<PackCard
														key={pack.id}
														pack={pack}
														packages={packagesByPack.get(pack.id) ?? []}
													/>
												))}
											</div>
										</div>
									),
								)
							)}

							<h3 style={{ marginTop: 18 }}>Team layers</h3>
							<p className="small-text muted" style={{ marginTop: -8 }}>
								A team layer is a directory of shared config Glayvin reads on every
								run. It can supply packs and profiles, and does not have to.
							</p>
							{overview.teams.length === 0 ? (
								<div className="muted">
									No team layers are registered. Add one with{" "}
									<code>glayvin manage teams add</code>.
								</div>
							) : (
								<div className="mcp-list">
									{overview.teams.map((team) => (
										<div key={team.name} className="mcp-card">
											<div className="mcp-card-header">
												<div className="info">
													<div className="mcp-title-row">
														<strong>{team.name}</strong>
														<div className="mcp-badges">
															{!team.enabled && (
																<span className="mcp-badge warning">Disabled</span>
															)}
															{!team.exists && (
																<span className="mcp-badge danger">Missing</span>
															)}
														</div>
													</div>
													<div className="small-text muted selectable">
														{tildify(team.path, info?.homeDir)}
													</div>
													<div className="small-text muted">
														{teamContributionLabel(team)}
													</div>
												</div>
											</div>
										</div>
									))}
								</div>
							)}
						</>
					)}

					<p className="small-text muted" style={{ marginTop: 18 }}>
						Cosmos mirrors the active profile's packages into its own agent
						directory, minus the external permission system, and adds its bundled
						company package. Packs and profiles can also come from the repository
						Glayvin runs in; Cosmos cannot see those from here.
					</p>
				</>
			)}
		</>
	);
}

function About() {
	const info = useStore((s) => s.appInfo);
	if (!info) return null;
	const agentDirSourceLabel =
		info.agentDirSource === "cosmos-managed"
			? "Cosmos workspace (recommended)"
			: info.agentDirSource === "glayvin"
				? "Shared Glayvin setup"
				: "Custom Pi setup";
	return (
		<>
			<h3>About</h3>
			<Setting name="Cosmos">
				<span className="muted">{info.appVersion}</span>
			</Setting>
			<Setting name="pi" help="The pi coding agent this app runs">
				<span className="muted">{info.piVersion}</span>
			</Setting>
			<Setting name="Electron">
				<span className="muted">{info.electronVersion}</span>
			</Setting>
			<Setting
				name="Workspace source"
				help={
					info.agentDirSource === "cosmos-managed"
						? "Cosmos is using its own managed GUI workspace. If Glayvin is installed, its shared MCP/config context is still available without reusing the terminal session store."
						: info.agentDirSource === "glayvin"
							? "Cosmos is currently reusing a shared Glayvin setup."
							: "Cosmos is currently using a manually chosen Pi workspace."
				}
			>
				<span className="muted">{agentDirSourceLabel}</span>
			</Setting>
			<Setting
				name="Cosmos workspace root"
				help={tildify(info.workspaceRoot, info.homeDir)}
			>
				<button
					type="button"
					className="btn small"
					onClick={() => void api.openPath(info.workspaceRoot)}
				>
					Open folder
				</button>
			</Setting>
			<Setting name="pi configuration" help={tildify(info.agentDir, info.homeDir)}>
				<button
					type="button"
					className="btn small"
					onClick={() => void api.openPath(info.agentDir)}
				>
					Open folder
				</button>
			</Setting>
			{info.glayvinHome && (
				<Setting name="Glayvin home" help={tildify(info.glayvinHome, info.homeDir)}>
					<button
						type="button"
						className="btn small"
						onClick={() => void api.openPath(info.glayvinHome!)}
					>
						Open folder
					</button>
				</Setting>
			)}
			<Setting name="Logs" help={tildify(info.logPath, info.homeDir)}>
				<button
					type="button"
					className="btn small"
					onClick={() => void api.revealPath(info.logPath)}
				>
					Show in Finder
				</button>
			</Setting>
		</>
	);
}

const PANES: { id: SettingsPane; label: string; icon: typeof Plug }[] = [
	{ id: "general", label: "General", icon: SlidersHorizontal },
	{ id: "providers", label: "Providers", icon: KeyRound },
	{ id: "mcps", label: "MCPs", icon: Plug },
	{ id: "glayvin", label: "Glayvin", icon: Layers },
	{ id: "about", label: "About", icon: Info },
];

export function SettingsModal({ pane }: { pane: SettingsPane }) {
	const settings = useStore((s) => s.settings);
	const close = () => useStore.setState({ settingsPane: null });
	const update = (patch: Partial<DesktopSettings>) => {
		void api
			.updateSettings(patch)
			.then((next) => useStore.setState({ settings: next }));
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !document.querySelector(".modal.small")) close();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	return (
		<div
			className="modal-backdrop"
			onMouseDown={(e) => e.target === e.currentTarget && close()}
		>
			<div className="modal" role="dialog" aria-label="Settings">
				<div className="modal-nav">
					<h2>Settings</h2>
					{PANES.map(({ id, label, icon: Icon }) => (
						<button
							key={id}
							type="button"
							className={`menu-item${pane === id ? " selected" : ""}`}
							onClick={() => useStore.setState({ settingsPane: id })}
						>
							<Icon size={14} /> {label}
						</button>
					))}
				</div>
				<div className="modal-content">
					<div
						style={{ display: "flex", justifyContent: "flex-end", marginBottom: -30 }}
					>
						<button
							type="button"
							className="icon-btn"
							onClick={close}
							aria-label="Close settings"
						>
							<X size={16} />
						</button>
					</div>
					{pane === "general" && <General settings={settings} update={update} />}
					{pane === "providers" && <Providers />}
					{pane === "mcps" && <Mcps />}
					{pane === "glayvin" && <Glayvin />}
					{pane === "about" && <About />}
				</div>
			</div>
		</div>
	);
}
