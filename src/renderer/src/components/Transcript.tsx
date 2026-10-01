import {
	ArrowDown,
	Brain,
	ChevronDown,
	CircleAlert,
	History,
	Info,
	Pencil,
	SquareTerminal,
	TriangleAlert,
} from "lucide-react";
import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { splitThoughts, summarizeBusyWork } from "../lib/activity";
import { formatTokens } from "../lib/api";
import { editMessage, parsePermissionPrompt } from "../state/actions";
import { isHiddenUserPromptText, type Block, type ChatItem, type ChatState } from "../state/chat-model";
import type { TabState } from "../state/store";
import { ErrorBoundary } from "./ErrorBoundary";
import { CopyButton, Markdown } from "./Markdown";
import { SpinnerIcon } from "./SpinnerIcon";
import { ToolCard } from "./ToolCard";

function ThinkingFold({
	title,
	body,
	redacted,
	live,
}: {
	title: string | null;
	body: string;
	redacted: boolean;
	live: boolean;
}) {
	const [open, setOpen] = useState(false);
	const { mounted, expanded } = useCollapseAnimation(open);
	const label = title ?? (redacted ? "Thinking (redacted)" : "Thinking");
	return (
		<div className="fold thinking-fold">
			<button
				type="button"
				className={`fold-header thinking-header${live ? " is-live shimmer" : ""}`}
				onClick={() => setOpen(!open)}
				aria-expanded={open}
			>
				<span className="fold-icon">
					{live ? (
						<SpinnerIcon size={14} className="fold-icon-rest" />
					) : (
						<Brain size={14} className="fold-icon-rest" />
					)}
					<ChevronDown size={14} className="fold-icon-chevron" />
				</span>
				<span className="label">{label}</span>
			</button>
			{mounted && (
				<div className={`thinking-reveal${expanded ? " expanded" : ""}`}>
					<div className="thinking-reveal-inner">
						<div className="thinking-content">
							{body ? (
								<div className="thinking-body">{body}</div>
							) : (
								<div className="thinking-body muted">
									This reasoning was redacted.
								</div>
							)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

type ReasoningBlock = Exclude<Block, { type: "text" }>;
type AssistantTranscriptItem = Extract<ChatItem, { kind: "assistant" }>;
type NonAssistantItem = Exclude<ChatItem, { kind: "assistant" }>;
type TranscriptRow =
	| { key: string; kind: "assistantTurn"; items: AssistantTranscriptItem[] }
	| { key: string; kind: "item"; item: NonAssistantItem };

function hasActiveReasoningWork(
	blocks: ReasoningBlock[],
	tools: ChatState["tools"],
	waitingToolIds: Set<string>,
	settled: boolean,
): boolean {
	const waiting = blocks.some(
		(block) => block.type === "toolCall" && waitingToolIds.has(block.id),
	);
	const running = blocks.some(
		(block) =>
			block.type === "toolCall" &&
			!waitingToolIds.has(block.id) &&
			!settled &&
			(!tools[block.id] || tools[block.id]?.status === "running"),
	);
	return waiting || running;
}

const UserMessage = memo(function UserMessage({
	item,
	tabId,
	canEdit,
}: {
	item: Extract<ChatItem, { kind: "user" }>;
	tabId: string;
	canEdit: boolean;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(item.text);
	const textarea = useRef<HTMLTextAreaElement>(null);

	// Leave edit mode if the message is replaced underneath us (e.g. a reload).
	useEffect(() => {
		setEditing(false);
	}, [item.entryId]);

	useLayoutEffect(() => {
		const el = textarea.current;
		if (!editing || !el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [editing, draft]);

	const startEditing = useCallback(() => {
		setDraft(item.text);
		setEditing(true);
		// Focus after the textarea mounts, with the caret at the end.
		requestAnimationFrame(() => {
			const el = textarea.current;
			if (!el) return;
			el.focus();
			el.setSelectionRange(el.value.length, el.value.length);
		});
	}, [item.text]);

	const cancel = useCallback(() => {
		setEditing(false);
		setDraft(item.text);
	}, [item.text]);

	const save = useCallback(() => {
		const entryId = item.entryId;
		if (!entryId) return;
		const trimmed = draft.trim();
		if (!trimmed || trimmed === item.text.trim()) {
			cancel();
			return;
		}
		setEditing(false);
		void editMessage(tabId, entryId, trimmed, item.images);
	}, [cancel, draft, item.entryId, item.images, item.text, tabId]);

	if (editing) {
		return (
			<div className="user-msg editing">
				<textarea
					ref={textarea}
					className="user-edit"
					value={draft}
					aria-label="Edit message"
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							cancel();
						} else if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							save();
						}
					}}
				/>
				<div className="user-edit-actions">
					<span className="muted small-text">
						Replaces everything after this message
					</span>
					<button type="button" className="btn" onClick={cancel}>
						Cancel
					</button>
					<button
						type="button"
						className="btn primary"
						onClick={save}
						disabled={!draft.trim()}
					>
						Send
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="user-msg">
			{item.images.length > 0 && (
				<div className="user-images">
					{item.images.map((image, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static list
						<img
							key={index}
							alt="Attached"
							src={`data:${image.mimeType};base64,${image.data}`}
						/>
					))}
				</div>
			)}
			{item.text && <div className="user-bubble">{item.text}</div>}
			<div className="msg-actions">
				<CopyButton text={item.text} label="Copy message" />
				{canEdit && item.entryId && (
					<button
						type="button"
						className="icon-btn"
						title="Edit — resend from this message"
						aria-label="Edit message"
						onClick={startEditing}
					>
						<Pencil size={14} />
					</button>
				)}
			</div>
		</div>
	);
});

function formatThoughtDuration(durationMs: number | undefined): string | null {
	if (!durationMs || durationMs <= 0) return null;
	const seconds = Math.max(1, Math.round(durationMs / 1000));
	if (seconds < 60) return `Thought for ${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder > 0
		? `Thought for ${minutes}m ${remainder}s`
		: `Thought for ${minutes}m`;
}

function assistantText(item: AssistantTranscriptItem): string {
	return item.blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n\n")
		.trim();
}

function assistantDetailBlocks(item: AssistantTranscriptItem): ReasoningBlock[] {
	return item.blocks.filter(
		(block): block is ReasoningBlock => block.type !== "text",
	);
}

const COLLAPSE_MS = 300;

/**
 * Drives the expand/collapse transition. Contents stay mounted for the length of
 * the collapse so they can animate out, then unmount to keep long transcripts light.
 */
function useCollapseAnimation(open: boolean) {
	const [mounted, setMounted] = useState(open);
	const [expanded, setExpanded] = useState(open);

	useEffect(() => {
		if (open) {
			setMounted(true);
			return;
		}
		setExpanded(false);
		const timer = setTimeout(() => setMounted(false), COLLAPSE_MS);
		return () => clearTimeout(timer);
	}, [open]);

	// Grow only once the contents are in the DOM, so the transition has a
	// collapsed frame to animate away from.
	useEffect(() => {
		if (!open || !mounted) return;
		const frame = requestAnimationFrame(() => setExpanded(true));
		return () => cancelAnimationFrame(frame);
	}, [open, mounted]);

	return { mounted, expanded };
}

type ToolCallBlock = Extract<Block, { type: "toolCall" }>;

type TurnNode =
	| { key: string; kind: "text"; text: string }
	| {
			key: string;
			kind: "thought";
			title: string | null;
			body: string;
			redacted: boolean;
			live: boolean;
	  }
	| { key: string; kind: "tool"; block: ToolCallBlock; settled: boolean };

/**
 * Flattens a turn into one chronological list. Reasoning collapses per section
 * while tool calls and prose stay at the top level rather than behind one fold.
 */
function flattenTurn(
	items: AssistantTranscriptItem[],
	turnActive: boolean,
): TurnNode[] {
	const nodes: TurnNode[] = [];
	for (const item of items) {
		let pending: string[] = [];
		let pendingKey = "";
		const flushText = () => {
			const text = pending.join("\n\n").trim();
			pending = [];
			if (text) nodes.push({ key: pendingKey, kind: "text", text });
		};
		item.blocks.forEach((block, index) => {
			if (block.type === "text") {
				if (pending.length === 0) pendingKey = `${item.key}:text:${index}`;
				pending.push(block.text);
				return;
			}
			flushText();
			if (block.type === "thinking") {
				// Only a trailing reasoning block is still being written to.
				const streaming =
					turnActive && item.streaming && index === item.blocks.length - 1;
				const sections = splitThoughts(block.text);
				if (sections.length === 0) {
					if (!block.redacted) return;
					nodes.push({
						key: `${item.key}:thought:${index}`,
						kind: "thought",
						title: null,
						body: "",
						redacted: true,
						live: false,
					});
					return;
				}
				sections.forEach((section, part) => {
					nodes.push({
						key: `${item.key}:thought:${index}:${part}`,
						kind: "thought",
						title: section.title,
						body: section.body,
						redacted: !!block.redacted,
						live: streaming && part === sections.length - 1,
					});
				});
				return;
			}
			nodes.push({
				key: `${item.key}:tool:${block.id || index}`,
				kind: "tool",
				block,
				settled: !item.streaming,
			});
		});
		flushText();
	}
	return nodes;
}

const AssistantTurn = memo(function AssistantTurn({
	items,
	tools,
	cwd,
	waitingToolIds,
	showFooter,
	turnActive,
}: {
	items: AssistantTranscriptItem[];
	tools: ChatState["tools"];
	cwd: string;
	waitingToolIds: Set<string>;
	showFooter: boolean;
	turnActive: boolean;
}) {
	const finalItem = items[items.length - 1];
	const text = assistantText(finalItem);
	const failed =
		finalItem.stopReason === "error" ||
		(finalItem.stopReason === "aborted" && finalItem.errorMessage);
	const durationLabel = formatThoughtDuration(finalItem.durationMs);
	const nodes = useMemo(
		() => flattenTurn(items, turnActive),
		[items, turnActive],
	);

	return (
		<div className="assistant-msg">
			{nodes.map((node) => {
				if (node.kind === "text")
					return <Markdown key={node.key} text={node.text} />;
				if (node.kind === "thought")
					return (
						<ThinkingFold
							key={node.key}
							title={node.title}
							body={node.body}
							redacted={node.redacted}
							live={node.live}
						/>
					);
				return (
					<ToolCard
						key={node.key}
						block={node.block}
						run={tools[node.block.id]}
						cwd={cwd}
						settled={node.settled}
						awaitingPermission={waitingToolIds.has(node.block.id)}
					/>
				);
			})}
			{failed && (
				<div className="error-card">
					<strong>
						{finalItem.stopReason === "aborted" ? "Stopped" : "Error"}:
					</strong>{" "}
					{finalItem.errorMessage ?? "The request failed."}
				</div>
			)}
			{finalItem.stopReason === "aborted" && !finalItem.errorMessage && (
				<div className="muted small-text">Stopped</div>
			)}
			{showFooter &&
				!finalItem.streaming &&
				finalItem.stopReason !== "toolUse" &&
				(text || durationLabel) && (
					<div className="assistant-footer">
						{durationLabel && <span>{durationLabel}</span>}
						{text && <CopyButton text={text} label="Copy latest response" />}
					</div>
				)}
		</div>
	);
});

function BashItem({ item }: { item: Extract<ChatItem, { kind: "bash" }> }) {
	const [open, setOpen] = useState(true);
	return (
		<div className="fold">
			<button
				type="button"
				className="fold-header"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
			>
				<span className="fold-icon">
					<SquareTerminal size={14} className="fold-icon-rest" />
					<ChevronDown size={14} className="fold-icon-chevron" />
				</span>
				<span className="label">
					<code>$ {item.command}</code>
				</span>
				<span className="tail">
					{item.excludeFromContext && <span>not sent to model</span>}
					{item.running ? (
						<span className="spinner" />
					) : item.cancelled ? (
						"cancelled"
					) : (
						`exit ${item.exitCode ?? "?"}`
					)}
				</span>
			</button>
			{open && (
				<div className="tool-body">
					<pre className={`tool-pre${item.exitCode ? " error" : ""}`}>
						{item.output || (item.running ? "…" : "(no output)")}
					</pre>
				</div>
			)}
		</div>
	);
}

function Notice({ item }: { item: Extract<ChatItem, { kind: "notice" }> }) {
	const Icon =
		item.level === "error"
			? CircleAlert
			: item.level === "warning"
				? TriangleAlert
				: Info;
	return (
		<div className={`notice ${item.level}`}>
			<Icon size={15} style={{ flexShrink: 0, marginTop: 2 }} />
			<span>{item.text}</span>
		</div>
	);
}

function SummaryCard({ title, summary }: { title: string; summary: string }) {
	return (
		<details className="divider-card">
			<summary>
				<History size={14} /> {title}
			</summary>
			<Markdown text={summary} />
		</details>
	);
}

function renderStandaloneItem(item: NonAssistantItem, tab: TabState) {
	switch (item.kind) {
		case "user":
			return (
				<UserMessage item={item} tabId={tab.tabId} canEdit={!tab.isStreaming} />
			);
		case "bash":
			return <BashItem item={item} />;
		case "notice":
			return <Notice item={item} />;
		case "compaction":
			return (
				<SummaryCard
					title={`Context compacted${item.tokensBefore ? ` (was ${formatTokens(item.tokensBefore)} tokens)` : ""} — earlier messages are summarized for the model`}
					summary={item.summary}
				/>
			);
		case "branchSummary":
			return (
				<SummaryCard
					title="Summary of the branch you left"
					summary={item.summary}
				/>
			);
		case "custom":
			return (
				<div className="notice info">
					<Info size={15} style={{ flexShrink: 0, marginTop: 2 }} />
					<div>
						<div className="muted small-text">{item.customType}</div>
						<Markdown text={item.text} />
					</div>
				</div>
			);
	}
}

function groupTranscriptRows(items: ChatItem[]): TranscriptRow[] {
	const rows: TranscriptRow[] = [];
	let bufferedAssistants: AssistantTranscriptItem[] = [];
	const flushAssistants = () => {
		if (bufferedAssistants.length === 0) return;
		rows.push({
			key: bufferedAssistants[0].key,
			kind: "assistantTurn",
			items: bufferedAssistants,
		});
		bufferedAssistants = [];
	};
	for (const item of items) {
		if (item.kind === "assistant") {
			bufferedAssistants.push(item);
			continue;
		}
		flushAssistants();
		if (item.kind === "user" && isHiddenUserPromptText(item.text)) continue;
		rows.push({ key: item.key, kind: "item", item });
	}
	flushAssistants();
	return rows;
}

function renderRow(
	row: TranscriptRow,
	tab: TabState,
	waiting: Set<string>,
	latestAssistantTurnKey?: string,
) {
	if (row.kind === "assistantTurn") {
		return (
			<AssistantTurn
				items={row.items}
				tools={tab.chat.tools}
				cwd={tab.cwd}
				waitingToolIds={waiting}
				showFooter={row.key === latestAssistantTurnKey}
				turnActive={row.key === latestAssistantTurnKey && tab.isStreaming}
			/>
		);
	}
	return renderStandaloneItem(row.item, tab);
}

function hasInlineActiveIndicator(
	rows: TranscriptRow[],
	tab: TabState,
	waitingToolIds: Set<string>,
): boolean {
	for (let index = rows.length - 1; index >= 0; index--) {
		const row = rows[index];
		if (row.kind === "assistantTurn") {
			const latestDetailItem = [...row.items]
				.reverse()
				.find((item) => assistantDetailBlocks(item).length > 0);
			if (!latestDetailItem?.streaming) return false;
			return hasActiveReasoningWork(
				assistantDetailBlocks(latestDetailItem),
				tab.chat.tools,
				waitingToolIds,
				false,
			);
		}
		if (row.item.kind === "bash") return row.item.running;
	}
	return false;
}

function WorkingIndicator({
	tab,
	waitingToolIds,
}: {
	tab: TabState;
	waitingToolIds: Set<string>;
}) {
	const [, force] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => force((n) => n + 1), 1000);
		return () => clearInterval(timer);
	}, []);
	const seconds = tab.runStartedAt
		? Math.floor((Date.now() - tab.runStartedAt) / 1000)
		: 0;
	let label =
		summarizeBusyWork(tab.chat.items, tab.chat.tools, waitingToolIds) ??
		"Working";
	if (tab.isCompacting) label = "Compacting context";
	else if (tab.retry) {
		const wait = Math.max(
			0,
			Math.ceil((tab.retry.at + tab.retry.delayMs - Date.now()) / 1000),
		);
		label = `${tab.retry.message} — retrying (${tab.retry.attempt}/${tab.retry.maxAttempts})${wait ? ` in ${wait}s` : ""}`;
	}
	return (
		<div className="working">
			<SpinnerIcon size={14} />
			{label}
			{seconds > 2 && !tab.retry ? ` · ${seconds}s` : ""}
		</div>
	);
}

export function Transcript({
	tab,
	onScrolled,
}: {
	tab: TabState;
	onScrolled(scrolled: boolean): void;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const [showJump, setShowJump] = useState(false);

	const waiting = new Set<string>();
	for (const dialog of tab.dialogs) {
		const payload =
			"title" in dialog ? parsePermissionPrompt(dialog.title) : null;
		if (payload) waiting.add(payload.toolCallId);
	}

	const scrollToBottom = useCallback((smooth = false) => {
		const el = scroller.current;
		if (el)
			el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
	}, []);

	// Stick to the bottom while content streams in, unless the user scrolled up to read.
	useLayoutEffect(() => {
		if (pinned.current) scrollToBottom();
	});

	// Opening a different session always starts at the latest message.
	useLayoutEffect(() => {
		pinned.current = true;
		scrollToBottom();
	}, [tab.tabId, scrollToBottom]);

	const onScroll = () => {
		const el = scroller.current;
		if (!el) return;
		const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
		pinned.current = distance < 40;
		setShowJump(distance > 300);
		onScrolled(el.scrollTop > 4);
	};

	const rows = useMemo(() => groupTranscriptRows(tab.chat.items), [tab.chat.items]);
	const busy = tab.isStreaming || tab.isCompacting;
	const showBottomWorkingIndicator = !hasInlineActiveIndicator(rows, tab, waiting);
	const latestAssistantTurnKey = [...rows]
		.reverse()
		.find((row): row is Extract<TranscriptRow, { kind: "assistantTurn" }> => row.kind === "assistantTurn")?.key;
	return (
		<>
			<div className="transcript" ref={scroller} onScroll={onScroll}>
				<div className="transcript-inner">
					{rows.map((row) => (
						<ErrorBoundary key={row.key} inline>
							{renderRow(row, tab, waiting, latestAssistantTurnKey)}
						</ErrorBoundary>
					))}
					{busy && showBottomWorkingIndicator && (
						<WorkingIndicator tab={tab} waitingToolIds={waiting} />
					)}
				</div>
			</div>
			{showJump && (
				<button
					type="button"
					className="icon-btn scroll-bottom"
					title="Jump to latest"
					onClick={() => {
						pinned.current = true;
						scrollToBottom(true);
					}}
				>
					<ArrowDown size={16} />
				</button>
			)}
		</>
	);
}
