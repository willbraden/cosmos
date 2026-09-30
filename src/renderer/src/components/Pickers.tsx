import type { PermissionMode } from "@shared/ipc";
import type { Model, ThinkingLevel } from "@shared/pi-types";
import { Brain, Check, ChevronDown, Cpu, Hand, ShieldCheck, Zap } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { setModel, setPermissionMode, setThinkingLevel } from "../state/actions";
import { type TabState, useStore } from "../state/store";

export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
	useEffect(() => {
		if (!open) return;
		const onPointer = (event: MouseEvent) => {
			if (ref.current && !ref.current.contains(event.target as Node)) onClose();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("mousedown", onPointer);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("mousedown", onPointer);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [ref, open, onClose]);
}

function Dropdown({
	trigger,
	title,
	children,
	align = "left",
	width,
}: {
	trigger: ReactNode;
	title: string;
	children: (close: () => void) => ReactNode;
	align?: "left" | "right";
	width?: number;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const close = () => setOpen(false);
	useDismiss(ref, open, close);
	return (
		<div ref={ref} className="dropdown">
			<button type="button" className="chip" title={title} onClick={() => setOpen(!open)} aria-expanded={open}>
				{trigger}
				<ChevronDown size={12} />
			</button>
			{open && (
				<div className="popover up" style={{ [align]: 0, width }}>
					{children(close)}
				</div>
			)}
		</div>
	);
}

export const PERMISSION_MODES: { mode: PermissionMode; label: string; help: string; icon: typeof Hand }[] = [
	{ mode: "ask", label: "Ask permissions", help: "Confirm before editing files or running commands", icon: Hand },
	{ mode: "acceptEdits", label: "Accept edits", help: "Edit files freely; confirm commands", icon: ShieldCheck },
	{ mode: "auto", label: "Auto", help: "Never ask. Pi has full access to your machine", icon: Zap },
];

export function PermissionPicker({ tab }: { tab: TabState }) {
	const current = PERMISSION_MODES.find((m) => m.mode === tab.permissionMode) ?? PERMISSION_MODES[0];
	const Icon = current.icon;
	return (
		<Dropdown
			title="Permission mode"
			trigger={
				<>
					<Icon size={13} />
					<span className="chip-label">{current.label}</span>
				</>
			}
			width={300}
		>
			{(close) => (
				<>
					<div className="popover-label">Permissions</div>
					{PERMISSION_MODES.map(({ mode, label, help, icon: ModeIcon }) => (
						<button
							key={mode}
							type="button"
							className="menu-item"
							onClick={() => {
								close();
								void setPermissionMode(tab.tabId, mode);
							}}
						>
							<ModeIcon size={14} style={{ flexShrink: 0 }} />
							<span className="menu-item-stack">
								<span className="name">{label}</span>
								<span className="desc" style={{ whiteSpace: "normal" }}>
									{help}
								</span>
							</span>
							{mode === tab.permissionMode && <Check size={14} className="check" />}
						</button>
					))}
				</>
			)}
		</Dropdown>
	);
}

export function ModelPicker({ tab }: { tab: TabState }) {
	const models = useStore((s) => s.models);
	const [filter, setFilter] = useState("");
	const groups = useMemo(() => {
		const q = filter.toLowerCase();
		const map = new Map<string, Model[]>();
		for (const model of models) {
			if (q && !`${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(q)) continue;
			map.set(model.provider, [...(map.get(model.provider) ?? []), model]);
		}
		return [...map.entries()];
	}, [models, filter]);

	return (
		<Dropdown
			title="Model"
			align="right"
			width={320}
			trigger={
				<>
					<Cpu size={13} />
					<span className="chip-label">{tab.model?.name ?? "No model"}</span>
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
						<input className="filter" autoFocus placeholder="Search models…" value={filter} onChange={(e) => setFilter(e.target.value)} />
						{groups.map(([provider, list]) => (
							<div key={provider}>
								<div className="popover-label">{provider}</div>
								{list.map((model) => {
									const selected = tab.model?.provider === model.provider && tab.model.id === model.id;
									return (
										<button
											key={`${model.provider}/${model.id}`}
											type="button"
											className="menu-item"
											onClick={() => {
												close();
												if (!selected) void setModel(tab.tabId, model);
											}}
										>
											<span className="menu-item-stack">
												<span className="name">{model.name}</span>
												<span className="desc">
													{model.id}
													{model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}k context` : ""}
												</span>
											</span>
											{selected && <Check size={14} className="check" />}
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

const LEVEL_LABELS: Record<ThinkingLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

export function ThinkingPicker({ tab }: { tab: TabState }) {
	if (tab.thinkingLevels.length <= 1) return null;
	return (
		<Dropdown
			title="Thinking level"
			align="right"
			trigger={
				<>
					<Brain size={13} />
					<span className="chip-label">{LEVEL_LABELS[tab.thinkingLevel] ?? tab.thinkingLevel}</span>
				</>
			}
		>
			{(close) => (
				<>
					<div className="popover-label">Thinking</div>
					{tab.thinkingLevels.map((level) => (
						<button
							key={level}
							type="button"
							className="menu-item"
							onClick={() => {
								close();
								void setThinkingLevel(tab.tabId, level);
							}}
						>
							{LEVEL_LABELS[level] ?? level}
							{level === tab.thinkingLevel && <Check size={14} className="check" />}
						</button>
					))}
				</>
			)}
		</Dropdown>
	);
}
