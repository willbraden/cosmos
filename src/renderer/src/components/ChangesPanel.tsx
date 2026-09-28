import { ChevronRight, ExternalLink, FileDiff, X } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { collectFileChanges, type FileChange } from "../state/chat-model";
import { type TabState, useStore } from "../state/store";
import { DiffView, diffStats } from "./DiffView";

function absolute(cwd: string, path: string): string {
	return path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`;
}

function FileChanges({ path, changes, cwd }: { path: string; changes: FileChange[]; cwd: string }) {
	const [open, setOpen] = useState(true);
	const totals = changes.reduce(
		(acc, change) => {
			const stats = diffStats(change.patch, change.content);
			return { added: acc.added + stats.added, removed: acc.removed + stats.removed };
		},
		{ added: 0, removed: 0 },
	);
	return (
		<div className="change-file">
			<div className="change-file-header">
				<button type="button" className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? "Collapse file changes" : "Expand file changes"}>
					<ChevronRight size={13} className={`chev${open ? " open" : ""}`} style={{ transform: open ? "rotate(90deg)" : undefined }} />
				</button>
				<span className="path" title={path}>
					{path}
				</span>
				<span className="stat-add">+{totals.added}</span>
				<span className="stat-del">−{totals.removed}</span>
				<button type="button" className="icon-btn" style={{ width: 24, height: 24 }} title="Open in editor" onClick={() => void api.openInEditor(absolute(cwd, path))}>
					<ExternalLink size={13} />
				</button>
			</div>
			{open &&
				changes.map((change) => (
					<div key={change.toolCallId} style={{ borderTop: "1px solid var(--border)" }}>
						{change.status === "error" ? (
							<div className="tool-pre error">This change failed and was not applied.</div>
						) : change.status === "pending" || change.status === "running" ? (
							<div className="tool-pre muted">Pending…</div>
						) : (
							<DiffView patch={change.patch} content={change.patch ? undefined : change.content} />
						)}
					</div>
				))}
		</div>
	);
}

export function ChangesPanel({ tab }: { tab: TabState }) {
	const byFile = useMemo(() => {
		const map = new Map<string, FileChange[]>();
		for (const change of collectFileChanges(tab.chat)) map.set(change.path, [...(map.get(change.path) ?? []), change]);
		return [...map.entries()];
	}, [tab.chat]);

	return (
		<aside className="changes">
			<div className="changes-header drag">
				<FileDiff size={15} />
				Changes
				<span className="muted" style={{ fontWeight: 400 }}>
					{byFile.length} file{byFile.length === 1 ? "" : "s"}
				</span>
				<span className="spacer" />
				<button type="button" className="icon-btn" title="Close" onClick={() => useStore.setState({ changesOpen: false })}>
					<X size={15} />
				</button>
			</div>
			<div className="changes-body">
				{byFile.length === 0 ? (
					<div className="sidebar-empty">Files pi edits or writes in this session will appear here.</div>
				) : (
					byFile.map(([path, changes]) => <FileChanges key={path} path={path} changes={changes} cwd={tab.cwd} />)
				)}
			</div>
		</aside>
	);
}
