import type { AuthProgressEvent, AuthPromptRequest, ProviderInfo } from "@shared/ipc";
import { CircleCheck, ExternalLink, KeyRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { refreshProviders } from "../state/actions";
import { toast } from "../state/store";
import { CopyButton } from "./Markdown";

/**
 * Drives pi's provider sign-in (OAuth or API key). The main process runs pi's own login
 * flow; this dialog shows its progress events and answers its prompts.
 */
export function LoginDialog({ provider, method, onClose }: { provider: ProviderInfo; method: "oauth" | "api_key"; onClose(): void }) {
	const [events, setEvents] = useState<AuthProgressEvent[]>([]);
	const [prompt, setPrompt] = useState<AuthPromptRequest | null>(null);
	const [value, setValue] = useState("");
	const [done, setDone] = useState(false);

	useEffect(() => {
		const offEvent = api.onAuthEvent((event) => {
			if (event.type === "done") {
				setDone(true);
				setPrompt(null);
				void refreshProviders();
				toast("info", `Connected ${provider.name}.`);
				setTimeout(onClose, 900);
				return;
			}
			if (event.type === "failed") {
				setPrompt(null);
				if (event.message !== "Login cancelled") toast("error", `Could not sign in to ${provider.name}: ${event.message}`);
				onClose();
				return;
			}
			setEvents((list) => [...list, event]);
		});
		const offPrompt = api.onAuthPrompt((next) => {
			setPrompt(next);
			setValue("");
		});
		api.login(provider.id, method).catch((error) => {
			toast("error", errorMessage(error));
			onClose();
		});
		return () => {
			offEvent();
			offPrompt();
		};
	}, [provider, method, onClose]);

	const cancel = () => {
		if (!done) api.cancelLogin();
		onClose();
	};

	const answer = (text: string | null) => {
		if (!prompt) return;
		api.answerAuthPrompt(prompt.promptId, text);
		setPrompt(null);
	};

	const authUrl = [...events].reverse().find((e): e is Extract<AuthProgressEvent, { type: "auth_url" }> => e.type === "auth_url");
	const device = [...events].reverse().find((e): e is Extract<AuthProgressEvent, { type: "device_code" }> => e.type === "device_code");
	const latest = [...events].reverse().find((e) => e.type === "progress" || e.type === "info") as
		| Extract<AuthProgressEvent, { type: "progress" | "info" }>
		| undefined;

	return (
		<div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
			<div className="modal small" role="dialog" aria-label={`Sign in to ${provider.name}`}>
				<div className="login-body">
					<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<KeyRound size={18} />
						<h3 style={{ flex: 1 }}>{method === "oauth" ? (provider.oauth?.label ?? `Sign in to ${provider.name}`) : `${provider.name} API key`}</h3>
						<button type="button" className="icon-btn" onClick={cancel} aria-label="Close">
							<X size={16} />
						</button>
					</div>

					{done && (
						<div className="notice info" style={{ color: "var(--success)" }}>
							<CircleCheck size={16} /> Connected.
						</div>
					)}

					{authUrl && !done && (
						<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
							<span className="small-text">{authUrl.instructions ?? "Finish signing in in your browser. This window updates automatically."}</span>
							<div style={{ display: "flex", gap: 8 }}>
								<button type="button" className="btn" onClick={() => void api.openExternal(authUrl.url)}>
									<ExternalLink size={13} /> Open sign-in page again
								</button>
								<CopyButton text={authUrl.url} label="Copy link" />
							</div>
						</div>
					)}

					{device && !done && (
						<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
							<span className="small-text">
								Enter this code at{" "}
								<a href={device.verificationUri} onClick={(e) => (e.preventDefault(), void api.openExternal(device.verificationUri))}>
									{device.verificationUri}
								</a>
							</span>
							<div className="device-code">{device.userCode}</div>
							<CopyButton text={device.userCode} label="Copy code" />
						</div>
					)}

					{latest && !done && (
						<div className="small-text muted" style={{ whiteSpace: "pre-wrap" }}>
							{latest.message}
							{latest.type === "info" &&
								latest.links?.map((link) => (
									<div key={link.url}>
										<a href={link.url} onClick={(e) => (e.preventDefault(), void api.openExternal(link.url))}>
											{link.label ?? link.url}
										</a>
									</div>
								))}
						</div>
					)}

					{prompt && (
						<form
							style={{ display: "flex", flexDirection: "column", gap: 8 }}
							onSubmit={(e) => {
								e.preventDefault();
								answer(value);
							}}
						>
							<label className="small-text" style={{ whiteSpace: "pre-wrap" }}>
								{prompt.message}
							</label>
							{prompt.kind === "select" ? (
								<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
									{prompt.options.map((option) => (
										<button key={option.id} type="button" className="menu-item" style={{ border: "1px solid var(--border)" }} onClick={() => answer(option.id)}>
											<span className="menu-item-stack">
												<span className="name">{option.label}</span>
												{option.description && <span className="desc">{option.description}</span>}
											</span>
										</button>
									))}
								</div>
							) : (
								<>
									<input
										className="text-input"
										// biome-ignore lint/a11y/noAutofocus: the prompt is waiting for this value
										autoFocus
										type={prompt.kind === "secret" ? "password" : "text"}
										placeholder={prompt.placeholder}
										value={value}
										onChange={(e) => setValue(e.target.value)}
										autoComplete="off"
										spellCheck={false}
									/>
									<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
										<button type="button" className="btn" onClick={cancel}>
											Cancel
										</button>
										{/* Plain text prompts may accept blank answers (e.g. Copilot: "blank for github.com"). */}
										<button type="submit" className="btn primary" disabled={prompt.kind !== "text" && !value.trim()}>
											Continue
										</button>
									</div>
								</>
							)}
						</form>
					)}

					{!prompt && !done && !authUrl && !device && !latest && (
						<div className="working">
							<span className="spinner" /> Starting sign-in…
						</div>
					)}

					<div className="small-text muted">Credentials are saved to pi's auth file and shared with the pi CLI.</div>
				</div>
			</div>
		</div>
	);
}
