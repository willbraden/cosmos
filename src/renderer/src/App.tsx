import type { MenuCommand } from "@shared/ipc";
import { compareSessionSummaries } from "@shared/session-order";
import { PanelLeftOpen } from "lucide-react";
import { useEffect } from "react";
import { ChangesPanel } from "./components/ChangesPanel";
import { ChatView } from "./components/ChatView";
import { DeveloperInspector } from "./components/DeveloperInspector";
import { HomeView } from "./components/HomeView";
import { IconButtonTooltips } from "./components/IconButtonTooltips";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { api } from "./lib/api";
import {
	activateTab,
	compact,
	expireDialogs,
	exportHtml,
	openExistingSession,
	showHome,
	startNewSession,
	stop,
} from "./state/actions";
import { activeTab, toast, useStore } from "./state/store";

/** Sidebar order for ⌘⇧[ / ⌘⇧]: keep stable creation order instead of recency. */
function cycleSession(direction: 1 | -1): void {
	const { sessions } = useStore.getState();
	if (sessions.length === 0) return;
	const ordered = [...sessions].sort(compareSessionSummaries);
	const current = activeTab()?.sessionPath;
	const index = ordered.findIndex((s) => s.path === current);
	const next = ordered[(index + direction + ordered.length) % ordered.length];
	if (next) void openExistingSession(next.path, next.cwd);
}

function handleMenu(command: MenuCommand): void {
	const tab = activeTab();
	switch (command) {
		case "new-session":
			return void startNewSession(tab?.cwd);
		case "open-folder":
			return showHome();
		case "settings":
			return useStore.setState({ settingsPane: "general" });
		case "search": {
			const { settings } = useStore.getState();
			if (settings.sidebarCollapsed)
				void api.updateSettings({ sidebarCollapsed: false });
			return useStore.setState((s) => ({
				focusSearchTick: s.focusSearchTick + 1,
			}));
		}
		case "toggle-sidebar":
			return void api.updateSettings({
				sidebarCollapsed: !useStore.getState().settings.sidebarCollapsed,
			});
		case "toggle-changes":
			return useStore.setState((s) => ({ changesOpen: !s.changesOpen }));
		case "focus-composer":
			return useStore.setState((s) => ({
				focusComposerTick: s.focusComposerTick + 1,
			}));
		case "stop":
			if (tab) void stop(tab.tabId);
			return;
		case "compact":
			if (tab && !tab.isStreaming) void compact(tab.tabId);
			return;
		case "export-html":
			if (tab) void exportHtml(tab.tabId);
			return;
		case "next-session":
			return cycleSession(1);
		case "prev-session":
			return cycleSession(-1);
		case "reset-figma":
			return void api
				.resetFigmaAuth()
				.then((result) => {
					useStore.setState({ settingsPane: "mcps" });
					toast(result.removed ? "info" : "warning", result.message);
				})
				.catch((error) => toast("error", error instanceof Error ? error.message : String(error)));
	}
}

export function App() {
	const tab = useStore((s) =>
		s.activeTabId ? s.tabs[s.activeTabId] : undefined,
	);
	const collapsed = useStore((s) => s.settings.sidebarCollapsed);
	const settingsPane = useStore((s) => s.settingsPane);
	const changesOpen = useStore((s) => s.changesOpen);

	useEffect(() => api.onMenuCommand(handleMenu), []);

	useEffect(() => {
		const timer = setInterval(expireDialogs, 1000);
		return () => clearInterval(timer);
	}, []);

	// Keep the main process informed so it never suspends the session being viewed.
	useEffect(() => {
		if (tab) activateTab(tab.tabId);
	}, [tab?.tabId]);

	return (
		<div className={`app${collapsed ? " sidebar-collapsed" : ""}`}>
			{!collapsed && <Sidebar />}
			{collapsed && (
				<button
					type="button"
					className="icon-btn no-drag"
					style={{ position: "fixed", top: 9, left: 84, zIndex: 10 }}
					title="Show sidebar (⌘\)"
					onClick={() => void api.updateSettings({ sidebarCollapsed: false })}
				>
					<PanelLeftOpen size={16} />
				</button>
			)}
			{tab ? <ChatView tab={tab} /> : <HomeView />}
			{tab && changesOpen && <ChangesPanel tab={tab} />}
			{settingsPane && <SettingsModal pane={settingsPane} />}
			<DeveloperInspector />
			<Toasts />
			<IconButtonTooltips />
		</div>
	);
}
