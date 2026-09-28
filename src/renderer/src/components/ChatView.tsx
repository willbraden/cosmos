import { FileDiff, FolderOpen, GitFork, RotateCw, SquareTerminal, TriangleAlert } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { api, basename, formatCost, formatTokens, tildify } from "../lib/api";
import { cloneSession, renameSession, retryTab, sendDraft, setDraft } from "../state/actions";
import { collectFileChanges, firstUserMessage } from "../state/chat-model";
import { sessionTitle, type TabState, useStore } from "../state/store";
import { Composer } from "./Composer";
import { DialogCard } from "./DialogCard";
import { useDismiss } from "./Pickers";
import { Transcript } from "./Transcript";

function ContextMeter({ tab }: { tab: TabState }) {
	const usage = tab.stats?.contextUsage;
	const percent = usage?.percent ?? null;
	if (!tab.stats) return null;
	const radius = 7;
	const circumference = 2 * Math.PI * radius;
	const fraction = Math.min(1, Math.max(0, (percent ?? 0) / 100));
	const color = fraction > 0.85 ? "var(--danger)" : fraction > 0.65 ? "var(--warning)" : "var(--accent)";
	const title = [
		usage && percent !== null ? `Context: ${formatTokens(usage.tokens ?? 0)} of ${formatTokens(usage.contextWindow)} (${Math.round(percent)}%)` : "Context usage available after the next reply",
		`Session: ${formatTokens(tab.stats.tokens.total)} tokens · ${formatCost(tab.stats.cost)}`,
		"Pi compacts automatically when the context is nearly full.",
	].join("\n");
	return (
		<span className="context-meter" title={title}>
			<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
				<circle cx="9" cy="9" r={radius} fill="none" stroke="var(--border-strong)" strokeWidth="2" />
				<circle
					cx="9"
					cy="9"
					r={radius}
					fill="none"
					stroke={color}
					strokeWidth="2"
					strokeDasharray={`${fraction * circumference} ${circumference}`}
					transform="rotate(-90 9 9)"
					strokeLinecap="round"
				/>
			</svg>
			{percent !== null ? `${Math.round(percent)}%` : "–"}
			{tab.stats.cost > 0 && <span>· {formatCost(tab.stats.cost)}</span>}
		</span>
	);
}

function ProjectMenu({ cwd }: { cwd: string }) {
	const home = useStore((s) => s.appInfo?.homeDir);
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useDismiss(ref, open, () => setOpen(false));
	const run = (fn: () => Promise<unknown>) => {
		setOpen(false);
		void fn();
	};
	return (
		<div ref={ref} style={{ position: "relative" }}>
			<button type="button" className="chip" title={tildify(cwd, home)} onClick={() => setOpen(!open)}>
				<FolderOpen size={13} />
				<span>{basename(cwd)}</span>
			</button>
			{open && (
				<div className="popover" style={{ top: "calc(100% + 4px)", left: 0 }}>
					<div className="popover-label">{tildify(cwd, home)}</div>
					<button type="button" className="menu-item" onClick={() => run(() => api.openPath(cwd))}>
						<FolderOpen size={14} /> Open in Finder
					</button>
					<button type="button" className="menu-item" onClick={() => run(() => api.openInEditor(cwd))}>
						<FileDiff size={14} /> Open in editor
					</button>
					<button type="button" className="menu-item" onClick={() => run(() => api.openTerminal(cwd))}>
						<SquareTerminal size={14} /> Open in Terminal
					</button>
				</div>
			)}
		</div>
	);
}

function Title({ tab }: { tab: TabState }) {
	const summary = useStore((s) => s.sessions.find((x) => x.path === tab.sessionPath));
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState("");
	const title = sessionTitle(tab.name ? { name: tab.name } : summary, "New session", firstUserMessage(tab.chat), tab.autoTitle);
	if (editing) {
		return (
			<input
				className="header-title-input no-drag"
				// biome-ignore lint/a11y/noAutofocus: rename was explicitly requested
				autoFocus
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onBlur={() => {
					setEditing(false);
					if (value.trim() && value.trim() !== title) void renameSession(tab.tabId, value);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
					if (e.key === "Escape") {
						setValue(title);
						setEditing(false);
					}
				}}
			/>
		);
	}
	return (
		<button
			type="button"
			className="header-title no-drag"
			style={{ border: "none", background: "transparent", textAlign: "left" }}
			title="Rename session"
			disabled={tab.chat.items.length === 0}
			onClick={() => {
				setValue(title);
				setEditing(true);
			}}
		>
			{title}
		</button>
	);
}

export function ChatHeader({ tab, scrolled }: { tab: TabState; scrolled: boolean }) {
	const changesOpen = useStore((s) => s.changesOpen);
	const changeCount = useMemo(() => new Set(collectFileChanges(tab.chat).map((c) => c.path)).size, [tab.chat]);
	return (
		<div className={`main-header drag${scrolled ? " scrolled" : ""}`}>
			<Title tab={tab} />
			<ProjectMenu cwd={tab.cwd} />
			<span className="spacer" />
			<ContextMeter tab={tab} />
			{tab.chat.items.length > 0 && (
				<button type="button" className="icon-btn" title="Fork into a new session" onClick={() => void cloneSession(tab.tabId)} disabled={tab.isStreaming}>
					<GitFork size={16} />
				</button>
			)}
			<button
				type="button"
				className={`icon-btn${changesOpen ? " active" : ""}`}
				title="Changes (⌘⇧D)"
				onClick={() => useStore.setState({ changesOpen: !changesOpen })}
				style={{ width: "auto", padding: "0 8px", gap: 5, fontSize: 12 }}
			>
				<FileDiff size={16} />
				{changeCount > 0 && changeCount}
			</button>
		</div>
	);
}

function Welcome({ tab }: { tab: TabState }) {
	const providers = useStore((s) => s.providers);
	const models = useStore((s) => s.models);
	const noProvider = tab.status === "ready" && models.length === 0 && !providers.some((p) => p.configured);
	const starters = [
		{
			label: "Plan a feature",
			prompt: "Help me plan a feature for this app. Ask a few clarifying questions, then propose an approach.",
		},
		{
			label: "Build something",
			prompt: "Help me implement a change in this project. Start by asking what I want to build.",
		},
		{
			label: "Fix an issue",
			prompt: "Help me debug an issue in this project. Ask what's broken, then guide me to a fix.",
		},
	];
	const startWithPrompt = (prompt: string) => {
		setDraft(tab.tabId, prompt);
		void sendDraft(tab.tabId);
	};
	return (
		<div className="empty empty-cosmos empty-chat-welcome">
			<h1 className="cosmos-wordmark cosmos-wordmark-hero" aria-label="cosmos">
				<span className="cosmos-wordmark-light">cosm</span>
				<span className="cosmos-wordmark-strong">os</span>
			</h1>
			<div className="empty-chat-actions" role="group" aria-label="Suggested ways to start">
				{starters.map((starter) => (
					<button key={starter.label} type="button" className="empty-chat-action" onClick={() => startWithPrompt(starter.prompt)}>
						{starter.label}
					</button>
				))}
			</div>
			{noProvider && (
				<div className="welcome-card">
					<TriangleAlert size={18} style={{ color: "var(--warning)", flexShrink: 0, marginTop: 2 }} />
					<div>
						<div style={{ fontWeight: 600, marginBottom: 2 }}>Connect a model provider</div>
						<div className="small-text muted" style={{ marginBottom: 10 }}>
							Sign in with a subscription (Claude, ChatGPT, Copilot…) or add an API key. Credentials are stored in pi's own auth file, shared with the pi CLI.
						</div>
						<button type="button" className="btn primary small" onClick={() => useStore.setState({ settingsPane: "providers" })}>
							Connect a provider
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

export function ChatView({ tab }: { tab: TabState }) {
	const [scrolled, setScrolled] = useState(false);
	const dialog = tab.dialogs[0];

	if (tab.status === "error") {
		return (
			<div className="main">
				<ChatHeader tab={tab} scrolled={false} />
				<div className="empty">
					<TriangleAlert size={28} style={{ color: "var(--danger)" }} />
					<h1 style={{ fontSize: 20 }}>Pi could not start</h1>
					<pre className="tool-pre error" style={{ maxWidth: 680, textAlign: "left" }}>
						{tab.error}
					</pre>
					<button type="button" className="btn primary" onClick={() => void retryTab(tab.tabId)}>
						<RotateCw size={14} /> Try again
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="main">
			<ChatHeader tab={tab} scrolled={scrolled} />
			<div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
				{tab.status === "starting" && tab.chat.items.length === 0 ? (
					<div className="empty">
						<span className="spinner" style={{ width: 20, height: 20 }} />
					</div>
				) : tab.chat.items.length === 0 && !tab.isStreaming ? (
					<Welcome tab={tab} />
				) : (
					<Transcript tab={tab} onScrolled={setScrolled} />
				)}
			</div>
			{dialog && (
				<div style={{ padding: "0 28px" }}>
					<DialogCard key={dialog.id} tabId={tab.tabId} dialog={dialog} />
				</div>
			)}
			<Composer tab={tab} />
		</div>
	);
}
