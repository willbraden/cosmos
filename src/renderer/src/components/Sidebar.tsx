import type { SessionSummary } from "@shared/ipc";
import {
	applyManualSessionOrder,
	compareSessionOrder,
	moveSessionOrderItem,
	type SessionDropPlacement,
} from "@shared/session-order";
import {
	ChevronRight,
	FolderPlus,
	PanelLeftClose,
	Pin,
	Plus,
	Search,
	Settings,
	SquarePen,
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
import { firstUserMessage } from "../state/chat-model";
import {
	activateTab,
	deleteSession,
	exportHtml,
	openExistingSession,
	renameSessionByPath,
	runSearch,
	showWorkspaceDashboard,
	startNewSession,
	tabForSession,
	togglePin,
} from "../state/actions";
import {
	activeTab,
	sessionTitle,
	type TabState,
	useStore,
} from "../state/store";

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
				if (window.confirm(`Move "${row.title}" to the Trash?`))
					await deleteSession(path);
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

	return (
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
			onContextMenu={onContextMenu}
			title={row.title}
			draggable={draggable}
			onDragStart={onDragStart}
			onDragOver={onDragOver}
			onDrop={onDrop}
			onDragEnd={onDragEnd}
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
		</div>
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
	// Always keep the active session visible even when the group is truncated.
	const activeRow = rows.find((r) => r.key === activeKey);
	if (activeRow && !visible.includes(activeRow)) visible.push(activeRow);
	return (
		<div className="sidebar-section">
			<div style={{ display: "flex", alignItems: "center" }}>
				<button
					type="button"
					className="sidebar-section-header"
					onClick={() => setCollapsed(!collapsed)}
					title={tildify(cwd, home)}
				>
					<ChevronRight
						size={12}
						style={{
							transform: collapsed ? undefined : "rotate(90deg)",
							transition: "transform .15s",
						}}
					/>
					{basename(cwd) || cwd}
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
							className="session-row"
							style={{ color: "var(--text-3)", fontSize: 12 }}
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

export function Sidebar() {
	const settings = useStore((s) => s.settings);
	const sessions = useStore((s) => s.sessions);
	const tabs = useStore((s) => s.tabs);
	const activeTabId = useStore((s) => s.activeTabId);
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
			api.log(
				"error",
				`save sidebar session order failed: ${String(error)}`,
			);
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
						onClick={() => void api.updateSettings({ sidebarCollapsed: true })}
					>
						<PanelLeftClose size={16} />
					</button>
				</div>
				<button
					type="button"
					className="new-session-btn"
					onClick={() => void startNewSession(activeTab()?.cwd)}
				>
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
					title="Settings (⌘,)"
					onClick={() => useStore.setState({ settingsPane: "general" })}
				>
					<Settings size={16} />
				</button>
				<span className="spacer" />
				<button
					type="button"
					className="btn small"
					onClick={() => showWorkspaceDashboard()}
				>
					<FolderPlus size={13} /> Workspace repos
				</button>
			</div>
		</nav>
	);
}
