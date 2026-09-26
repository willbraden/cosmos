import { memo } from "react";

interface DiffLine {
	kind: "add" | "del" | "ctx" | "hunk";
	text: string;
}

export function parseUnifiedPatch(patch: string): DiffLine[] {
	const lines: DiffLine[] = [];
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("Index:") || line.startsWith("====")) continue;
		if (line.startsWith("@@")) lines.push({ kind: "hunk", text: line });
		else if (line.startsWith("+")) lines.push({ kind: "add", text: line.slice(1) });
		else if (line.startsWith("-")) lines.push({ kind: "del", text: line.slice(1) });
		else if (line.startsWith("\\")) continue; // "\ No newline at end of file"
		else lines.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
	}
	while (lines.length && lines[lines.length - 1].kind === "ctx" && lines[lines.length - 1].text === "") lines.pop();
	return lines;
}

export function diffStats(patch: string | undefined, content?: string): { added: number; removed: number } {
	if (!patch) return { added: content ? content.replace(/\n$/, "").split("\n").length : 0, removed: 0 };
	let added = 0;
	let removed = 0;
	for (const line of parseUnifiedPatch(patch)) {
		if (line.kind === "add") added++;
		else if (line.kind === "del") removed++;
	}
	return { added, removed };
}

const GUTTER = { add: "+", del: "−", ctx: " ", hunk: "" } as const;

export const DiffView = memo(function DiffView({ patch, content }: { patch?: string; content?: string }) {
	const lines: DiffLine[] = patch
		? parseUnifiedPatch(patch)
		: (content ?? "")
				.replace(/\n$/, "")
				.split("\n")
				.map((text) => ({ kind: "add" as const, text }));
	return (
		<div className="diff">
			{lines.map((line, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and static
				<div key={index} className={`diff-line ${line.kind}`}>
					<span className="gutter">{GUTTER[line.kind]}</span>
					<span className="text">{line.text || " "}</span>
				</div>
			))}
		</div>
	);
});
