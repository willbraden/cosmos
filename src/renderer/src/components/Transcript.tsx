import { ArrowDown, Brain, ChevronRight, CircleAlert, History, Info, Pencil, SquareTerminal, TriangleAlert } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatCost, formatTokens } from "../lib/api";
import { forkFromMessage, parsePermissionPrompt } from "../state/actions";
import type { ChatItem, ChatState } from "../state/chat-model";
import type { TabState } from "../state/store";
import { ErrorBoundary } from "./ErrorBoundary";
import { CopyButton, Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

function Thinking({ text, redacted, live }: { text: string; redacted?: boolean; live: boolean }) {
	const [open, setOpen] = useState(false);
	const words = text.trim() ? text.trim().split(/\s+/).length : 0;
	return (
		<div className="fold">
			<button type="button" className="fold-header" onClick={() => setOpen(!open)} aria-expanded={open}>
				<ChevronRight size={14} className={`chev${open ? " open" : ""}`} />
				<Brain size={14} />
				<span className="label">{live ? "Thinking…" : redacted ? "Thinking (redacted)" : "Thought process"}</span>
				{!live && words > 0 && <span className="tail">{words} words</span>}
			</button>
			{open && text && <div className="thinking-body">{text}</div>}
		</div>
	);
}

const UserMessage = memo(function UserMessage({ item, tabId, canFork }: { item: Extract<ChatItem, { kind: "user" }>; tabId: string; canFork: boolean }) {
	return (
		<div className="user-msg">
			{item.images.length > 0 && (
				<div className="user-images">
					{item.images.map((image, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static list
						<img key={index} alt="Attached" src={`data:${image.mimeType};base64,${image.data}`} />
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

const AssistantMessage = memo(function AssistantMessage({
	item,
	tools,
	cwd,
	waitingToolIds,
}: {
	item: Extract<ChatItem, { kind: "assistant" }>;
	tools: ChatState["tools"];
	cwd: string;
	waitingToolIds: Set<string>;
}) {
	const text = item.blocks
		.filter((b) => b.type === "text")
		.map((b) => (b as { text: string }).text)
		.join("\n\n")
		.trim();
	const failed = item.stopReason === "error" || (item.stopReason === "aborted" && item.errorMessage);
	const lastIndex = item.blocks.length - 1;
	return (
		<div className="assistant-msg">
			{item.blocks.map((block, index) => {
				if (block.type === "thinking") {
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional (contentIndex)
						<Thinking key={index} text={block.text} redacted={block.redacted} live={item.streaming && index === lastIndex} />
					);
				}
				if (block.type === "text") {
					if (!block.text.trim()) return null;
					// biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional (contentIndex)
					return <Markdown key={index} text={block.text} />;
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
			{failed && (
				<div className="error-card">
					<strong>{item.stopReason === "aborted" ? "Stopped" : "Error"}:</strong> {item.errorMessage ?? "The request failed."}
				</div>
			)}
			{item.stopReason === "aborted" && !item.errorMessage && <div className="muted small-text">Stopped</div>}
			{/* Only the message that ends a turn gets a footer; tool-call steps stay compact. */}
			{!item.streaming && item.stopReason !== "toolUse" && (text || item.usage) && (
				<div className="assistant-footer">
					{text && (
						<div className="msg-actions">
							<CopyButton text={text} label="Copy response" />
						</div>
					)}
					{item.usage && item.usage.totalTokens > 0 && (
						<span title={`${item.provider}/${item.model}`}>
							{item.model} · {formatTokens(item.usage.totalTokens)} tokens
							{item.usage.cost.total > 0 ? ` · ${formatCost(item.usage.cost.total)}` : ""}
						</span>
					)}
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
					{item.running ? <span className="spinner" /> : item.cancelled ? "cancelled" : `exit ${item.exitCode ?? "?"}`}
				</span>
			</button>
			{open && (
				<div className="tool-body">
					<pre className={`tool-pre${item.exitCode ? " error" : ""}`}>{item.output || (item.running ? "…" : "(no output)")}</pre>
				</div>
			)}
		</div>
	);
}

function Notice({ item }: { item: Extract<ChatItem, { kind: "notice" }> }) {
	const Icon = item.level === "error" ? CircleAlert : item.level === "warning" ? TriangleAlert : Info;
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

function renderItem(item: ChatItem, tab: TabState, waiting: Set<string>) {
	switch (item.kind) {
		case "user":
			return <UserMessage item={item} tabId={tab.tabId} canFork={!tab.isStreaming} />;
		case "assistant":
			return <AssistantMessage item={item} tools={tab.chat.tools} cwd={tab.cwd} waitingToolIds={waiting} />;
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
			return <SummaryCard title="Summary of the branch you left" summary={item.summary} />;
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

function WorkingIndicator({ tab }: { tab: TabState }) {
	const [, force] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => force((n) => n + 1), 1000);
		return () => clearInterval(timer);
	}, []);
	const seconds = tab.runStartedAt ? Math.floor((Date.now() - tab.runStartedAt) / 1000) : 0;
	let label = "Working";
	if (tab.isCompacting) label = "Compacting context";
	else if (tab.retry) {
		const wait = Math.max(0, Math.ceil((tab.retry.at + tab.retry.delayMs - Date.now()) / 1000));
		label = `${tab.retry.message} — retrying (${tab.retry.attempt}/${tab.retry.maxAttempts})${wait ? ` in ${wait}s` : ""}`;
	} else if (tab.dialogs.length) label = "Waiting for you";
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

export function Transcript({ tab, onScrolled }: { tab: TabState; onScrolled(scrolled: boolean): void }) {
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const [showJump, setShowJump] = useState(false);

	const waiting = new Set<string>();
	for (const dialog of tab.dialogs) {
		const payload = "title" in dialog ? parsePermissionPrompt(dialog.title) : null;
		if (payload) waiting.add(payload.toolCallId);
	}

	const scrollToBottom = useCallback((smooth = false) => {
		const el = scroller.current;
		if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
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
	return (
		<>
			<div className="transcript" ref={scroller} onScroll={onScroll}>
				<div className="transcript-inner">
					{tab.chat.items.map((item) => (
						<ErrorBoundary key={item.key} inline>
							{renderItem(item, tab, waiting)}
						</ErrorBoundary>
					))}
					{busy && <WorkingIndicator tab={tab} />}
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
