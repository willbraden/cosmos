import type { SessionSummary, WorkspaceHealth } from "@shared/ipc";
import {
	applyManualSessionOrder,
	compareSessionOrder,
	moveSessionOrderItem,
	type SessionDropPlacement,
} from "@shared/session-order";
import {
	ChevronRight,
	Folder,
	GitFork,
	House,
	MessageCircle,
	PanelLeftClose,
	Pin,
	Plus,
	Search,
	Settings,
} from "lucide-react";
import {
	memo,
	type DragEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { api, basename, relativeTime, tildify } from "../lib/api";
import { SpinnerIcon } from "./SpinnerIcon";
import { useDismiss } from "./Pickers";
import { firstUserMessage } from "../state/chat-model";
import {
	activateTab,
	confirmDeleteSession,
	exportHtml,
	openExistingSession,
	renameSessionByPath,
	runSearch,
	showHome,
	startNewSession,
	tabForSession,
	togglePin,
} from "../state/actions";
import { sessionTitle, type TabState, useStore } from "../state/store";

const GROUP_PREVIEW = 6;

interface Row {
	key: string;
	stableKey: string;
	title: string;
	cwd: string;
	created: number;
	modified: number;
	summary?: SessionSummary;
	tab?: TabState;
}

type DragState = {
	cwd: string;
	draggingKey: string;
	overKey: string | null;
	placement: SessionDropPlacement;
};

type RepoKind = "supported" | "experiment";

function firstTimestamp(tab: TabState): number | undefined {
	for (const item of tab.chat.items)
		if ("timestamp" in item && typeof item.timestamp === "number")
			return item.timestamp;
	return undefined;
}

function lastTimestamp(tab: TabState): number | undefined {
	for (let i = tab.chat.items.length - 1; i >= 0; i--) {
		const item = tab.chat.items[i];
		if ("timestamp" in item && typeof item.timestamp === "number")
			return item.timestamp;
	}
	return undefined;
}

const SessionRow = memo(function SessionRow({
	row,
	active,
	pinned,
	draggable = false,
	dragging = false,
	dropBefore = false,
	dropAfter = false,
	onDragStart,
	onDragOver,
	onDrop,
	onDragEnd,
}: {
	row: Row;
	active: boolean;
	pinned: boolean;
	draggable?: boolean;
	dragging?: boolean;
	dropBefore?: boolean;
	dropAfter?: boolean;
	onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
	onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
	onDrop?: (event: DragEvent<HTMLDivElement>) => void;
	onDragEnd?: () => void;
}) {
	const [renaming, setRenaming] = useState(false);
	const [value, setValue] = useState(row.title);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	useDismiss(menuRef, !!menu, () => setMenu(null));
	const tab = row.tab;
	const attention = (tab?.dialogs.length ?? 0) > 0;
	const busy = tab?.isStreaming || tab?.isCompacting;

	const open = () => {
		if (row.summary) void openExistingSession(row.summary.path, row.summary.cwd);
		else if (tab) activateTab(tab.tabId);
	};

	const path = row.summary?.path;
	const runMenuAction = (fn: () => Promise<void> | void) => {
		setMenu(null);
		void fn();
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
					if (row.summary && value.trim() && value.trim() !== row.title)
						void renameSessionByPath(row.summary.path, row.cwd, value);
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

	const menuLeft = menu
		? Math.max(8, Math.min(menu.x, window.innerWidth - 236))
		: 0;
	const menuTop = menu
		? Math.max(8, Math.min(menu.y, window.innerHeight - 260))
		: 0;

	return (
		<>
			<div
				role="button"
				tabIndex={0}
				className={`session-row${active ? " active" : ""}${tab?.unread ? " unread" : ""}${draggable ? " draggable" : ""}${dragging ? " dragging" : ""}${dropBefore ? " drop-before" : ""}${dropAfter ? " drop-after" : ""}`}
				onClick={open}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						open();
					}
				}}
				onContextMenu={(event) => {
					event.preventDefault();
					if (!path) return;
					setMenu({ x: event.clientX, y: event.clientY });
				}}
				title={row.title}
				draggable={draggable}
				onDragStart={onDragStart}
				onDragOver={onDragOver}
				onDrop={onDrop}
				onDragEnd={onDragEnd}
			>
				{busy ? (
					<SpinnerIcon size={12} title="Working" />
				) : attention ? (
					<span className="status-dot attention" title="Waiting for you" />
				) : tab?.unread ? (
					<span className="status-dot unread" title="New reply" />
				) : null}
				<span className="title">{row.title}</span>
				<span className="meta">{relativeTime(row.modified)}</span>
			</div>
			{menu && path && (
				<div
					ref={menuRef}
					className="popover session-context-menu"
					role="menu"
					style={{ position: "fixed", top: menuTop, left: menuLeft }}
					onContextMenu={(event) => event.preventDefault()}
				>
					<button
						type="button"
						className="menu-item"
						onClick={() =>
							runMenuAction(() => {
								setValue(row.title);
								setRenaming(true);
							})
						}
					>
						Rename…
					</button>
					<button
						type="button"
						className="menu-item"
						onClick={() => runMenuAction(() => togglePin(path))}
					>
						{pinned ? "Unpin" : "Pin to Top"}
					</button>
					<div className="menu-separator" />
					<button
						type="button"
						className="menu-item"
						onClick={() =>
							runMenuAction(async () => {
								await openExistingSession(path, row.cwd);
								const opened = tabForSession(path);
								if (opened) await exportHtml(opened.tabId);
							})
						}
					>
						Export as HTML…
					</button>
					<button
						type="button"
						className="menu-item"
						onClick={() => runMenuAction(() => api.revealPath(path))}
					>
						Reveal Session File in Finder
					</button>
					<button
						type="button"
						className="menu-item"
						onClick={() => runMenuAction(() => api.copyText(path))}
					>
						Copy Session Path
					</button>
					<div className="menu-separator" />
					<button
						type="button"
						className="menu-item danger"
						onClick={() => runMenuAction(() => confirmDeleteSession(path, row.title))}
					>
						Delete
					</button>
				</div>
			)}
		</>
	);
});

function dropPlacementForEvent(
	event: DragEvent<HTMLDivElement>,
): SessionDropPlacement {
	const rect = event.currentTarget.getBoundingClientRect();
	return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function Group({
	cwd,
	rows,
	activeKey,
	pinned,
	repoKind,
	dragState,
	onStartDrag,
	onHoverRow,
	onHoverEnd,
	onDropRow,
	onDropEnd,
	onEndDrag,
}: {
	cwd: string;
	rows: Row[];
	activeKey: string | null;
	pinned: Set<string>;
	repoKind: RepoKind;
	dragState: DragState | null;
	onStartDrag(cwd: string, stableKey: string): void;
	onHoverRow(
		cwd: string,
		stableKey: string,
		placement: SessionDropPlacement,
	): void;
	onHoverEnd(cwd: string): void;
	onDropRow(
		cwd: string,
		rows: Row[],
		stableKey: string,
		placement: SessionDropPlacement,
	): Promise<void>;
	onDropEnd(cwd: string, rows: Row[]): Promise<void>;
	onEndDrag(): void;
}) {
	const home = useStore((s) => s.appInfo?.homeDir);
	const [collapsed, setCollapsed] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const visible = expanded ? [...rows] : rows.slice(0, GROUP_PREVIEW);
	const draggingInGroup = dragState?.cwd === cwd;
	const RepoIcon = repoKind === "supported" ? GitFork : Folder;
	// Always keep the active session visible even when the group is truncated.
	const activeRow = rows.find((r) => r.key === activeKey);
	if (activeRow && !visible.includes(activeRow)) visible.push(activeRow);
	return (
		<div className={`sidebar-section sidebar-section-${repoKind}`}>
			<div className="sidebar-section-row">
				<button
					type="button"
					className="sidebar-section-header"
					onClick={() => setCollapsed(!collapsed)}
					title={tildify(cwd, home)}
					aria-expanded={!collapsed}
				>
					<span className="sidebar-section-header-icon" aria-hidden="true">
						<RepoIcon size={12} className="sidebar-section-kind-icon" />
						<ChevronRight
							size={12}
							className={`sidebar-section-chevron${collapsed ? "" : " expanded"}`}
						/>
					</span>
					<span className="sidebar-section-header-label">
						{basename(cwd) || cwd}
					</span>
				</button>
				<button
					type="button"
					className="icon-btn"
					style={{ width: 22, height: 22 }}
					title={`New session in ${basename(cwd)}`}
					onClick={() => void startNewSession(cwd)}
				>
					<Plus size={13} />
				</button>
			</div>
			{!collapsed && (
				<>
					{visible.map((row) => {
						const dragOver =
							dragState?.cwd === cwd && dragState.overKey === row.stableKey;
						return (
							<SessionRow
								key={row.key}
								row={row}
								active={row.key === activeKey}
								pinned={pinned.has(row.key)}
								draggable
								dragging={dragState?.draggingKey === row.stableKey}
								dropBefore={dragOver && dragState?.placement === "before"}
								dropAfter={dragOver && dragState?.placement === "after"}
								onDragStart={(event) => {
									event.dataTransfer.effectAllowed = "move";
									event.dataTransfer.setData("text/plain", row.stableKey);
									if (rows.length > GROUP_PREVIEW) setExpanded(true);
									onStartDrag(cwd, row.stableKey);
								}}
								onDragOver={(event) => {
									event.preventDefault();
									if (dragState?.draggingKey === row.stableKey) return;
									event.dataTransfer.dropEffect = "move";
									onHoverRow(cwd, row.stableKey, dropPlacementForEvent(event));
								}}
								onDrop={async (event) => {
									event.preventDefault();
									await onDropRow(
										cwd,
										rows,
										row.stableKey,
										dropPlacementForEvent(event),
									);
								}}
								onDragEnd={onEndDrag}
							/>
						);
					})}
					{draggingInGroup && (
						<div
							className={`session-dropzone${dragState?.overKey === null && dragState.placement === "end" ? " active" : ""}`}
							onDragOver={(event) => {
								event.preventDefault();
								event.dataTransfer.dropEffect = "move";
								onHoverEnd(cwd);
							}}
							onDrop={async (event) => {
								event.preventDefault();
								await onDropEnd(cwd, rows);
							}}
						/>
					)}
					{rows.length > GROUP_PREVIEW && (
						<button
							type="button"
							className="session-more-btn"
							aria-expanded={expanded}
							onClick={() => setExpanded(!expanded)}
						>
							{expanded ? "Show less" : `Show ${rows.length - GROUP_PREVIEW} more`}
						</button>
					)}
				</>
			)}
		</div>
	);
}

export function Sidebar(_props?: { collapsed?: boolean }) {
	const settings = useStore((s) => s.settings);
	const sessions = useStore((s) => s.sessions);
	const tabs = useStore((s) => s.tabs);
	const activeTabId = useStore((s) => s.activeTabId);
	const homeActive = activeTabId === null;
	const [workspaceHealth, setWorkspaceHealth] = useState<WorkspaceHealth | null>(
		null,
	);
	const pinnedPaths = settings.pinnedSessions ?? [];
	const sidebarSessionOrder = settings.sidebarSessionOrder ?? {};
	const searchQuery = useStore((s) => s.searchQuery);
	const searchMatches = useStore((s) => s.searchMatches);
	const sessionsLoaded = useStore((s) => s.sessionsLoaded);
	const focusSearchTick = useStore((s) => s.focusSearchTick);
	const searchRef = useRef<HTMLInputElement>(null);
	const [dragState, setDragState] = useState<DragState | null>(null);

	useEffect(() => {
		if (focusSearchTick > 0) searchRef.current?.focus();
	}, [focusSearchTick]);

	useEffect(() => {
		let cancelled = false;
		void api
			.getWorkspaceHealth()
			.then((health) => {
				if (!cancelled) setWorkspaceHealth(health);
			})
			.catch(() => {
				if (!cancelled) setWorkspaceHealth(null);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const rows = useMemo(() => {
		const tabsByPath = new Map<string, TabState>();
		for (const tab of Object.values(tabs))
			if (tab.sessionPath) tabsByPath.set(tab.sessionPath, tab);
		const list: Row[] = sessions.map((summary) => {
			const tab = tabsByPath.get(summary.path);
			return {
				key: summary.path,
				stableKey: summary.path,
				title: sessionTitle(
					tab?.name ? { name: tab.name } : summary,
					"New session",
					tab ? firstUserMessage(tab.chat) : undefined,
					tab?.autoTitle,
				),
				cwd: summary.cwd,
				created: summary.created,
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
			const created = firstTimestamp(tab) ?? tab.openedAt;
			const modified = lastTimestamp(tab) ?? created;
			list.push({
				key: tab.tabId,
				stableKey: tab.tabId,
				title: sessionTitle(
					tab.name ? { name: tab.name } : undefined,
					"New session",
					firstUserMessage(tab.chat),
					tab.autoTitle,
				),
				cwd: tab.cwd,
				created,
				modified,
				tab,
			});
		}
		return list;
	}, [sessions, tabs, activeTabId]);

	const activeKey = useMemo(() => {
		const tab = activeTabId ? tabs[activeTabId] : undefined;
		if (!tab) return null;
		return tab.sessionPath && sessions.some((s) => s.path === tab.sessionPath)
			? tab.sessionPath
			: tab.tabId;
	}, [activeTabId, tabs, sessions]);

	const pinned = useMemo(() => new Set(pinnedPaths), [pinnedPaths]);
	const repoKinds = useMemo(() => {
		const kinds = new Map<string, RepoKind>();
		for (const repo of workspaceHealth?.repos ?? [])
			kinds.set(repo.path, "supported");
		for (const repo of workspaceHealth?.experiments ?? [])
			if (!kinds.has(repo.path)) kinds.set(repo.path, "experiment");
		return kinds;
	}, [workspaceHealth]);
	const query = searchQuery.trim().toLowerCase();

	const { pinnedRows, groups, results } = useMemo(() => {
		if (query) {
			const textMatches = new Set(searchMatches ?? []);
			return {
				pinnedRows: [],
				groups: [],
				results: rows
					.filter(
						(row) =>
							row.title.toLowerCase().includes(query) ||
							(row.summary && textMatches.has(row.summary.path)),
					)
					.sort(compareSessionOrder),
			};
		}
		const byCwd = new Map<string, Row[]>();
		const pinnedList: Row[] = [];
		for (const row of rows) {
			if (pinned.has(row.key)) pinnedList.push(row);
			else byCwd.set(row.cwd, [...(byCwd.get(row.cwd) ?? []), row]);
		}
		const orderedGroups = [...byCwd.entries()]
			.map(([cwd, list]) => {
				const defaultRows = [...list].sort(compareSessionOrder);
				return {
					cwd,
					sortKey: defaultRows[0] ?? {
						created: 0,
						modified: 0,
						stableKey: cwd,
					},
					rows: applyManualSessionOrder(defaultRows, sidebarSessionOrder[cwd]),
				};
			})
			.sort((a, b) => compareSessionOrder(a.sortKey, b.sortKey));
		return {
			pinnedRows: pinnedList.sort(compareSessionOrder),
			groups: orderedGroups.map(({ cwd, rows }) => [cwd, rows] as const),
			results: null,
		};
	}, [rows, query, searchMatches, pinned, sidebarSessionOrder]);

	function startDrag(cwd: string, draggingKey: string): void {
		setDragState({ cwd, draggingKey, overKey: null, placement: "end" });
	}

	function hoverRow(
		cwd: string,
		overKey: string,
		placement: SessionDropPlacement,
	): void {
		setDragState((current) => {
			if (!current || current.cwd !== cwd) return current;
			if (current.draggingKey === overKey)
				return { ...current, overKey: null, placement: "end" };
			if (current.overKey === overKey && current.placement === placement)
				return current;
			return { ...current, overKey, placement };
		});
	}

	function hoverEnd(cwd: string): void {
		setDragState((current) => {
			if (!current || current.cwd !== cwd) return current;
			if (current.overKey === null && current.placement === "end") return current;
			return { ...current, overKey: null, placement: "end" };
		});
	}

	async function persistGroupOrder(
		cwd: string,
		nextOrder: string[],
	): Promise<void> {
		const deduped = [...new Set(nextOrder)];
		const nextSettings = { ...sidebarSessionOrder, [cwd]: deduped };
		useStore.setState((state) => ({
			settings: { ...state.settings, sidebarSessionOrder: nextSettings },
		}));
		try {
			await api.updateSettings({ sidebarSessionOrder: nextSettings });
		} catch (error) {
			api.log("error", `save sidebar session order failed: ${String(error)}`);
		}
	}

	async function dropRow(
		cwd: string,
		groupRows: Row[],
		targetKey: string,
		placement: SessionDropPlacement,
	): Promise<void> {
		const current = dragState;
		setDragState(null);
		if (!current || current.cwd !== cwd) return;
		const currentOrder = groupRows.map((row) => row.stableKey);
		const nextOrder = moveSessionOrderItem(
			currentOrder,
			current.draggingKey,
			targetKey,
			placement,
		);
		if (nextOrder.every((key, index) => key === currentOrder[index])) return;
		await persistGroupOrder(cwd, nextOrder);
	}

	async function dropEnd(cwd: string, groupRows: Row[]): Promise<void> {
		const current = dragState;
		setDragState(null);
		if (!current || current.cwd !== cwd) return;
		const currentOrder = groupRows.map((row) => row.stableKey);
		const nextOrder = moveSessionOrderItem(
			currentOrder,
			current.draggingKey,
			null,
			"end",
		);
		if (nextOrder.every((key, index) => key === currentOrder[index])) return;
		await persistGroupOrder(cwd, nextOrder);
	}

	return (
		<nav className="sidebar">
			<div className="sidebar-top drag">
				<div className="sidebar-top-row">
					<button
						type="button"
						className="icon-btn"
						title="Hide sidebar (⌘\\)"
						onClick={() => {
							useStore.setState((state) => ({
								settings: { ...state.settings, sidebarCollapsed: true },
							}));
							void api.updateSettings({ sidebarCollapsed: true });
						}}
					>
						<PanelLeftClose size={16} />
					</button>
				</div>
				<button
					type="button"
					className={`sidebar-nav-btn${homeActive ? " active" : ""}`}
					aria-current={homeActive ? "page" : undefined}
					onClick={() => showHome()}
				>
					<House size={15} /> Home
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
						results.map((row) => (
							<SessionRow
								key={row.key}
								row={row}
								active={row.key === activeKey}
								pinned={pinned.has(row.key)}
							/>
						))
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
									<SessionRow
										key={row.key}
										row={row}
										active={row.key === activeKey}
										pinned
									/>
								))}
							</div>
						)}
						{groups.map(([cwd, list]) => (
							<Group
								key={cwd}
								cwd={cwd}
								rows={list}
								activeKey={activeKey}
								pinned={pinned}
								repoKind={repoKinds.get(cwd) ?? "experiment"}
								dragState={dragState}
								onStartDrag={startDrag}
								onHoverRow={hoverRow}
								onHoverEnd={hoverEnd}
								onDropRow={dropRow}
								onDropEnd={dropEnd}
								onEndDrag={() => setDragState(null)}
							/>
						))}
						{sessionsLoaded && rows.length === 0 && (
							<div className="sidebar-empty">
								Your pi sessions will show up here, grouped by project.
							</div>
						)}
					</>
				)}
			</div>
			<div className="sidebar-footer">
				<button
					type="button"
					className="icon-btn"
					title="Share feedback"
					onClick={() => useStore.setState({ feedbackOpen: true })}
				>
					<MessageCircle size={16} />
				</button>
				<button
					type="button"
					className="icon-btn"
					title="Settings (⌘,)"
					onClick={() => useStore.setState({ settingsPane: "general" })}
				>
					<Settings size={16} />
				</button>
				<span className="spacer" />
			</div>
		</nav>
	);
}
