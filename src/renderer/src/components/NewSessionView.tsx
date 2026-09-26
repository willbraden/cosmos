import { FolderOpen } from "lucide-react";
import { basename, tildify } from "../lib/api";
import { chooseFolderAndStart, startNewSession } from "../state/actions";
import { useStore } from "../state/store";
import { CosmosMark } from "./CosmosMark";

/** Shown when no session is open: pick a project folder to start in. */
export function NewSessionView() {
	const recent = useStore((s) => s.settings.recentProjects);
	const home = useStore((s) => s.appInfo?.homeDir);
	const collapsed = useStore((s) => s.settings.sidebarCollapsed);
	return (
		<div className="main">
			<div className="main-header drag" style={{ paddingLeft: collapsed ? 84 : 16 }} />
			<div className="empty">
				<div className="app-logo">
				<CosmosMark size={38} />
			</div>
				<h1>Start a session</h1>
				<p style={{ margin: 0, maxWidth: 440 }}>Pick the project folder pi should work in. It can read, edit, and run commands there.</p>
				<button type="button" className="btn primary" onClick={() => void chooseFolderAndStart()}>
					<FolderOpen size={14} /> Choose folder…
				</button>
				{recent.length > 0 && (
					<div className="project-list">
						<div className="popover-label" style={{ textAlign: "left" }}>
							Recent projects
						</div>
						{recent.slice(0, 6).map((path) => (
							<button key={path} type="button" onClick={() => void startNewSession(path)}>
								<span>{basename(path)}</span>
								<span className="path">{tildify(path, home)}</span>
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
