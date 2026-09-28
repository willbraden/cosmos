import { Sparkles, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { basename } from "../lib/api";
import {
	buildUiInspectPrompt,
	describeInspectableElement,
	pickInspectableElement,
	type UiInspectSelection,
} from "../lib/ui-inspector";
import { sendDraft, setDraft, startFreshSession } from "../state/actions";
import { getTab, toast, useStore } from "../state/store";

function useGlobalInspectShortcut(
	enabled: boolean,
	onStart: () => void,
	onCancel: () => void,
) {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				onCancel();
				return;
			}
			if (!enabled || event.repeat || event.altKey || event.shiftKey) return;
			if (!(event.metaKey || event.ctrlKey)) return;
			if (event.key.toLowerCase() !== "i") return;
			event.preventDefault();
			onStart();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [enabled, onCancel, onStart]);
}

function resolveInspectChatCwd(): string | null {
	const state = useStore.getState();
	const recent = state.settings.recentProjects.find(
		(path) => basename(path) === "cosmos-gui",
	);
	if (recent) return recent;
	const workspaceRoot = state.appInfo?.workspaceRoot || state.settings.workspaceRootPath;
	return workspaceRoot ? `${workspaceRoot.replace(/\/+$/, "")}/cosmos-gui` : null;
}

export function DeveloperInspector() {
	const developerMode = useStore((s) => s.settings.developerMode);
	const [inspectMode, setInspectMode] = useState(false);
	const [hovered, setHovered] = useState<UiInspectSelection | null>(null);
	const [selection, setSelection] = useState<UiInspectSelection | null>(null);
	const [prompt, setPrompt] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const pointer = useRef<{ x: number; y: number } | null>(null);
	const textarea = useRef<HTMLTextAreaElement>(null);

	const closeModal = () => {
		if (submitting) return;
		setSelection(null);
		setPrompt("");
	};

	const cancelInspect = () => {
		setInspectMode(false);
		setHovered(null);
	};

	useGlobalInspectShortcut(
		developerMode,
		() => {
			if (selection || submitting) return;
			setInspectMode(true);
		},
		() => {
			if (selection) closeModal();
			else if (inspectMode) cancelInspect();
		},
	);

	useEffect(() => {
		if (developerMode) return;
		cancelInspect();
		closeModal();
	}, [developerMode]);

	useEffect(() => {
		if (!selection) return;
		requestAnimationFrame(() => textarea.current?.focus());
	}, [selection]);

	useEffect(() => {
		if (!inspectMode) {
			document.body.classList.remove("inspect-mode");
			return;
		}
		document.body.classList.add("inspect-mode");

		const updateHovered = (x: number, y: number) => {
			pointer.current = { x, y };
			const target = pickInspectableElement(document.elementFromPoint(x, y));
			setHovered(target ? describeInspectableElement(target) : null);
		};

		const onPointerMove = (event: PointerEvent) => {
			updateHovered(event.clientX, event.clientY);
		};

		const refreshHovered = () => {
			if (!pointer.current) return;
			updateHovered(pointer.current.x, pointer.current.y);
		};

		const onClick = (event: MouseEvent) => {
			const target = pickInspectableElement(
				document.elementFromPoint(event.clientX, event.clientY),
			);
			event.preventDefault();
			event.stopPropagation();
			if (!target) {
				cancelInspect();
				return;
			}
			setSelection(describeInspectableElement(target));
			setPrompt("");
			setInspectMode(false);
			setHovered(null);
		};

		window.addEventListener("pointermove", onPointerMove, true);
		window.addEventListener("click", onClick, true);
		window.addEventListener("scroll", refreshHovered, true);
		window.addEventListener("resize", refreshHovered);
		return () => {
			document.body.classList.remove("inspect-mode");
			window.removeEventListener("pointermove", onPointerMove, true);
			window.removeEventListener("click", onClick, true);
			window.removeEventListener("scroll", refreshHovered, true);
			window.removeEventListener("resize", refreshHovered);
		};
	}, [inspectMode]);

	const helper = useMemo(() => {
		return resolveInspectChatCwd()
			? "Chat will start in a new cosmos-gui session."
			: "Open cosmos-gui from the workspace first so Cosmos knows where to start the chat.";
	}, [selection]);

	const startChat = async (event: FormEvent) => {
		event.preventDefault();
		if (!selection || !prompt.trim() || submitting) return;
		setSubmitting(true);
		try {
			const cwd = resolveInspectChatCwd();
			if (!cwd) {
				toast(
					"warning",
					"Open cosmos-gui from the workspace first so Cosmos knows where to start the chat.",
				);
				return;
			}
			const tabId = await startFreshSession(cwd);
			const tab = getTab(tabId);
			if (!tab || tab.status !== "ready") {
				toast(
					"warning",
					"Wait for the new cosmos-gui session to finish opening, then try again.",
				);
				return;
			}
			setDraft(tab.tabId, buildUiInspectPrompt(selection, prompt));
			await sendDraft(tab.tabId);
			setSelection(null);
			setPrompt("");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<>
			{inspectMode && hovered && (
				<>
					<div className="inspect-overlay" data-ui-inspector-ignore="true">
						<div
							className="inspect-highlight"
							style={{
								top: hovered.rect.top,
								left: hovered.rect.left,
								width: hovered.rect.width,
								height: hovered.rect.height,
							}}
						>
							<div className="inspect-pill">Inspect · {hovered.title}</div>
						</div>
					</div>
					<div className="inspect-hint" data-ui-inspector-ignore="true">
						<Sparkles size={14} />
						<span>
							Inspect mode: hover any element, click to prompt pi, esc to cancel
						</span>
					</div>
				</>
			)}
			{selection && (
				<div
					className="modal-backdrop"
					data-ui-inspector-ignore="true"
					onMouseDown={(event) => {
						if (event.target === event.currentTarget) closeModal();
					}}
				>
					<div
						className="modal small inspect-modal"
						role="dialog"
						aria-label="Inspect selected UI element"
						onMouseDown={(event) => event.stopPropagation()}
					>
						<div className="inspect-modal-header">
							<div>
								<div className="experiments-modal-eyebrow">Developer mode</div>
								<h2>Inspect selected UI</h2>
								<p>{selection.summary}</p>
							</div>
							<button
								type="button"
								className="icon-btn"
								title="Cancel"
								onClick={closeModal}
							>
								<X size={16} />
							</button>
						</div>
						<form
							className="inspect-modal-body"
							onSubmit={(event) => void startChat(event)}
						>
							<label className="inspect-modal-field">
								<span>What do you want help with?</span>
								<textarea
									ref={textarea}
									rows={6}
									value={prompt}
									placeholder="Explain this UI, find the component that renders it, suggest a redesign, debug its behavior..."
									onChange={(event) => setPrompt(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Escape") {
											event.preventDefault();
											closeModal();
										}
									}}
								/>
							</label>
							<div className="inspect-modal-helper">{helper}</div>
							<div className="inspect-modal-actions">
								<button
									type="button"
									className="btn"
									onClick={closeModal}
									disabled={submitting}
								>
									Cancel
								</button>
								<button
									type="submit"
									className="btn primary"
									disabled={!prompt.trim() || submitting}
								>
									{submitting ? "Starting…" : "Start chat"}
								</button>
							</div>
						</form>
					</div>
				</div>
			)}
		</>
	);
}
