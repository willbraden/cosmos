import type { ImageContent, TextContent, ToolResultPayload } from "@shared/pi-types";
import {
	Ban,
	ChevronRight,
	CircleAlert,
	CircleCheck,
	ExternalLink,
	FilePen,
	FilePlus,
	FileText,
	FolderSearch,
	ListTree,
	Search,
	SquareTerminal,
	Wrench,
} from "lucide-react";
import { memo, useState } from "react";
import { api } from "../lib/api";
import type { Block, ToolRun } from "../state/chat-model";
import { DiffView, diffStats } from "./DiffView";
import { CopyButton } from "./Markdown";

type ToolCallBlock = Extract<Block, { type: "toolCall" }>;

function resultText(result: ToolResultPayload | undefined): string {
	if (!result) return "";
	return result.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function resultImages(result: ToolResultPayload | undefined): ImageContent[] {
	return result?.content.filter((c): c is ImageContent => c.type === "image") ?? [];
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function resolvePath(cwd: string, path: string): string {
	if (path.startsWith("/")) return path;
	if (path.startsWith("~/")) return path; // left for the editor to expand
	return `${cwd.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`;
}

interface Summary {
	icon: typeof Wrench;
	label: React.ReactNode;
	detail?: string;
}

function summarize(block: ToolCallBlock): Summary {
	const args = block.args;
	switch (block.name) {
		case "bash":
			return { icon: SquareTerminal, label: <code>{str(args.command).split("\n")[0] || "…"}</code> };
		case "read": {
			const range = typeof args.offset === "number" ? ` (from line ${args.offset})` : "";
			return { icon: FileText, label: <>Read <code>{str(args.path) || "…"}</code>{range}</> };
		}
		case "edit":
			return { icon: FilePen, label: <>Edit <code>{str(args.path) || "…"}</code></> };
		case "write":
			return { icon: FilePlus, label: <>Write <code>{str(args.path) || "…"}</code></> };
		case "grep":
			return { icon: Search, label: <>Search for <code>{str(args.pattern) || "…"}</code>{args.path ? <> in <code>{str(args.path)}</code></> : null}</> };
		case "find":
			return { icon: FolderSearch, label: <>Find <code>{str(args.pattern) || "…"}</code></> };
		case "ls":
			return { icon: ListTree, label: <>List <code>{str(args.path) || "."}</code></> };
		default:
			return { icon: Wrench, label: <>{block.name}</> };
	}
}

export const ToolCard = memo(function ToolCard({
	block,
	run,
	cwd,
	settled,
	awaitingPermission,
}: {
	block: ToolCallBlock;
	run: ToolRun | undefined;
	cwd: string;
	/** The assistant message is final: a call with no run by now was never executed. */
	settled: boolean;
	awaitingPermission: boolean;
}) {
	const isFileChange = block.name === "edit" || block.name === "write";
	const [open, setOpen] = useState(false);
	const summary = summarize(block);
	const Icon = summary.icon;
	// pi reports execution start before the permission hook resolves, so approval wins.
	const status = awaitingPermission ? "waiting" : (run?.status ?? (settled && block.complete ? "skipped" : "pending"));
	const output = resultText(run?.result ?? run?.partial);
	const patch = (run?.result?.details as { patch?: string } | undefined)?.patch;
	const writeContent = block.name === "write" ? str(block.args.content) : undefined;
	const stats = isFileChange && status === "done" ? diffStats(patch, writeContent) : null;

	return (
		<div className="fold">
			<button type="button" className="fold-header" onClick={() => setOpen(!open)} aria-expanded={open}>
				<ChevronRight size={14} className={`chev${open ? " open" : ""}`} />
				<Icon size={14} style={{ flexShrink: 0 }} />
				<span className="label">{summary.label}</span>
				<span className="tail">
					{stats && (
						<span>
							<span className="stat-add">+{stats.added}</span> <span className="stat-del">−{stats.removed}</span>
						</span>
					)}
					{status === "running" || status === "pending" ? <span className="spinner" /> : null}
					{status === "waiting" && <span style={{ color: "var(--warning)" }}>Needs approval</span>}
					{status === "done" && <CircleCheck size={14} className="tool-status-icon ok" />}
					{status === "error" && <CircleAlert size={14} className="tool-status-icon err" />}
					{status === "skipped" && (
						<span title="This tool call did not run">
							<Ban size={13} />
						</span>
					)}
				</span>
			</button>
			{open && (
				<div className="tool-body">
					{block.name === "bash" && (
						<>
							<div className="tool-section-label">Command</div>
							<pre className="tool-pre">{str(block.args.command)}</pre>
						</>
					)}
					{block.name === "edit" && (patch ? <DiffView patch={patch} /> : <EditPreview args={block.args} />)}
					{block.name === "write" && <DiffView content={writeContent} />}
					{!isFileChange && block.name !== "bash" && !["read", "grep", "find", "ls"].includes(block.name) && (
						<>
							<div className="tool-section-label">Input</div>
							<pre className="tool-pre">{JSON.stringify(block.args, null, 2)}</pre>
						</>
					)}
					{(!isFileChange || status === "error") && (output || status === "running") && (
						<>
							<div className="tool-section-label">{status === "error" ? "Error" : "Output"}</div>
							<pre className={`tool-pre${status === "error" ? " error" : ""}`}>{output || "…"}</pre>
						</>
					)}
					{resultImages(run?.result).map((image, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static list
						<img key={index} alt="Tool output" src={`data:${image.mimeType};base64,${image.data}`} style={{ maxWidth: "100%", display: "block", padding: 8 }} />
					))}
					<div className="tool-footer">
						{output && <CopyButton text={output} label="Copy output" />}
						{(isFileChange || block.name === "read") && str(block.args.path) && (
							<button type="button" className="btn small" onClick={() => void api.openInEditor(resolvePath(cwd, str(block.args.path)))}>
								<ExternalLink size={12} /> Open in editor
							</button>
						)}
					</div>
				</div>
			)}
		</div>
	);
});

/** Before an edit runs there is no patch yet; show the requested replacements. */
export function EditPreview({ args }: { args: Record<string, unknown> }) {
	const edits = Array.isArray(args.edits) ? (args.edits as { oldText?: string; newText?: string }[]) : [];
	const patch = edits
		.map((edit) => {
			const minus = (edit.oldText ?? "").split("\n").map((l) => `-${l}`);
			const plus = (edit.newText ?? "").split("\n").map((l) => `+${l}`);
			return ["@@ requested edit @@", ...minus, ...plus].join("\n");
		})
		.join("\n");
	return <DiffView patch={patch} />;
}
