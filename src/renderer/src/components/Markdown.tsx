import { Check, Copy } from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api";

function textOf(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (node && typeof node === "object" && "props" in node) {
		return textOf((node as { props: { children?: ReactNode } }).props.children);
	}
	return "";
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="icon-btn"
			title={copied ? "Copied" : label}
			aria-label={label}
			onClick={() => {
				void api.copyText(text);
				setCopied(true);
				setTimeout(() => setCopied(false), 1400);
			}}
		>
			{copied ? <Check size={14} /> : <Copy size={14} />}
		</button>
	);
}

const components: Components = {
	pre({ children }) {
		const child = Array.isArray(children) ? children[0] : children;
		const className = (child as { props?: { className?: string } })?.props?.className ?? "";
		const language = /language-([\w+-]+)/.exec(className)?.[1] ?? "";
		return (
			<div className="code-block">
				<div className="code-block-header">
					<span>{language || "code"}</span>
					<CopyButton text={textOf(children).replace(/\n$/, "")} label="Copy code" />
				</div>
				<pre>{children}</pre>
			</div>
		);
	},
	a({ href, children }) {
		return (
			<a
				href={href}
				onClick={(event) => {
					event.preventDefault();
					if (href && /^https?:\/\//i.test(href)) void api.openExternal(href);
				}}
				title={href}
			>
				{children}
			</a>
		);
	},
	img({ src, alt }) {
		// Remote images are not loaded (CSP); show the alt text instead.
		return <span className="muted">[image: {alt || src}]</span>;
	},
};

const remarkPlugins = [remarkGfm];
const rehypePlugins = [[rehypeHighlight, { detect: false, ignoreMissing: true }]] as never;

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
	return (
		<div className={`md${streaming ? " streaming-caret" : ""}`}>
			<ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
				{text}
			</ReactMarkdown>
		</div>
	);
});
