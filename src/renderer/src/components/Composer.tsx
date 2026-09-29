import type { FileMatch } from "@shared/ipc";
import { ArrowUp, File, Folder, Paperclip, Square, X } from "lucide-react";
import {
	type ClipboardEvent,
	type DragEvent,
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { api } from "../lib/api";
import {
	addAttachments,
	DESKTOP_COMMANDS,
	removeAttachment,
	restoreQueue,
	sendDraft,
	setDraft,
	stop,
} from "../state/actions";
import {
	type Attachment,
	type TabState,
	toast,
	useStore,
} from "../state/store";
import { ModelPicker, PermissionPicker, ThinkingPicker } from "./Pickers";

const IMAGE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

interface Suggestion {
	key: string;
	label: string;
	detail?: string;
	icon?: "file" | "folder";
	/** Replacement for the trigger token. */
	insert: string;
}

interface Trigger {
	kind: "slash" | "mention";
	start: number;
	query: string;
}

function findTrigger(text: string, caret: number): Trigger | null {
	const before = text.slice(0, caret);
	const slash = /^\/([\w:.-]*)$/.exec(before);
	if (slash) return { kind: "slash", start: 0, query: slash[1] };
	const mention = /(^|\s)@([^\s@]*)$/.exec(before);
	if (mention)
		return {
			kind: "mention",
			start: caret - mention[2].length - 1,
			query: mention[2],
		};
	return null;
}

async function readImage(file: File): Promise<Attachment | null> {
	if (!IMAGE_TYPES.has(file.type)) return null;
	if (file.size > MAX_IMAGE_BYTES) {
		toast("warning", `${file.name} is larger than 20 MB and was not attached.`);
		return null;
	}
	const data = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
	return {
		id: crypto.randomUUID(),
		name: file.name || "pasted image",
		image: { type: "image", data, mimeType: file.type },
	};
}

export function Composer({
	tab,
	centered = false,
}: {
	tab: TabState;
	centered?: boolean;
}) {
	const textarea = useRef<HTMLTextAreaElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const focusTick = useStore((s) => s.focusComposerTick);
	const busySendMode = useStore((s) => s.settings.busySendMode);
	const [trigger, setTrigger] = useState<Trigger | null>(null);
	const [files, setFiles] = useState<FileMatch[]>([]);
	const [selected, setSelected] = useState(0);
	const [dragging, setDragging] = useState(false);
	const busy = tab.isStreaming || tab.isCompacting;

	useEffect(() => {
		textarea.current?.focus();
	}, [focusTick, tab.tabId]);

	// Grow with content up to the CSS max-height.
	useLayoutEffect(() => {
		const el = textarea.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [tab.draft]);

	useEffect(() => {
		if (trigger?.kind !== "mention") return;
		let cancelled = false;
		const timer = setTimeout(() => {
			void api.searchFiles(tab.cwd, trigger.query).then((results) => {
				if (!cancelled) setFiles(results);
			});
		}, 60);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [trigger, tab.cwd]);

	const suggestions: Suggestion[] = useMemo(() => {
		if (!trigger) return [];
		if (trigger.kind === "mention") {
			return files.map((file) => ({
				key: file.path,
				label: file.path,
				icon: file.isDirectory ? "folder" : "file",
				insert: `@${file.path}${file.isDirectory ? "" : " "}`,
			}));
		}
		const q = trigger.query.toLowerCase();
		const all: Suggestion[] = [
			...DESKTOP_COMMANDS.map((c) => ({
				key: `d:${c.name}`,
				label: `/${c.name}`,
				detail: c.description,
				insert: `/${c.name} `,
			})),
			...tab.commands.map((c) => ({
				key: `p:${c.name}`,
				label: `/${c.name}`,
				detail: c.description ?? c.source,
				insert: `/${c.name} `,
			})),
		];
		return all
			.filter((s) => s.label.slice(1).toLowerCase().includes(q))
			.slice(0, 50);
	}, [trigger, files, tab.commands]);

	useEffect(() => setSelected(0), [suggestions.length, trigger?.kind]);

	const updateTrigger = (text: string, caret: number) =>
		setTrigger(findTrigger(text, caret));

	const accept = (suggestion: Suggestion) => {
		if (!trigger) return;
		const el = textarea.current;
		const caret = el?.selectionStart ?? tab.draft.length;
		const next =
			tab.draft.slice(0, trigger.start) +
			suggestion.insert +
			tab.draft.slice(caret);
		setDraft(tab.tabId, next);
		const position = trigger.start + suggestion.insert.length;
		requestAnimationFrame(() => {
			el?.setSelectionRange(position, position);
			el?.focus();
			// A folder mention keeps the menu open to drill into it.
			updateTrigger(next, position);
		});
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.nativeEvent.isComposing) return;
		if (suggestions.length > 0 && trigger) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const delta = event.key === "ArrowDown" ? 1 : -1;
				setSelected((i) => (i + delta + suggestions.length) % suggestions.length);
				return;
			}
			if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
				event.preventDefault();
				accept(suggestions[selected] ?? suggestions[0]);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setTrigger(null);
				return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			const alternate = busySendMode === "steer" ? "followUp" : "steer";
			void sendDraft(tab.tabId, busy && event.altKey ? alternate : undefined);
			setTrigger(null);
			return;
		}
		if (event.key === "Escape" && busy) {
			event.preventDefault();
			void stop(tab.tabId);
		}
	};

	const attachFiles = async (list: FileList | File[]) => {
		const images: Attachment[] = [];
		const paths: string[] = [];
		for (const file of Array.from(list)) {
			const image = await readImage(file).catch(() => null);
			if (image) images.push(image);
			else {
				const path = api.getPathForFile(file);
				if (path)
					paths.push(
						path.startsWith(`${tab.cwd}/`) ? path.slice(tab.cwd.length + 1) : path,
					);
			}
		}
		if (images.length) addAttachments(tab.tabId, images);
		if (paths.length) {
			const mention = paths
				.map((p) => `@${p.includes(" ") ? `"${p}"` : p}`)
				.join(" ");
			setDraft(
				tab.tabId,
				tab.draft ? `${tab.draft.replace(/\s*$/, " ")}${mention} ` : `${mention} `,
			);
		}
	};

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const images = Array.from(event.clipboardData.files).filter((f) =>
			IMAGE_TYPES.has(f.type),
		);
		if (images.length) {
			event.preventDefault();
			void attachFiles(images);
		}
	};

	const onDrop = (event: DragEvent) => {
		event.preventDefault();
		setDragging(false);
		if (event.dataTransfer.files.length)
			void attachFiles(event.dataTransfer.files);
	};

	const canSend = tab.draft.trim().length > 0 || tab.attachments.length > 0;
	const queued = [
		...tab.queue.steering.map((t) => ({ t, kind: "Next turn" })),
		...tab.queue.followUp.map((t) => ({ t, kind: "After finishing" })),
	];
	const placeholder = busy
		? busySendMode === "steer"
			? "Pi is working — send a message to steer it"
			: "Pi is working — messages will be sent when it finishes"
		: tab.model
			? "Message pi…  (@ to mention files, / for commands, ! for shell)"
			: "Connect a model provider to get started";

	const above = Object.entries(tab.widgets).filter(
		([, w]) => w.placement === "aboveEditor",
	);
	const below = Object.entries(tab.widgets).filter(
		([, w]) => w.placement === "belowEditor",
	);

	return (
		<div className={`composer-wrap${centered ? " centered" : ""}`}>
			{above.map(([key, widget]) => (
				<div key={key} className="widget">
					{widget.lines.join("\n")}
				</div>
			))}
			{queued.length > 0 && (
				<div className="queue">
					{queued.map(({ t, kind }, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: queue order is the identity
						<div key={index} className="queue-item">
							<span>
								<strong style={{ fontWeight: 600 }}>{kind}:</strong> {t}
							</span>
							{index === 0 && (
								<button
									type="button"
									className="btn small"
									onClick={() => void restoreQueue(tab.tabId)}
									title="Move queued messages back into the message box"
								>
									Edit
								</button>
							)}
						</div>
					))}
				</div>
			)}
			<div className="composer-inner">
				{trigger && suggestions.length > 0 && (
					<div className="popover up" style={{ left: 0, right: 0 }} role="listbox">
						{suggestions.map((s, index) => (
							<button
								key={s.key}
								type="button"
								role="option"
								aria-selected={index === selected}
								className={`menu-item${index === selected ? " selected" : ""}`}
								onMouseDown={(e) => {
									e.preventDefault();
									accept(s);
								}}
								onMouseEnter={() => setSelected(index)}
							>
								{s.icon === "folder" ? (
									<Folder size={14} />
								) : s.icon === "file" ? (
									<File size={14} />
								) : null}
								<span
									className="name"
									style={{
										fontFamily: s.icon ? "var(--font-mono)" : undefined,
										fontSize: s.icon ? 12.5 : undefined,
									}}
								>
									{s.label}
								</span>
								{s.detail && <span className="desc">{s.detail}</span>}
							</button>
						))}
					</div>
				)}
				<div
					className={`composer${dragging ? " drop" : ""}`}
					onDragOver={(e) => {
						e.preventDefault();
						setDragging(true);
					}}
					onDragLeave={() => setDragging(false)}
					onDrop={onDrop}
				>
					{tab.attachments.length > 0 && (
						<div className="attachments">
							{tab.attachments.map((a) => (
								<div key={a.id} className="attachment" title={a.name}>
									<img
										alt={a.name}
										src={`data:${a.image.mimeType};base64,${a.image.data}`}
									/>
									<button
										type="button"
										aria-label={`Remove ${a.name}`}
										onClick={() => removeAttachment(tab.tabId, a.id)}
									>
										<X size={11} />
									</button>
								</div>
							))}
						</div>
					)}
					<textarea
						ref={textarea}
						rows={1}
						value={tab.draft}
						placeholder={placeholder}
						spellCheck
						onChange={(e) => {
							setDraft(tab.tabId, e.target.value);
							updateTrigger(e.target.value, e.target.selectionStart);
						}}
						onSelect={(e) =>
							updateTrigger(e.currentTarget.value, e.currentTarget.selectionStart)
						}
						onBlur={() => setTimeout(() => setTrigger(null), 120)}
						onKeyDown={onKeyDown}
						onPaste={onPaste}
					/>
					<div className="composer-toolbar">
						<button
							type="button"
							className="icon-btn"
							title="Attach images"
							onClick={() => fileInput.current?.click()}
						>
							<Paperclip size={16} />
						</button>
						<input
							ref={fileInput}
							type="file"
							accept="image/png,image/jpeg,image/gif,image/webp"
							multiple
							hidden
							onChange={(e) => {
								if (e.target.files) void attachFiles(e.target.files);
								e.target.value = "";
							}}
						/>
						<PermissionPicker tab={tab} />
						<span className="spacer" />
						<ThinkingPicker tab={tab} />
						<ModelPicker tab={tab} />
						{busy && !canSend ? (
							<button
								type="button"
								className="send-btn stop"
								title="Stop (Esc)"
								onClick={() => void stop(tab.tabId)}
							>
								<Square size={13} fill="currentColor" />
							</button>
						) : (
							<button
								type="button"
								className="send-btn"
								title={busy ? "Queue message (Enter)" : "Send (Enter)"}
								disabled={!canSend}
								onClick={() => void sendDraft(tab.tabId)}
							>
								<ArrowUp size={17} />
							</button>
						)}
					</div>
				</div>
			</div>
			{below.map(([key, widget]) => (
				<div key={key} className="widget" style={{ marginTop: 8 }}>
					{widget.lines.join("\n")}
				</div>
			))}
		</div>
	);
}
