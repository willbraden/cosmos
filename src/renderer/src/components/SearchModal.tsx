import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { basename, relativeTime } from "../lib/api";
import { firstUserMessage } from "../state/chat-model";
import { openExistingSession, runSearch } from "../state/actions";
import { sessionTitle, useStore } from "../state/store";

interface Hit {
	key: string;
	title: string;
	cwd: string;
	modified: number;
	open: () => void;
}

export function SearchModal() {
	const sessions = useStore((s) => s.sessions);
	const tabs = useStore((s) => s.tabs);
	const searchQuery = useStore((s) => s.searchQuery);
	const searchMatches = useStore((s) => s.searchMatches);
	const [cursor, setCursor] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);

	const close = useCallback(() => {
		useStore.setState({ searchOpen: false });
		void runSearch("");
	}, []);

	const hits = useMemo<Hit[]>(() => {
		const tabsByPath = new Map(
			Object.values(tabs)
				.filter((tab) => tab.sessionPath)
				.map((tab) => [tab.sessionPath as string, tab]),
		);
		const textMatches = new Set(searchMatches ?? []);
		const query = searchQuery.trim().toLowerCase();
		return sessions
			.map((summary) => {
				const tab = tabsByPath.get(summary.path);
				return {
					key: summary.path,
					title: sessionTitle(
						tab?.name ? { name: tab.name } : summary,
						"New session",
						tab ? firstUserMessage(tab.chat) : undefined,
						tab?.autoTitle,
					),
					cwd: summary.cwd,
					modified: summary.modified,
					open: () => void openExistingSession(summary.path, summary.cwd),
				};
			})
			.filter(
				(hit) =>
					hit.title.toLowerCase().includes(query) || textMatches.has(hit.key),
			)
			.sort((a, b) => b.modified - a.modified);
	}, [sessions, tabs, searchQuery, searchMatches]);

	// Keep the highlight inside the result list as it shrinks while typing.
	useEffect(() => {
		setCursor((current) => Math.min(current, Math.max(0, hits.length - 1)));
	}, [hits.length]);

	useEffect(() => {
		listRef.current
			?.querySelector('[data-active="true"]')
			?.scrollIntoView({ block: "nearest" });
	}, [cursor]);

	const choose = useCallback(
		(hit: Hit | undefined) => {
			if (!hit) return;
			hit.open();
			close();
		},
		[close],
	);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close();
			} else if (event.key === "ArrowDown") {
				event.preventDefault();
				setCursor((c) => (hits.length ? (c + 1) % hits.length : 0));
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				setCursor((c) => (hits.length ? (c - 1 + hits.length) % hits.length : 0));
			} else if (event.key === "Enter") {
				event.preventDefault();
				choose(hits[cursor]);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [hits, cursor, choose, close]);

	return (
		<div
			className="modal-backdrop search-modal-backdrop"
			onMouseDown={(event) => event.target === event.currentTarget && close()}
		>
			<div
				className="modal search-modal"
				role="dialog"
				aria-label="Search sessions"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<div className="search-modal-input">
					<Search size={16} />
					<input
						// biome-ignore lint/a11y/noAutofocus: the modal exists to take typing
						autoFocus
						placeholder="Search sessions"
						value={searchQuery}
						onChange={(e) => void runSearch(e.target.value)}
					/>
					<span className="kbd">esc</span>
				</div>
				<div className="search-modal-results" ref={listRef}>
					{hits.length === 0 ? (
						<div className="sidebar-empty">
							{searchQuery.trim()
								? `No sessions match "${searchQuery}"`
								: "Start typing to search your sessions."}
						</div>
					) : (
						hits.map((hit, index) => (
							<button
								type="button"
								key={hit.key}
								className={`search-hit${index === cursor ? " active" : ""}`}
								data-active={index === cursor}
								onMouseMove={() => setCursor(index)}
								onClick={() => choose(hit)}
							>
								<span className="title">{hit.title}</span>
								<span className="meta">{basename(hit.cwd)}</span>
								<span className="meta">{relativeTime(hit.modified)}</span>
							</button>
						))
					)}
				</div>
			</div>
		</div>
	);
}
