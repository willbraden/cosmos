import type { WorkspaceHealth, WorkspaceRepoHealth } from "@shared/ipc";
import { FlaskConical, FolderOpen, RefreshCw, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, basename, errorMessage, tildify } from "../lib/api";
import { startNewSession } from "../state/actions";
import { useStore } from "../state/store";

function RepoCard({
	repo,
	home,
	kind,
}: {
	repo: WorkspaceRepoHealth;
	home: string | undefined;
	kind: "core" | "experiment";
}) {
	const ready = repo.exists && repo.isGitRepo;
	const kindLabel = kind === "core" ? "Core repo" : "Experiment";
	const state = ready ? "ready" : repo.exists ? "needs-git" : "missing";
	const stateLabel = ready ? "Ready" : repo.exists ? "Needs git" : "Missing";
	return (
		<div className="repo-card">
			<div className="repo-card-header">
				<div className="repo-card-copy">
					<div className="repo-card-title-row">
						<div className="repo-card-title">{repo.name}</div>
						<span className={`repo-card-kind repo-card-kind-${kind}`}>
							{kindLabel}
						</span>
					</div>
					<div className="repo-card-path muted">{tildify(repo.path, home)}</div>
				</div>
				<span className={`repo-card-status repo-card-status-${state}`}>
					{stateLabel}
				</span>
			</div>
			<div className="repo-card-actions">
				<button
					type="button"
					className="btn small"
					disabled={!ready}
					onClick={() => void startNewSession(repo.path)}
				>
					Open {kind === "core" ? "repo" : "project"}
				</button>
				<button
					type="button"
					className="btn small"
					onClick={() => void api.revealPath(repo.path)}
				>
					Show in Finder
				</button>
			</div>
		</div>
	);
}

function ExperimentPickerModal({
	home,
	workspaceRoot,
	experiments,
	recent,
	onClose,
}: {
	home: string | undefined;
	workspaceRoot: string | undefined;
	experiments: WorkspaceRepoHealth[];
	recent: string[];
	onClose(): void;
}) {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	async function createExperiment(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const createExperimentApi = (
				api as typeof api & {
					createExperiment?: (name: string) => Promise<string>;
				}
			).createExperiment;
			if (typeof createExperimentApi !== "function") {
				throw new Error(
					"Experiment creation was just added. Please fully restart Cosmos and try again.",
				);
			}
			const path = await createExperimentApi(name);
			onClose();
			await startNewSession(path);
		} catch (error) {
			setError(errorMessage(error));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div
			className="modal-backdrop"
			onMouseDown={(event) => event.target === event.currentTarget && onClose()}
		>
			<div
				className="modal experiments-modal"
				role="dialog"
				aria-label="Open experiment"
			>
				<div className="experiments-modal-body">
					<div className="experiments-modal-header">
						<div className="experiments-modal-header-copy">
							<div className="experiments-modal-eyebrow">Workspace experiments</div>
							<h2>Experiments</h2>
							<p className="muted">
								Choose or create a project inside{" "}
								{workspaceRoot ? tildify(workspaceRoot, home) : "the workspace root"}.
								Experiments stay inside the Cosmos workspace so they keep the same
								shared Glayvin context.
							</p>
						</div>
						<div className="experiments-modal-header-actions">
							<div className="experiments-modal-stat">
								<strong>{experiments.length}</strong>
								<span>available</span>
							</div>
							<button type="button" className="btn small" onClick={onClose}>
								Close
							</button>
						</div>
					</div>
					<div className="experiments-modal-grid">
						<form
							className="experiments-create-card"
							onSubmit={(event) => void createExperiment(event)}
						>
							<div className="experiments-section-title">New experiment</div>
							<div className="muted experiments-section-copy">
								Create a new sibling folder under the workspace root and open it
								immediately.
							</div>
							<div className="experiments-input-row">
								<input
									autoFocus
									value={name}
									placeholder="cosmos-gui-prototype"
									onChange={(event) => setName(event.target.value)}
								/>
								<button
									type="submit"
									className="btn primary"
									disabled={busy || !name.trim()}
								>
									{busy ? "Creating…" : "Create"}
								</button>
							</div>
							<div className="muted experiments-input-hint">
								Example names: ui-playground, cosmos-gui-prototype, figma-builder-test
							</div>
							{error && <div className="experiments-error">{error}</div>}
						</form>
						<div className="experiments-list-card">
							<div className="experiments-section-title">Workspace experiments</div>
							<div className="muted experiments-section-copy">
								Open any sibling project already living under the workspace root.
							</div>
							<div className="experiments-list-scroll">
								{experiments.length > 0 ? (
									experiments.map((repo) => {
										const ready = repo.exists && repo.isGitRepo;
										return (
											<div key={repo.path} className="experiments-project-card">
												<div className="experiments-project-header">
													<div>
														<strong>{repo.name}</strong>
													</div>
													<span className="muted">
														{ready ? "Ready" : repo.exists ? "Needs git" : "Missing"}
													</span>
												</div>
												<div className="muted experiments-project-path">
													{tildify(repo.path, home)}
												</div>
												<div className="experiments-project-actions">
													<button
														type="button"
														className="btn small primary"
														disabled={!ready}
														onClick={() => {
															onClose();
															void startNewSession(repo.path);
														}}
													>
														Open project
													</button>
													<button
														type="button"
														className="btn small"
														onClick={() => void api.revealPath(repo.path)}
													>
														Show in Finder
													</button>
												</div>
											</div>
										);
									})
								) : (
									<div className="muted experiments-empty-state">
										No experiment folders are available yet. Create one above or clone a
										project into the workspace root.
									</div>
								)}
							</div>
						</div>
					</div>
					{recent.length > 0 && (
						<div
							className="project-list experiments-recent-list"
							style={{ width: "100%" }}
						>
							<div className="experiments-section-title">
								Recent workspace projects
							</div>
							{recent.map((path) => (
								<button
									key={path}
									type="button"
									onClick={() => {
										onClose();
										void startNewSession(path);
									}}
								>
									<span>{basename(path)}</span>
									<span className="path">{tildify(path, home)}</span>
								</button>
							))}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

/** Shown when no session is open: Cosmos workspace dashboard + quick start. */
export function NewSessionView() {
	const recent = useStore((s) => s.settings.recentProjects);
	const home = useStore((s) => s.appInfo?.homeDir);
	const workspaceRoot = useStore((s) => s.appInfo?.workspaceRoot);
	const collapsed = useStore((s) => s.settings.sidebarCollapsed);
	const [health, setHealth] = useState<WorkspaceHealth | null>(null);
	const [loading, setLoading] = useState(false);
	const [experimentPickerOpen, setExperimentPickerOpen] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		void api
			.getWorkspaceHealth()
			.then((next) => {
				if (!cancelled) setHealth(next);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [workspaceRoot]);

	const primaryRepo = health?.repos.find((repo) => repo.name === "cosmos-ai");
	const readyRepos =
		health?.repos.filter((repo) => repo.exists && repo.isGitRepo) ?? [];
	const experimentProjects = health?.experiments ?? [];
	const knownPaths = new Set([
		...(health?.repos.map((repo) => repo.path) ?? []),
		...experimentProjects.map((repo) => repo.path),
	]);
	const visibleRecent = recent
		.filter((path) =>
			workspaceRoot
				? path === workspaceRoot || path.startsWith(`${workspaceRoot}/`)
				: true,
		)
		.filter((path) => !knownPaths.has(path))
		.slice(0, 6);
	const canOpenPrimary = Boolean(primaryRepo?.exists && primaryRepo.isGitRepo);

	return (
		<div className="main">
			<div
				className="main-header drag"
				style={{ paddingLeft: collapsed ? 84 : 16 }}
			/>
			<div className="empty empty-cosmos">
				<h1 className="cosmos-wordmark" aria-label="cosmos">
					<span>cosm</span>
					<span className="cosmos-wordmark-strong">os</span>
				</h1>
				<p style={{ margin: 0, maxWidth: 620 }}>
					Open a core Cosmos repo or one of your workspace experiments below.
					Experiments like cosmos-gui still run with the same shared Pi and Glayvin
					context; they are just classified separately from the main company repos.
				</p>
				<div className="workspace-dashboard-toolbar">
					<button
						type="button"
						className="btn primary"
						disabled={!canOpenPrimary}
						onClick={() => primaryRepo && void startNewSession(primaryRepo.path)}
					>
						Open cosmos-ai
					</button>
					<button
						type="button"
						className="btn"
						onClick={() => setExperimentPickerOpen(true)}
					>
						<FolderOpen size={14} /> Open experiment…
					</button>
					<button
						type="button"
						className="btn"
						onClick={() => useStore.setState({ settingsPane: "general" })}
					>
						<Settings2 size={14} /> Settings
					</button>
					<button
						type="button"
						className="btn"
						onClick={() => {
							setLoading(true);
							void api
								.getWorkspaceHealth()
								.then((next) => setHealth(next))
								.finally(() => setLoading(false));
						}}
					>
						<RefreshCw size={14} /> Refresh
					</button>
				</div>
				<div className="workspace-summary-card">
					<div className="workspace-summary-header">
						<strong>Workspace root</strong>
						<span className="muted">
							{loading
								? "Checking…"
								: `${readyRepos.length}/3 core repos ready · ${experimentProjects.length} experiments`}
						</span>
					</div>
					<div className="workspace-summary-path muted">
						{health
							? tildify(health.rootPath, home)
							: workspaceRoot
								? tildify(workspaceRoot, home)
								: "Loading…"}
					</div>
					{health && !health.rootExists && (
						<div className="muted" style={{ textAlign: "left" }}>
							This folder does not exist yet. Set a different workspace root in
							Settings or create it before cloning repos.
						</div>
					)}
					{health && health.rootExists && readyRepos.length === 0 && (
						<div className="muted" style={{ textAlign: "left" }}>
							No ready repositories were found yet. Clone your company repos into this
							workspace root, then press Refresh.
						</div>
					)}
				</div>
				{health && (
					<>
						<div className="workspace-section">
							<div className="workspace-section-label">Company repos</div>
							<div className="repo-card-grid">
								{health.repos.map((repo) => (
									<RepoCard key={repo.name} repo={repo} home={home} kind="core" />
								))}
							</div>
						</div>
						<div className="workspace-section">
							<div className="workspace-section-label workspace-section-label-icon">
								<FlaskConical size={14} /> Experiments
							</div>
							<div className="workspace-section-copy muted">
								Sibling folders under the workspace root are treated as experiments and
								still inherit the same shared Cosmos + Glayvin runtime context.
							</div>
							{experimentProjects.length > 0 ? (
								<div className="repo-card-grid">
									{experimentProjects.map((repo) => (
										<RepoCard key={repo.name} repo={repo} home={home} kind="experiment" />
									))}
								</div>
							) : (
								<div className="muted" style={{ textAlign: "left" }}>
									No experiment folders detected yet. Create or clone a sibling project
									in this workspace root, or use Open experiment… to jump into one.
								</div>
							)}
						</div>
					</>
				)}
				{visibleRecent.length > 0 && (
					<div className="project-list workspace-recent-list" style={{ width: "100%" }}>
						<div className="workspace-section-label">Recent workspace projects</div>
						{visibleRecent.map((path) => (
							<button
								key={path}
								type="button"
								onClick={() => void startNewSession(path)}
							>
								<span>{basename(path)}</span>
								<span className="path">{tildify(path, home)}</span>
							</button>
						))}
					</div>
				)}
				{experimentPickerOpen && (
					<ExperimentPickerModal
						home={home}
						workspaceRoot={workspaceRoot}
						experiments={experimentProjects}
						recent={visibleRecent}
						onClose={() => setExperimentPickerOpen(false)}
					/>
				)}
			</div>
		</div>
	);
}
