import type { ModelRef, WorkspaceHealth, WorkspaceRepoHealth } from "@shared/ipc";
import type { Model } from "@shared/pi-types";
import {
	ArrowUp,
	Check,
	Cpu,
	Download,
	FlaskConical,
	FolderGit2,
	FolderPlus,
	Link2,
	Link2Off,
	Plus,
	RefreshCw,
	TestTubeDiagonal,
	Wrench,
} from "lucide-react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { api, basename, errorMessage, tildify } from "../lib/api";
import { startNewSession, startSessionWithPrompt } from "../state/actions";
import { toast, useStore } from "../state/store";
import { CosmosMark } from "./CosmosMark";
import { Dropdown, PERMISSION_MODES } from "./Pickers";
import { SpinnerIcon } from "./SpinnerIcon";

const SUGGESTIONS = [
	{
		prompt: "Give me a tour of this project: the key modules and how they fit together.",
		label: "Orientation",
		icon: FolderGit2,
	},
	{
		prompt: "Look through the recent changes and fix the riskiest bug you find.",
		label: "Debugging",
		icon: Wrench,
	},
	{
		prompt: "Add tests for the code paths that don't have coverage yet.",
		label: "Testing",
		icon: TestTubeDiagonal,
	},
];

interface RepoOption {
	path: string;
	name: string;
	group: "Company repos" | "Experiments" | "Recent";
	ready: boolean;
}

function HomePermissionPicker() {
	const mode = useStore((s) => s.settings.permissionMode);
	const current = PERMISSION_MODES.find((m) => m.mode === mode) ?? PERMISSION_MODES[0];
	const Icon = current.icon;
	return (
		<Dropdown
			title="Permission mode for new sessions"
			width={300}
			trigger={
				<>
					<Icon size={13} />
					<span>{current.label}</span>
				</>
			}
		>
			{(close) => (
				<>
					<div className="popover-label">Permissions</div>
					{PERMISSION_MODES.map(({ mode: value, label, help, icon: ModeIcon }) => (
						<button
							key={value}
							type="button"
							className="menu-item"
							onClick={() => {
								close();
								void api.updateSettings({ permissionMode: value });
							}}
						>
							<ModeIcon size={14} style={{ flexShrink: 0 }} />
							<span className="menu-item-stack">
								<span className="name">{label}</span>
								<span className="desc" style={{ whiteSpace: "normal" }}>
									{help}
								</span>
							</span>
							{value === mode && <Check size={14} className="check" />}
						</button>
					))}
				</>
			)}
		</Dropdown>
	);
}

function HomeModelPicker() {
	const models = useStore((s) => s.models);
	const selected = useStore((s) => s.settings.defaultModel);
	const [filter, setFilter] = useState("");
	const current = selected
		? models.find((m) => m.provider === selected.provider && m.id === selected.id)
		: undefined;
	const groups = useMemo(() => {
		const q = filter.toLowerCase();
		const map = new Map<string, Model[]>();
		for (const model of models) {
			if (q && !`${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(q))
				continue;
			map.set(model.provider, [...(map.get(model.provider) ?? []), model]);
		}
		return [...map.entries()];
	}, [models, filter]);

	const choose = (ref: ModelRef | null) => void api.updateSettings({ defaultModel: ref });

	return (
		<Dropdown
			title="Model for new sessions"
			align="right"
			width={320}
			trigger={
				<>
					<Cpu size={13} />
					<span>{current?.name ?? (selected ? selected.id : "Default model")}</span>
				</>
			}
		>
			{(close) =>
				models.length === 0 ? (
					<div className="menu-item" style={{ flexDirection: "column", alignItems: "flex-start" }}>
						<span>No models available.</span>
						<button
							type="button"
							className="btn small primary"
							style={{ marginTop: 6 }}
							onClick={() => {
								close();
								useStore.setState({ settingsPane: "providers" });
							}}
						>
							Connect a provider
						</button>
					</div>
				) : (
					<>
						{/* biome-ignore lint/a11y/noAutofocus: filter is the purpose of opening the menu */}
						<input
							className="filter"
							autoFocus
							placeholder="Search models…"
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
						/>
						<button
							type="button"
							className="menu-item"
							onClick={() => {
								close();
								choose(null);
							}}
						>
							<span className="menu-item-stack">
								<span className="name">Default model</span>
								<span className="desc">Whatever pi is configured to use</span>
							</span>
							{!selected && <Check size={14} className="check" />}
						</button>
						{groups.map(([provider, list]) => (
							<div key={provider}>
								<div className="popover-label">{provider}</div>
								{list.map((model) => {
									const active =
										selected?.provider === model.provider && selected.id === model.id;
									return (
										<button
											key={`${model.provider}/${model.id}`}
											type="button"
											className="menu-item"
											onClick={() => {
												close();
												choose({ provider: model.provider, id: model.id });
											}}
										>
											<span className="menu-item-stack">
												<span className="name">{model.name}</span>
												<span className="desc">
													{model.id}
													{model.contextWindow
														? ` · ${Math.round(model.contextWindow / 1000)}k context`
														: ""}
												</span>
											</span>
											{active && <Check size={14} className="check" />}
										</button>
									);
								})}
							</div>
						))}
					</>
				)
			}
		</Dropdown>
	);
}

function RepoPicker({
	options,
	value,
	home,
	onChange,
}: {
	options: RepoOption[];
	value: string | null;
	home: string | undefined;
	onChange(path: string): void;
}) {
	const groups = useMemo(() => {
		const map = new Map<RepoOption["group"], RepoOption[]>();
		for (const option of options)
			map.set(option.group, [...(map.get(option.group) ?? []), option]);
		return [...map.entries()];
	}, [options]);

	return (
		<Dropdown
			title="Project for this session"
			direction="down"
			width={320}
			trigger={
				<>
					<FolderGit2 size={13} />
					<span>{value ? basename(value) : "Choose a project"}</span>
				</>
			}
		>
			{(close) => (
				<>
					{groups.map(([group, list]) => (
						<div key={group}>
							<div className="popover-label">{group}</div>
							{list.map((option) => (
								<button
									key={option.path}
									type="button"
									className="menu-item"
									disabled={!option.ready}
									onClick={() => {
										close();
										onChange(option.path);
									}}
								>
									<span className="menu-item-stack">
										<span className="name">{option.name}</span>
										<span className="desc">{tildify(option.path, home)}</span>
									</span>
									{option.path === value && <Check size={14} className="check" />}
								</button>
							))}
						</div>
					))}
					{options.length === 0 && (
						<div className="menu-item">No projects found in the workspace yet.</div>
					)}
				</>
			)}
		</Dropdown>
	);
}

function RepoTile({
	repo,
	home,
	kind,
	busy,
	cloning,
	progress,
	onClone,
	onLink,
	onUnlink,
}: {
	repo: WorkspaceRepoHealth;
	home: string | undefined;
	kind: "core" | "experiment";
	busy: boolean;
	cloning: boolean;
	progress: string;
	onClone: () => void;
	onLink: () => void;
	onUnlink: () => void;
}) {
	const ready = repo.exists && repo.isGitRepo;
	const state = ready ? "ready" : repo.exists ? "needs-git" : "missing";
	const stateLabel = ready ? "Ready" : repo.exists ? "Needs git" : "Missing";
	return (
		<div className="repo-card">
			<div className="repo-card-header">
				<div className="repo-card-copy">
					<div className="repo-card-title-row">
						<div className="repo-card-title">{repo.name}</div>
						<span
							className={`repo-card-kind repo-card-kind-${repo.team ? "team" : kind}`}
							title={
								repo.team
									? `Registered as the "${repo.team}" Glayvin team layer`
									: undefined
							}
						>
							{repo.team ?? (kind === "core" ? "Core repo" : "Experiment")}
						</span>
						{repo.isSymlink && (
							<span className="repo-card-kind repo-card-kind-linked">
								<Link2 size={11} /> Linked
							</span>
						)}
					</div>
					<div className="repo-card-path muted">
						{repo.isSymlink && repo.linkTarget
							? `${tildify(repo.path, home)} → ${tildify(repo.linkTarget, home)}`
							: tildify(repo.path, home)}
					</div>
				</div>
				<span className={`repo-card-status repo-card-status-${state}`}>{stateLabel}</span>
			</div>
			{cloning && (
				<div className="repo-card-progress muted" title={progress}>
					{progress || "Starting clone…"}
				</div>
			)}
			<div className="repo-card-actions">
				<button
					type="button"
					className="btn small"
					disabled={!ready || busy}
					onClick={() => void startNewSession(repo.path)}
				>
					Open
				</button>
				{!ready && repo.cloneUrl && !repo.isSymlink && (
					<button
						type="button"
						className="btn small primary"
						disabled={busy}
						title={`git clone ${repo.cloneUrl}`}
						onClick={onClone}
					>
						{cloning ? <SpinnerIcon size={12} /> : <Download size={13} />}
						{cloning ? "Cloning…" : "Clone"}
					</button>
				)}
				{!ready && !repo.isSymlink && (
					<button
						type="button"
						className="btn small"
						disabled={busy}
						title="Symlink an existing checkout into the workspace root"
						onClick={onLink}
					>
						<Link2 size={13} /> Link existing…
					</button>
				)}
				{repo.isSymlink && (
					<button
						type="button"
						className="btn small"
						disabled={busy}
						title="Remove the symlink. The linked folder itself is left alone."
						onClick={onUnlink}
					>
						<Link2Off size={13} /> Unlink
					</button>
				)}
				<button
					type="button"
					className="btn small"
					disabled={!repo.exists}
					onClick={() => void api.revealPath(repo.path)}
				>
					Show in Finder
				</button>
			</div>
		</div>
	);
}

function NewExperimentModal({
	home,
	workspaceRoot,
	onClose,
}: {
	home: string | undefined;
	workspaceRoot: string | undefined;
	onClose(): void;
}) {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	async function create(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const createExperiment = (
				api as typeof api & { createExperiment?: (name: string) => Promise<string> }
			).createExperiment;
			if (typeof createExperiment !== "function") {
				throw new Error(
					"Experiment creation was just added. Please fully restart Cosmos and try again.",
				);
			}
			const path = await createExperiment(name);
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
			<div className="modal" role="dialog" aria-label="New experiment">
				<form className="home-new-experiment" onSubmit={(event) => void create(event)}>
					<h2>New experiment</h2>
					<p className="muted">
						Creates a sibling folder under{" "}
						{workspaceRoot ? tildify(workspaceRoot, home) : "the workspace root"} so it
						inherits the same shared Pi and Glayvin context.
					</p>
					<div className="experiments-input-row">
						{/* biome-ignore lint/a11y/noAutofocus: the field is the point of the dialog */}
						<input
							autoFocus
							value={name}
							placeholder="cosmos-gui-prototype"
							onChange={(event) => setName(event.target.value)}
						/>
						<button type="submit" className="btn primary" disabled={busy || !name.trim()}>
							{busy ? "Creating…" : "Create"}
						</button>
						<button type="button" className="btn" onClick={onClose}>
							Cancel
						</button>
					</div>
					{error && <div className="experiments-error">{error}</div>}
				</form>
			</div>
		</div>
	);
}

/** Home: the landing surface when no session is open. */
export function HomeView() {
	const recent = useStore((s) => s.settings.recentProjects);
	const home = useStore((s) => s.appInfo?.homeDir);
	const workspaceRoot = useStore((s) => s.appInfo?.workspaceRoot);
	// Joining a team can publish a new cosmos-repos.json, which changes these suggestions.
	const workspaceRevision = useStore((s) => s.workspaceRevision);
	const [health, setHealth] = useState<WorkspaceHealth | null>(null);
	const [loading, setLoading] = useState(false);
	const [newExperimentOpen, setNewExperimentOpen] = useState(false);
	/** Repo name currently cloning, linking, or unlinking. One at a time. */
	const [busyRepo, setBusyRepo] = useState<string | null>(null);
	const [cloningRepo, setCloningRepo] = useState<string | null>(null);
	const [cloneProgress, setCloneProgress] = useState("");
	const [prompt, setPrompt] = useState("");
	const [cwd, setCwd] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);
	const textarea = useRef<HTMLTextAreaElement>(null);

	const refresh = () => {
		setLoading(true);
		return api
			.getWorkspaceHealth()
			.then((next) => setHealth(next))
			.finally(() => setLoading(false));
	};

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
	}, [workspaceRoot, workspaceRevision]);

	// Grow the prompt box with its content up to the CSS max-height.
	useLayoutEffect(() => {
		const el = textarea.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [prompt]);

	useEffect(
		() =>
			api.onWorkspaceProgress(({ name, message }) => {
				if (name === cloningRepo) setCloneProgress(message);
			}),
		[cloningRepo],
	);

	const runRepoAction = useCallback(
		async (
			name: string,
			action: () => Promise<WorkspaceHealth | null>,
			success?: (health: WorkspaceHealth) => string,
		) => {
			if (busyRepo) return;
			setBusyRepo(name);
			try {
				const next = await action();
				if (next) {
					setHealth(next);
					if (success) toast("info", success(next));
				}
			} catch (error) {
				toast("error", errorMessage(error));
			} finally {
				setBusyRepo(null);
			}
		},
		[busyRepo],
	);

	const cloneRepo = useCallback(
		(name: string) => {
			setCloningRepo(name);
			setCloneProgress("");
			void runRepoAction(
				name,
				() => api.cloneWorkspaceRepo(name),
				() => `Cloned ${name} into the workspace.`,
			).finally(() => {
				setCloningRepo(null);
				setCloneProgress("");
			});
		},
		[runRepoAction],
	);

	const linkRepo = useCallback(
		(name: string) => {
			void runRepoAction(name, () => api.linkWorkspaceRepo(name));
		},
		[runRepoAction],
	);

	const unlinkRepo = useCallback(
		(name: string) => {
			void runRepoAction(
				name,
				() => api.unlinkWorkspaceRepo(name),
				() => `Unlinked ${name}. The original folder was left in place.`,
			);
		},
		[runRepoAction],
	);

	const linkExistingProject = useCallback(() => {
		void runRepoAction(
			"__link-existing__",
			() => api.linkExistingProject(),
			() => "Linked the folder into your workspace.",
		);
	}, [runRepoAction]);

	const coreRepos = health?.repos ?? [];
	const experiments = health?.experiments ?? [];
	const knownPaths = useMemo(
		() => new Set([...coreRepos, ...experiments].map((repo) => repo.path)),
		[coreRepos, experiments],
	);
	const visibleRecent = useMemo(
		() =>
			recent
				.filter((path) =>
					workspaceRoot
						? path === workspaceRoot || path.startsWith(`${workspaceRoot}/`)
						: true,
				)
				.filter((path) => !knownPaths.has(path))
				.slice(0, 6),
		[recent, workspaceRoot, knownPaths],
	);

	const repoOptions: RepoOption[] = useMemo(
		() => [
			...coreRepos.map((repo) => ({
				path: repo.path,
				name: repo.name,
				group: "Company repos" as const,
				ready: repo.exists && repo.isGitRepo,
			})),
			...experiments.map((repo) => ({
				path: repo.path,
				name: repo.name,
				group: "Experiments" as const,
				ready: repo.exists && repo.isGitRepo,
			})),
			...visibleRecent.map((path) => ({
				path,
				name: basename(path),
				group: "Recent" as const,
				ready: true,
			})),
		],
		[coreRepos, experiments, visibleRecent],
	);

	// Default to the last project used, else the first ready repo in the workspace.
	// Only fills an empty selection so an explicit pick is never overwritten.
	useEffect(() => {
		if (cwd) return;
		const fallback =
			repoOptions.find((option) => option.ready && option.path === recent[0]) ??
			repoOptions.find((option) => option.ready);
		const next = fallback?.path ?? recent[0];
		if (next) setCwd(next);
	}, [repoOptions, recent, cwd]);

	const canSend = prompt.trim().length > 0 && Boolean(cwd) && !starting;

	const send = async (text = prompt) => {
		if (!cwd || starting || !text.trim()) return;
		setStarting(true);
		try {
			await startSessionWithPrompt(cwd, text);
			setPrompt("");
		} finally {
			setStarting(false);
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.nativeEvent.isComposing) return;
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void send();
		}
	};

	const addProject = async () => {
		const folder = await api.pickFolder();
		if (!folder) return;
		setCwd(folder);
		await refresh();
	};

	const readyCount = coreRepos.filter((repo) => repo.exists && repo.isGitRepo).length;

	return (
		<div className="main">
			<div className="main-header drag" style={{ paddingLeft: 16 }} />
			<div className="home">
				<div className="home-inner">
					<div className="home-hero">
						<CosmosMark size={44} />
					</div>

					<div className="home-composer-card">
						<div className="home-composer">
							<textarea
								ref={textarea}
								rows={1}
								value={prompt}
								spellCheck
								placeholder="Ask anything, or describe what you want to build…"
								onChange={(event) => setPrompt(event.target.value)}
								onKeyDown={onKeyDown}
							/>
							<div className="composer-toolbar">
								<HomePermissionPicker />
								<span className="spacer" />
								<HomeModelPicker />
								<button
									type="button"
									className="send-btn"
									title="Start session (Enter)"
									disabled={!canSend}
									onClick={() => void send()}
								>
									<ArrowUp size={17} />
								</button>
							</div>
						</div>
						<div className="home-context-bar">
							<RepoPicker
								options={repoOptions}
								value={cwd}
								home={home}
								onChange={setCwd}
							/>
							<span className="spacer" />
							<button type="button" className="chip" onClick={() => void addProject()}>
								<Plus size={13} /> Add project
							</button>
						</div>
					</div>

					<div className="home-suggestions">
						{SUGGESTIONS.map(({ prompt: text, label, icon: Icon }) => (
							<button
								key={label}
								type="button"
								className="home-suggestion"
								disabled={!cwd || starting}
								onClick={() => void send(text)}
							>
								<span className="home-suggestion-text">{text}</span>
								<span className="home-suggestion-tag">
									<Icon size={13} /> {label}
								</span>
							</button>
						))}
					</div>

					<section className="home-section">
						<div className="home-section-head">
							<div>
								<h2>Your workspace</h2>
								<p className="muted">
									{loading
										? "Checking…"
										: `${readyCount}/${coreRepos.length} core repos ready · ${experiments.length} experiments`}
									{health ? ` · ${tildify(health.rootPath, home)}` : ""}
								</p>
							</div>
							<div className="home-section-actions">
								<button
									type="button"
									className="btn small"
									disabled={busyRepo !== null}
									title="Symlink a project from anywhere on disk into the workspace root"
									onClick={linkExistingProject}
								>
									<Link2 size={13} /> Link existing…
								</button>
								<button
									type="button"
									className="btn small"
									onClick={() => setNewExperimentOpen(true)}
								>
									<FolderPlus size={13} /> New experiment
								</button>
								<button type="button" className="btn small" onClick={() => void refresh()}>
									<RefreshCw size={13} /> Refresh
								</button>
							</div>
						</div>
						{health && !health.rootExists && (
							<div className="muted">
								This folder does not exist yet. Set a different workspace root in Settings
								or create it before cloning repos.
							</div>
						)}
						{coreRepos.length > 0 && (
							<div className="repo-card-grid">
								{coreRepos.map((repo) => (
									<RepoTile
										key={repo.path}
										repo={repo}
										home={home}
										kind="core"
										busy={busyRepo !== null}
										cloning={cloningRepo === repo.name}
										progress={cloneProgress}
										onClone={() => cloneRepo(repo.name)}
										onLink={() => linkRepo(repo.name)}
										onUnlink={() => unlinkRepo(repo.name)}
									/>
								))}
							</div>
						)}
						<div className="workspace-section-label workspace-section-label-icon">
							<FlaskConical size={14} /> Experiments
						</div>
						{experiments.length > 0 ? (
							<div className="repo-card-grid">
								{experiments.map((repo) => (
									<RepoTile
										key={repo.path}
										repo={repo}
										home={home}
										kind="experiment"
										busy={busyRepo !== null}
										cloning={cloningRepo === repo.name}
										progress={cloneProgress}
										onClone={() => cloneRepo(repo.name)}
										onLink={() => linkRepo(repo.name)}
										onUnlink={() => unlinkRepo(repo.name)}
									/>
								))}
							</div>
						) : (
							<div className="muted">
								No experiment folders detected yet. Create one above, or clone a sibling
								project into the workspace root.
							</div>
						)}
					</section>
				</div>
			</div>
			{newExperimentOpen && (
				<NewExperimentModal
					home={home}
					workspaceRoot={workspaceRoot}
					onClose={() => setNewExperimentOpen(false)}
				/>
			)}
		</div>
	);
}
