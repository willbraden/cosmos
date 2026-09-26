import type { SessionSummary } from "@shared/ipc";
import { ChevronRight, FolderPlus, PanelLeftClose, Pin, Plus, Search, Settings, SquarePen } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { api, basename, relativeTime, tildify } from "../lib/api";
import {
	activateTab,
	chooseFolderAndStart,
	deleteSession,
	exportHtml,
	openExistingSession,
	renameSessionByPath,
	runSearch,
	startNewSession,
	tabForSession,
	togglePin,
} from "../state/actions";
import { activeTab, sessionTitle, type TabState, useStore } from "../state/store";

const GROUP_PREVIEW = 6;

interface Row {
	key: string;
	title: string;
	cwd: string;
	modified: number;
	summary?: SessionSummary;
	tab?: TabState;
}

const SessionRow = memo(function SessionRow({ row, active, pinned }: { row: Row; active: boolean; pinned: boolean }) {
	const [renaming, setRenaming] = useState(false);
	const [value, setValue] = useState(row.title);
	const tab = row.tab;
	const attention = (tab?.dialogs.length ?? 0) > 0;
	const busy = tab?.isStreaming || tab?.isCompacting;

	const open = () => {
		if (row.summary) void openExistingSession(row.summary.path, row.summary.cwd);
		else if (tab) activateTab(tab.tabId);
	};

	const onContextMenu = async (event: React.MouseEvent) => {
		event.preventDefault();
		const path = row.summary?.path;
		if (!path) return;
		const action = await api.sessionContextMenu(path, pinned);
		switch (action) {
			case "rename":
				setValue(row.title);
				setRenaming(true);
				break;
			case "pin":
			case "unpin":
				await togglePin(path);
				break;
			case "reveal":
				await api.revealPath(path);
				break;
			case "copyPath":
				await api.copyText(path);
				break;
			case "exportHtml": {
				await openExistingSession(path, row.cwd);
				const opened = tabForSession(path);
				if (opened) await exportHtml(opened.tabId);
				break;
			}
			case "delete":
				if (window.confirm(`Move "${row.title}" to the Trash?`)) await deleteSession(path);
				break;
		}
	};

	if (renaming) {
		return (
			<input
				className="text-input"
				style={{ margin: "2px 0", height: 30 }}
				// biome-ignore lint/a11y/noAutofocus: rename was explicitly requested
				autoFocus
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onBlur={() => {
					setRenaming(false);
					if (row.summary && value.trim() && value.trim() !== row.title) void renameSessionByPath(row.summary.path, row.cwd, value);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
					if (e.key === "Escape") {
						setValue(row.title);
						setRenaming(false);
					}
				}}
			/>
		);
	}

	return (
		<button
			type="button"
			className={`session-row${active ? " active" : ""}${tab?.unread ? " unread" : ""}`}
			onClick={open}
			onContextMenu={onContextMenu}
			title={row.title}
		>
			{busy ? (
				<span className="spinner" title="Working" />
			) : attention ? (
				<span className="status-dot attention" title="Waiting for you" />
			) : tab?.unread ? (
				<span className="status-dot unread" title="New reply" />
			) : null}
			<span className="title">{row.title}</span>
			<span className="meta">{relativeTime(row.modified)}</span>
		</button>
	);
});

function Group({ cwd, rows, activeKey, pinned }: { cwd: string; rows: Row[]; activeKey: string | null; pinned: Set<string> }) {
	const home = useStore((s) => s.appInfo?.homeDir);
	const [collapsed, setCollapsed] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const visible = expanded ? rows : rows.slice(0, GROUP_PREVIEW);
	// Always keep the active session visible even when the group is truncated.
	const activeRow = rows.find((r) => r.key === activeKey);
	if (activeRow && !visible.includes(activeRow)) visible.push(activeRow);
	return (
		<div className="sidebar-section">
			<div style={{ display: "flex", alignItems: "center" }}>
				<button type="button" className="sidebar-section-header" onClick={() => setCollapsed(!collapsed)} title={tildify(cwd, home)}>
					<ChevronRight size={12} style={{ transform: collapsed ? undefined : "rotate(90deg)", transition: "transform .15s" }} />
					{basename(cwd) || cwd}
				</button>
				<button type="button" className="icon-btn" style={{ width: 22, height: 22 }} title={`New session in ${basename(cwd)}`} onClick={() => void startNewSession(cwd)}>
					<Plus size={13} />
				</button>
			</div>
			{!collapsed && (
				<>
					{visible.map((row) => (
						<SessionRow key={row.key} row={row} active={row.key === activeKey} pinned={pinned.has(row.key)} />
					))}
					{rows.length > GROUP_PREVIEW && (
						<button type="button" className="session-row" style={{ color: "var(--text-3)", fontSize: 12 }} onClick={() => setExpanded(!expanded)}>
							{expanded ? "Show less" : `Show ${rows.length - GROUP_PREVIEW} more`}
						</button>
					)}
				</>
			)}
		</div>
	);
}

export function Sidebar() {
	const sessions = useStore((s) => s.sessions);
	const tabs = useStore((s) => s.tabs);
	const activeTabId = useStore((s) => s.activeTabId);
	const pinnedPaths = useStore((s) => s.settings.pinnedSessions);
	const searchQuery = useStore((s) => s.searchQuery);
	const searchMatches = useStore((s) => s.searchMatches);
	const sessionsLoaded = useStore((s) => s.sessionsLoaded);
	const focusSearchTick = useStore((s) => s.focusSearchTick);
	const searchRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (focusSearchTick > 0) searchRef.current?.focus();
	}, [focusSearchTick]);

	const rows = useMemo(() => {
		const tabsByPath = new Map<string, TabState>();
		for (const tab of Object.values(tabs)) if (tab.sessionPath) tabsByPath.set(tab.sessionPath, tab);
		const list: Row[] = sessions.map((summary) => {
			const tab = tabsByPath.get(summary.path);
			return {
				key: summary.path,
				title: sessionTitle(tab?.name ? { name: tab.name } : summary),
				cwd: summary.cwd,
				modified: summary.modified,
				summary,
				tab,
			};
		});
		// Sessions that have not been written to disk yet (no messages) but are open.
		const known = new Set(sessions.map((s) => s.path));
		for (const tab of Object.values(tabs)) {
			if (tab.sessionPath && known.has(tab.sessionPath)) continue;
			if (tab.chat.items.length === 0 && tab.tabId !== activeTabId) continue;
			list.push({ key: tab.tabId, title: tab.name ?? "New session", cwd: tab.cwd, modified: Date.now(), tab });
		}
		return list;
	}, [sessions, tabs, activeTabId]);

	const activeKey = useMemo(() => {
		const tab = activeTabId ? tabs[activeTabId] : undefined;
		if (!tab) return null;
		return tab.sessionPath && sessions.some((s) => s.path === tab.sessionPath) ? tab.sessionPath : tab.tabId;
	}, [activeTabId, tabs, sessions]);

	const pinned = useMemo(() => new Set(pinnedPaths), [pinnedPaths]);
	const query = searchQuery.trim().toLowerCase();

	const { pinnedRows, groups, results } = useMemo(() => {
		if (query) {
			const textMatches = new Set(searchMatches ?? []);
			return {
				pinnedRows: [],
				groups: [],
				results: rows
					.filter((row) => row.title.toLowerCase().includes(query) || (row.summary && textMatches.has(row.summary.path)))
					.sort((a, b) => b.modified - a.modified),
			};
		}
		const byCwd = new Map<string, Row[]>();
		const pinnedList: Row[] = [];
		for (const row of rows) {
			if (pinned.has(row.key)) pinnedList.push(row);
			else byCwd.set(row.cwd, [...(byCwd.get(row.cwd) ?? []), row]);
		}
		for (const list of byCwd.values()) list.sort((a, b) => b.modified - a.modified);
		const ordered = [...byCwd.entries()].sort((a, b) => (b[1][0]?.modified ?? 0) - (a[1][0]?.modified ?? 0));
		return { pinnedRows: pinnedList.sort((a, b) => b.modified - a.modified), groups: ordered, results: null };
	}, [rows, query, searchMatches, pinned]);

	return (
		<nav className="sidebar">
			<div className="sidebar-top drag">
				<div className="sidebar-top-row">
					<button type="button" className="icon-btn" title="Hide sidebar (⌘\)" onClick={() => void api.updateSettings({ sidebarCollapsed: true })}>
						<PanelLeftClose size={16} />
					</button>
				</div>
				<button type="button" className="new-session-btn" onClick={() => void startNewSession(activeTab()?.cwd)}>
					<SquarePen size={15} /> New session <span className="kbd">⌘N</span>
				</button>
				<label className="search">
					<Search size={14} />
					<input
						ref={searchRef}
						placeholder="Search sessions"
						value={searchQuery}
						onChange={(e) => void runSearch(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								void runSearch("");
								e.currentTarget.blur();
							}
						}}
					/>
					<span className="kbd">⌘K</span>
				</label>
			</div>
			<div className="sidebar-list">
				{results ? (
					results.length ? (
						results.map((row) => <SessionRow key={row.key} row={row} active={row.key === activeKey} pinned={pinned.has(row.key)} />)
					) : (
						<div className="sidebar-empty">No sessions match "{searchQuery}"</div>
					)
				) : (
					<>
						{pinnedRows.length > 0 && (
							<div className="sidebar-section">
								<div className="sidebar-section-header">
									<Pin size={11} /> Pinned
								</div>
								{pinnedRows.map((row) => (
									<SessionRow key={row.key} row={row} active={row.key === activeKey} pinned />
								))}
							</div>
						)}
						{groups.map(([cwd, list]) => (
							<Group key={cwd} cwd={cwd} rows={list} activeKey={activeKey} pinned={pinned} />
						))}
						{sessionsLoaded && rows.length === 0 && <div className="sidebar-empty">Your pi sessions will show up here, grouped by project.</div>}
					</>
				)}
			</div>
			<div className="sidebar-footer">
				<button type="button" className="icon-btn" title="Settings (⌘,)" onClick={() => useStore.setState({ settingsPane: "general" })}>
					<Settings size={16} />
				</button>
				<span className="spacer" />
				<button type="button" className="btn small" onClick={() => void chooseFolderAndStart()}>
					<FolderPlus size={13} /> Open folder
				</button>
			</div>
		</nav>
	);
}
