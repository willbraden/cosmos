import type { AppInfo } from "@shared/ipc";
import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { toast, useStore } from "../state/store";

const FEEDBACK_ISSUE_URL = "https://github.com/wbraden/cosmos-gui/issues/new";

function issueTitle(feedback: string): string {
	const firstLine = feedback
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (!firstLine) return "Feedback for Cosmos";
	return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function buildIssueUrl(feedback: string, appInfo?: AppInfo): string {
	const metadata = [
		"",
		"---",
		"App info",
		`- Cosmos version: ${appInfo?.appVersion ?? "unknown"}`,
		`- pi version: ${appInfo?.piVersion ?? "unknown"}`,
		`- Electron version: ${appInfo?.electronVersion ?? "unknown"}`,
		`- Platform: ${appInfo?.platform ?? "unknown"}`,
	].join("\n");
	const url = new URL(FEEDBACK_ISSUE_URL);
	url.searchParams.set("title", issueTitle(feedback));
	url.searchParams.set("body", `${feedback.trim()}\n${metadata}`);
	return url.toString();
}

export function FeedbackModal() {
	const appInfo = useStore((s) => s.appInfo);
	const close = useCallback(() => useStore.setState({ feedbackOpen: false }), []);
	const [value, setValue] = useState("");
	const canShare = value.trim().length > 0;
	const shareUrl = useMemo(() => buildIssueUrl(value, appInfo), [value, appInfo]);
	const shareFeedback = useCallback(async () => {
		if (!canShare) return;
		try {
			await api.openExternal(shareUrl);
			toast("info", "Opened a prefilled GitHub issue in your browser.");
			close();
		} catch (error) {
			toast("error", error instanceof Error ? error.message : String(error));
		}
	}, [canShare, close, shareUrl]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") close();
			if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canShare) {
				event.preventDefault();
				void shareFeedback();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [canShare, close, shareFeedback]);

	return (
		<div
			className="modal-backdrop"
			onMouseDown={(event) => event.target === event.currentTarget && close()}
		>
			<div
				className="modal small feedback-modal"
				role="dialog"
				aria-label="Report a bug or suggest a feature"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<div className="feedback-modal-header">
					<div>
						<h2>Report a bug or suggest a feature</h2>
						<p>
							Share what's working, what's broken, or what you'd like Cosmos to do
							next.
						</p>
					</div>
					<button
						type="button"
						className="icon-btn"
						title="Close"
						onClick={close}
					>
						<X size={16} />
					</button>
				</div>
				<form
					className="feedback-modal-body"
					onSubmit={(event) => {
						event.preventDefault();
						void shareFeedback();
					}}
				>
					<textarea
						autoFocus
						rows={7}
						value={value}
						placeholder="What feedback would you like to share?"
						onChange={(event) => setValue(event.target.value)}
					/>
					<div className="feedback-modal-note">
						This opens a prefilled public GitHub issue in your browser and includes
						basic app version details.
					</div>
					<div className="feedback-modal-actions">
						<button type="button" className="btn" onClick={close}>
							Cancel
						</button>
						<button type="submit" className="btn primary" disabled={!canShare}>
							Share feedback
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
