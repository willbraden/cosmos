import {
	ArrowDown,
	Brain,
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

function ReasoningFold({
	blocks,
	tools,
	cwd,
	settled,
	waitingToolIds,
	live,
	runStartedAt,
}: {
	blocks: ReasoningBlock[];
	tools: ChatState["tools"];
	cwd: string;
	settled: boolean;
	waitingToolIds: Set<string>;
	live: boolean;
	runStartedAt?: number;
}) {
	const [open, setOpen] = useState(false);
	const [, force] = useState(0);
	useEffect(() => {
		if (!live) return;
		const timer = setInterval(() => force((n) => n + 1), 1000);
		return () => clearInterval(timer);
	}, [live]);
	const label = summarizeReasoning(blocks, tools, waitingToolIds, settled);
	const steps = reasoningStepCount(blocks);
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
	const active = live && hasActiveReasoningWork(blocks, tools, waitingToolIds, settled);
	const seconds =
		active && runStartedAt ? Math.floor((Date.now() - runStartedAt) / 1000) : 0;
	return (
		<div className="fold reasoning-fold">
			<button
				type="button"
				className={`fold-header${active ? " active-thread" : ""}`}
				onClick={() => setOpen(!open)}
				aria-expanded={open}
			>
				<span className="fold-header-main">
					<ChevronRight size={14} className={`chev${open ? " open" : ""}`} />
					<Brain size={14} />
					<span className="label">{label}</span>
					<span className="tail">
						{waiting && !active ? (
							<span style={{ color: "var(--warning)" }}>Needs approval</span>
						) : null}
						{running && !active ? <span className="spinner" /> : null}
						{steps > 1 ? <span>{steps} steps</span> : null}
					</span>
				</span>
				{active && (
					<span className="fold-header-sub">
						{waiting ? (
							<span style={{ color: "var(--warning)" }}>Needs approval</span>
						) : (
							<>
								<span className="dots inline">
									<span />
									<span />
									<span />
								</span>
								<span>Working{seconds > 2 ? ` · ${seconds}s` : ""}</span>
							</>
						)}
					</span>
				)}
			</button>
			{open && (
				<div className="reasoning-body">
					{blocks.map((block, index) => {
						if (block.type === "thinking") {
							return (
								<ReasoningNote
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
								settled={settled}
								awaitingPermission={waitingToolIds.has(block.id)}
							/>
						);
					})}
				</div>
			)}
		</div>
	);
}

function groupDetailBlocks(
	blocks: Block[],
): Array<
	| { key: string; kind: "text"; text: string }
	| { key: string; kind: "detail"; blocks: ReasoningBlock[]; live: boolean }
> {
	const groups: Array<
		| { key: string; kind: "text"; text: string }
		| { key: string; kind: "detail"; blocks: ReasoningBlock[]; live: boolean }
	> = [];
	let detailStart = -1;
	let detailBlocks: ReasoningBlock[] = [];
	const flushDetails = (lastIndex: number) => {
		if (detailBlocks.length === 0) return;
		groups.push({
			key: `detail:${detailStart}`,
			kind: "detail",
			blocks: detailBlocks,
			live: lastIndex === blocks.length - 1,
		});
		detailStart = -1;
		detailBlocks = [];
	};
	blocks.forEach((block, index) => {
		if (block.type === "text") {
			flushDetails(index - 1);
			if (block.text.trim())
				groups.push({ key: `text:${index}`, kind: "text", text: block.text });
			return;
		}
		if (detailStart === -1) detailStart = index;
		detailBlocks = [...detailBlocks, block];
	});
	flushDetails(blocks.length - 1);
	return groups;
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

const AssistantMessage = memo(function AssistantMessage({
	item,
	tools,
	cwd,
	waitingToolIds,
	runStartedAt,
	showFooter,
}: {
	item: Extract<ChatItem, { kind: "assistant" }>;
	tools: ChatState["tools"];
	cwd: string;
	waitingToolIds: Set<string>;
	runStartedAt?: number;
	showFooter: boolean;
}) {
	const text = item.blocks
		.filter((b) => b.type === "text")
		.map((b) => (b as { text: string }).text)
		.join("\n\n")
		.trim();
	const failed =
		item.stopReason === "error" ||
		(item.stopReason === "aborted" && item.errorMessage);
	const groups = useMemo(() => groupDetailBlocks(item.blocks), [item.blocks]);
	const durationLabel = formatThoughtDuration(item.durationMs);
	return (
		<div className="assistant-msg">
			{groups.map((group) => {
				if (group.kind === "text")
					return <Markdown key={group.key} text={group.text} />;
				return (
					<ReasoningFold
						key={group.key}
						blocks={group.blocks}
						tools={tools}
						cwd={cwd}
						settled={!item.streaming}
						waitingToolIds={waitingToolIds}
						live={item.streaming && group.live}
						runStartedAt={runStartedAt}
					/>
				);
			})}
			{failed && (
				<div className="error-card">
					<strong>{item.stopReason === "aborted" ? "Stopped" : "Error"}:</strong>{" "}
					{item.errorMessage ?? "The request failed."}
				</div>
			)}
			{item.stopReason === "aborted" && !item.errorMessage && (
				<div className="muted small-text">Stopped</div>
			)}
			{showFooter &&
				!item.streaming &&
				item.stopReason !== "toolUse" &&
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

function renderItem(
	item: ChatItem,
	tab: TabState,
	waiting: Set<string>,
	latestAssistantKey?: string,
) {
	switch (item.kind) {
		case "user":
			if (isHiddenUserPromptText(item.text)) return null;
			return (
				<UserMessage item={item} tabId={tab.tabId} canFork={!tab.isStreaming} />
			);
		case "assistant":
			return (
				<AssistantMessage
					item={item}
					tools={tab.chat.tools}
					cwd={tab.cwd}
					waitingToolIds={waiting}
					runStartedAt={tab.runStartedAt}
					showFooter={item.key === latestAssistantKey}
				/>
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

function hasInlineActiveIndicator(
	tab: TabState,
	waitingToolIds: Set<string>,
): boolean {
	for (let index = tab.chat.items.length - 1; index >= 0; index--) {
		const item = tab.chat.items[index];
		if (item.kind === "assistant") {
			if (!item.streaming) return false;
			return groupDetailBlocks(item.blocks).some(
				(group) =>
					group.kind === "detail" &&
					group.live &&
					hasActiveReasoningWork(
						group.blocks,
						tab.chat.tools,
						waitingToolIds,
						false,
					),
			);
		}
		if (item.kind === "bash") return item.running;
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
			<span className="dots">
				<span />
				<span />
				<span />
			</span>
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

	const busy = tab.isStreaming || tab.isCompacting;
	const showBottomWorkingIndicator = !hasInlineActiveIndicator(tab, waiting);
	const latestAssistantKey = [...tab.chat.items]
		.reverse()
		.find(
			(item): item is Extract<ChatItem, { kind: "assistant" }> =>
				item.kind === "assistant",
		)?.key;
	return (
		<>
			<div className="transcript" ref={scroller} onScroll={onScroll}>
				<div className="transcript-inner">
					{tab.chat.items.map((item) => (
						<ErrorBoundary key={item.key} inline>
							{renderItem(item, tab, waiting, latestAssistantKey)}
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
