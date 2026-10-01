import {
	ArrowDown,
	Brain,
	ChevronDown,
	ChevronRight,
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
import {
	reasoningStepCount,
	summarizeBusyWork,
	summarizeReasoning,
} from "../lib/activity";
import { formatTokens } from "../lib/api";
import { forkFromMessage, parsePermissionPrompt } from "../state/actions";
import { isHiddenUserPromptText, type Block, type ChatItem, type ChatState } from "../state/chat-model";
import type { TabState } from "../state/store";
import { ErrorBoundary } from "./ErrorBoundary";
import { CopyButton, Markdown } from "./Markdown";
import { SpinnerIcon } from "./SpinnerIcon";
import { ToolCard } from "./ToolCard";

function ReasoningNote({
	text,
	redacted,
}: {
	text: string;
	redacted?: boolean;
}) {
	if (!text && !redacted) return null;
	return (
		<div className="reasoning-note">
			<div className="tool-section-label">
				{redacted ? "Reasoning (redacted)" : "Reasoning"}
			</div>
			{text ? (
				<div className="thinking-body">{text}</div>
			) : (
				<div className="thinking-body muted">This reasoning was redacted.</div>
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
	canFork,
}: {
	item: Extract<ChatItem, { kind: "user" }>;
	tabId: string;
	canFork: boolean;
}) {
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
				{canFork && item.entryId && (
					<button
						type="button"
						className="icon-btn"
						title="Edit — branch a new session from this message"
						aria-label="Edit message"
						onClick={() => void forkFromMessage(tabId, item.entryId as string)}
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

function AssistantStepDetails({
	item,
	tools,
	cwd,
	waitingToolIds,
}: {
	item: AssistantTranscriptItem;
	tools: ChatState["tools"];
	cwd: string;
	waitingToolIds: Set<string>;
}) {
	return (
		<>
			{item.blocks.map((block, index) => {
				if (block.type === "text") {
					return block.text.trim() ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional
						<Markdown key={`text:${index}`} text={block.text} />
					) : null;
				}
				if (block.type === "thinking") {
					return (
						<ReasoningNote
							// biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional
							key={`thinking:${index}`}
							text={block.text}
							redacted={block.redacted}
						/>
					);
				}
				return (
					<ToolCard
						key={block.id || index}
						block={block}
						run={tools[block.id]}
						cwd={cwd}
						settled={!item.streaming}
						awaitingPermission={waitingToolIds.has(block.id)}
					/>
				);
			})}
		</>
	);
}

const AssistantTurn = memo(function AssistantTurn({
	items,
	tools,
	cwd,
	waitingToolIds,
	runStartedAt,
	showFooter,
	turnActive,
}: {
	items: AssistantTranscriptItem[];
	tools: ChatState["tools"];
	cwd: string;
	waitingToolIds: Set<string>;
	runStartedAt?: number;
	showFooter: boolean;
	turnActive: boolean;
}) {
	const finalItem = items[items.length - 1];
	const text = assistantText(finalItem);
	const failed =
		finalItem.stopReason === "error" ||
		(finalItem.stopReason === "aborted" && finalItem.errorMessage);
	const durationLabel = formatThoughtDuration(finalItem.durationMs);
	const detailItems = items.filter((item) => assistantDetailBlocks(item).length > 0);
	const latestDetailItem = [...detailItems].reverse().find(Boolean);
	const latestDetailBlocks = latestDetailItem
		? assistantDetailBlocks(latestDetailItem)
		: [];
	const liveLabel = latestDetailItem
		? summarizeReasoning(
				latestDetailBlocks,
				tools,
				waitingToolIds,
				turnActive ? false : !latestDetailItem.streaming,
			)
		: null;
	const totalSteps = detailItems.reduce(
		(total, item) => total + reasoningStepCount(assistantDetailBlocks(item)),
		0,
	);
	const waiting = latestDetailBlocks.some(
		(block) => block.type === "toolCall" && waitingToolIds.has(block.id),
	);
	const active =
		turnActive &&
		!!latestDetailItem &&
		hasActiveReasoningWork(latestDetailBlocks, tools, waitingToolIds, false);
	// Idle turns collapse to a plain "Thought"; the live summary only shows while working.
	const detailLabel = liveLabel ? (active || waiting ? liveLabel : "Thought") : null;
	const [open, setOpen] = useState(false);
	const [, force] = useState(0);
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => force((n) => n + 1), 1000);
		return () => clearInterval(timer);
	}, [active]);
	const seconds =
		active && runStartedAt ? Math.floor((Date.now() - runStartedAt) / 1000) : 0;

	return (
		<div className="assistant-msg">
			{detailLabel && (
				<div className="fold reasoning-fold assistant-turn-fold">
					<button
						type="button"
						className={`fold-header assistant-turn-header${active ? " is-live shimmer" : ""}`}
						onClick={() => setOpen(!open)}
						aria-expanded={open}
					>
						<span className="fold-icon">
							{active && !waiting ? (
								<SpinnerIcon size={16} className="fold-icon-rest" />
							) : (
								<Brain size={16} className="fold-icon-rest" />
							)}
							<ChevronDown size={16} className="fold-icon-chevron" />
						</span>
						<span className="label">{detailLabel}</span>
						<span className="tail">
							{waiting ? (
								<span style={{ color: "var(--warning)" }}>Needs approval</span>
							) : active ? (
								<span>{seconds > 2 ? `${seconds}s` : "Working"}</span>
							) : null}
							{totalSteps > 1 ? <span>{totalSteps} steps</span> : null}
						</span>
					</button>
					{open && (
						<div className="reasoning-body assistant-turn-body">
							{detailItems.map((item) => (
								<div key={item.key} className="assistant-turn-step">
									<AssistantStepDetails
										item={item}
										tools={tools}
										cwd={cwd}
										waitingToolIds={waitingToolIds}
									/>
								</div>
							))}
						</div>
					)}
				</div>
			)}
			{text && <Markdown text={text} />}
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
			<button type="button" className="fold-header" onClick={() => setOpen(!open)}>
				<ChevronRight size={14} className={`chev${open ? " open" : ""}`} />
				<SquareTerminal size={14} />
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
				<UserMessage item={item} tabId={tab.tabId} canFork={!tab.isStreaming} />
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
				runStartedAt={tab.runStartedAt}
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
