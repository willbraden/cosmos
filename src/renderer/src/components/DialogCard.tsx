import { MessageCircleQuestion, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { answerDialog, answerPermission, parsePermissionPrompt } from "../state/actions";
import type { DialogRequest } from "../state/store";
import { DiffView } from "./DiffView";
import { EditPreview } from "./ToolCard";

function PermissionBody({ toolName, args }: { toolName: string; args: Record<string, unknown> }) {
	if (toolName === "bash") return <div className="command">{String(args.command ?? "")}</div>;
	if (toolName === "edit") {
		return (
			<div className="tool-body" style={{ marginTop: 0 }}>
				<EditPreview args={args} />
			</div>
		);
	}
	if (toolName === "write") {
		return (
			<div className="tool-body" style={{ marginTop: 0 }}>
				<DiffView content={String(args.content ?? "")} />
			</div>
		);
	}
	return <div className="command">{JSON.stringify(args, null, 2)}</div>;
}

function permissionTitle(toolName: string, args: Record<string, unknown>): string {
	const path = typeof args.path === "string" ? args.path : "this file";
	switch (toolName) {
		case "bash":
			return "Allow pi to run this command?";
		case "edit":
			return `Allow pi to edit ${path}?`;
		case "write":
			return `Allow pi to write ${path}?`;
		default:
			return `Allow pi to use ${toolName}?`;
	}
}

/** The oldest open dialog for a session, rendered above the composer. */
export function DialogCard({ tabId, dialog }: { tabId: string; dialog: DialogRequest }) {
	const permission = "title" in dialog ? parsePermissionPrompt(dialog.title) : null;
	const [value, setValue] = useState(dialog.method === "editor" ? (dialog.prefill ?? "") : "");
	const allowRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		allowRef.current?.focus();
	}, [dialog.id]);

	if (permission) {
		return (
			<div
				className="dialog-card permission"
				onKeyDown={(event) => {
					if (event.key === "Escape") void answerPermission(tabId, dialog.id, "deny");
				}}
			>
				<div className="dialog-card-header">
					<ShieldAlert size={16} style={{ color: "var(--warning)" }} />
					{permissionTitle(permission.toolName, permission.args)}
				</div>
				<div className="dialog-card-body">
					<PermissionBody toolName={permission.toolName} args={permission.args} />
				</div>
				<div className="dialog-card-actions">
					<button ref={allowRef} type="button" className="btn primary" onClick={() => void answerPermission(tabId, dialog.id, "allow")}>
						Allow
					</button>
					<button type="button" className="btn" onClick={() => void answerPermission(tabId, dialog.id, "always")}>
						Always allow {permission.toolName} this session
					</button>
					<span className="spacer" />
					<button type="button" className="btn danger" onClick={() => void answerPermission(tabId, dialog.id, "deny")}>
						Deny <span className="kbd">esc</span>
					</button>
				</div>
			</div>
		);
	}

	const cancel = () => void answerDialog(tabId, dialog.id, { cancelled: true });
	return (
		<div className="dialog-card">
			<div className="dialog-card-header">
				<MessageCircleQuestion size={16} style={{ color: "var(--accent)" }} />
				{dialog.title}
			</div>
			{dialog.method === "confirm" && dialog.message && <div className="dialog-card-body">{dialog.message}</div>}
			<div className="dialog-card-actions">
				{dialog.method === "select" &&
					dialog.options.map((option, index) => (
						<button
							key={option}
							ref={index === 0 ? allowRef : undefined}
							type="button"
							className={`btn${index === 0 ? " primary" : ""}`}
							onClick={() => void answerDialog(tabId, dialog.id, { value: option })}
						>
							{option}
						</button>
					))}
				{dialog.method === "confirm" && (
					<>
						<button ref={allowRef} type="button" className="btn primary" onClick={() => void answerDialog(tabId, dialog.id, { confirmed: true })}>
							Yes
						</button>
						<button type="button" className="btn" onClick={() => void answerDialog(tabId, dialog.id, { confirmed: false })}>
							No
						</button>
					</>
				)}
				{(dialog.method === "input" || dialog.method === "editor") && (
					<form
						style={{ display: "flex", gap: 8, flex: 1, alignItems: "flex-end" }}
						onSubmit={(event) => {
							event.preventDefault();
							void answerDialog(tabId, dialog.id, { value });
						}}
					>
						{dialog.method === "input" ? (
							// biome-ignore lint/a11y/noAutofocus: the dialog exists to collect this input
							<input autoFocus value={value} placeholder={dialog.placeholder} onChange={(e) => setValue(e.target.value)} />
						) : (
							// biome-ignore lint/a11y/noAutofocus: the dialog exists to collect this input
							<textarea autoFocus rows={6} value={value} onChange={(e) => setValue(e.target.value)} />
						)}
						<button type="submit" className="btn primary">
							Submit
						</button>
					</form>
				)}
				<span className="spacer" />
				<button type="button" className="btn" onClick={cancel}>
					Dismiss
				</button>
			</div>
		</div>
	);
}
