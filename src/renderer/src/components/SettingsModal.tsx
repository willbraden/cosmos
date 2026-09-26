import type { DesktopSettings, ProviderInfo } from "@shared/ipc";
import { CircleCheck, Info, KeyRound, Plug, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage, tildify } from "../lib/api";
import { refreshProviders } from "../state/actions";
import { type SettingsPane, toast, useStore } from "../state/store";
import { LoginDialog } from "./LoginDialog";
import { PERMISSION_MODES } from "./Pickers";

function Switch({ on, onChange, label }: { on: boolean; onChange(on: boolean): void; label: string }) {
	return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch${on ? " on" : ""}`} onClick={() => onChange(!on)} />;
}

function Setting({ name, help, children }: { name: string; help?: string; children: React.ReactNode }) {
	return (
		<div className="setting">
			<div className="setting-text">
				<span className="name">{name}</span>
				{help && <span className="help">{help}</span>}
			</div>
			{children}
		</div>
	);
}

function General({ settings, update }: { settings: DesktopSettings; update(patch: Partial<DesktopSettings>): void }) {
	const [cliPath, setCliPath] = useState(settings.piCliPath);
	return (
		<>
			<h3>General</h3>
			<Setting name="Appearance">
				<div className="segmented">
					{(["system", "light", "dark"] as const).map((theme) => (
						<button key={theme} type="button" className={settings.theme === theme ? "on" : ""} onClick={() => update({ theme })}>
							{theme[0].toUpperCase() + theme.slice(1)}
						</button>
					))}
				</div>
			</Setting>
			<Setting name="Default permission mode" help="Used for new sessions. Change it per session from the message box.">
				<select value={settings.permissionMode} onChange={(e) => update({ permissionMode: e.target.value as DesktopSettings["permissionMode"] })}>
					{PERMISSION_MODES.map((m) => (
						<option key={m.mode} value={m.mode}>
							{m.label}
						</option>
					))}
				</select>
			</Setting>
			<Setting name="Messages sent while pi is working" help="Steer delivers after the current tool calls; queue waits until pi finishes. ⌥↩ does the other.">
				<div className="segmented">
					<button type="button" className={settings.busySendMode === "steer" ? "on" : ""} onClick={() => update({ busySendMode: "steer" })}>
						Steer
					</button>
					<button type="button" className={settings.busySendMode === "followUp" ? "on" : ""} onClick={() => update({ busySendMode: "followUp" })}>
						Queue
					</button>
				</div>
			</Setting>
			<Setting name="Notifications" help="Notify when pi finishes or needs you while the window is in the background.">
				<Switch label="Notifications" on={settings.notifications} onChange={(notifications) => update({ notifications })} />
			</Setting>
			<Setting name="Suspend idle sessions after" help="Background sessions release their pi process when idle and resume instantly when you return.">
				<select value={settings.idleSuspendMinutes} onChange={(e) => update({ idleSuspendMinutes: Number(e.target.value) })}>
					{[5, 15, 30, 60, 240, 0].map((m) => (
						<option key={m} value={m}>
							{m === 0 ? "Never" : m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? "s" : ""}`}
						</option>
					))}
				</select>
			</Setting>
			<Setting name="Custom pi CLI" help="Absolute path to a pi cli.js (e.g. a local build). Leave empty to use the bundled pi. Applies to newly started sessions.">
				<input
					type="text"
					placeholder="Bundled"
					value={cliPath}
					style={{ width: 240 }}
					onChange={(e) => setCliPath(e.target.value)}
					onBlur={() => {
						if (cliPath && !cliPath.startsWith("/")) {
							toast("warning", "Enter an absolute path.");
							return;
						}
						update({ piCliPath: cliPath });
					}}
				/>
			</Setting>
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
	const [login, setLogin] = useState<{ provider: ProviderInfo; method: "oauth" | "api_key" } | null>(null);
	const [filter, setFilter] = useState("");
	const [showAll, setShowAll] = useState(false);
	const closeLogin = useCallback(() => setLogin(null), []);

	useEffect(() => {
		void refreshProviders();
	}, []);

	const { connected, subscriptions, rest } = useMemo(() => {
		const q = filter.toLowerCase();
		const match = (p: ProviderInfo) => !q || p.name.toLowerCase().includes(q) || p.id.includes(q);
		const list = providers.filter(match);
		return {
			connected: list.filter((p) => p.configured),
			subscriptions: list.filter((p) => !p.configured && p.oauth),
			rest: list.filter((p) => !p.configured && !p.oauth),
		};
	}, [providers, filter]);

	const logout = async (provider: ProviderInfo) => {
		if (!window.confirm(`Sign out of ${provider.name}? The stored credential is removed from pi's auth file.`)) return;
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
				<span className="source">{provider.configured ? `via ${describeSource(provider.source)}` : provider.id}</span>
			</div>
			{provider.storedCredential ? (
				<button type="button" className="btn small" onClick={() => void logout(provider)}>
					Sign out
				</button>
			) : provider.configured ? null : (
				<>
					{provider.oauth && (
						<button type="button" className="btn small primary" onClick={() => setLogin({ provider, method: "oauth" })}>
							{provider.oauth.label}
						</button>
					)}
					{provider.apiKey?.interactive && (
						<button type="button" className="btn small" onClick={() => setLogin({ provider, method: "api_key" })}>
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
				Cosmos uses pi's own credentials (<code>auth.json</code>), environment variables, and <code>models.json</code> — anything you set up in the pi CLI works here too.
			</p>
			<input className="text-input" placeholder="Filter providers" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ margin: "6px 0 10px" }} />
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
				<button type="button" className="btn small" style={{ marginTop: 10 }} onClick={() => setShowAll(true)}>
					Show all {rest.length}
				</button>
			)}
			{login && <LoginDialog provider={login.provider} method={login.method} onClose={closeLogin} />}
		</>
	);
}

function About() {
	const info = useStore((s) => s.appInfo);
	if (!info) return null;
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
			<Setting name="pi configuration" help={tildify(info.agentDir, info.homeDir)}>
				<button type="button" className="btn small" onClick={() => void api.openPath(info.agentDir)}>
					Open folder
				</button>
			</Setting>
			<Setting name="Logs" help={tildify(info.logPath, info.homeDir)}>
				<button type="button" className="btn small" onClick={() => void api.revealPath(info.logPath)}>
					Show in Finder
				</button>
			</Setting>
		</>
	);
}

const PANES: { id: SettingsPane; label: string; icon: typeof Plug }[] = [
	{ id: "general", label: "General", icon: SlidersHorizontal },
	{ id: "providers", label: "Providers", icon: Plug },
	{ id: "about", label: "About", icon: Info },
];

export function SettingsModal({ pane }: { pane: SettingsPane }) {
	const settings = useStore((s) => s.settings);
	const close = () => useStore.setState({ settingsPane: null });
	const update = (patch: Partial<DesktopSettings>) => {
		void api.updateSettings(patch).then((next) => useStore.setState({ settings: next }));
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !document.querySelector(".modal.small")) close();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	return (
		<div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
			<div className="modal" role="dialog" aria-label="Settings">
				<div className="modal-nav">
					<h2>Settings</h2>
					{PANES.map(({ id, label, icon: Icon }) => (
						<button key={id} type="button" className={`menu-item${pane === id ? " selected" : ""}`} onClick={() => useStore.setState({ settingsPane: id })}>
							<Icon size={14} /> {label}
						</button>
					))}
				</div>
				<div className="modal-content">
					<div style={{ display: "flex", justifyContent: "flex-end", marginBottom: -30 }}>
						<button type="button" className="icon-btn" onClick={close} aria-label="Close settings">
							<X size={16} />
						</button>
					</div>
					{pane === "general" && <General settings={settings} update={update} />}
					{pane === "providers" && <Providers />}
					{pane === "about" && <About />}
				</div>
			</div>
		</div>
	);
}
