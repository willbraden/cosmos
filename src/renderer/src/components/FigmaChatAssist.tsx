import type { FigmaXcodeAuthStatus, McpServerDefinition } from "@shared/ipc";
import { CircleCheck, ExternalLink, Plug, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../lib/api";
import {
	dismissBlockedFigmaPrompt,
	retryBlockedFigmaPrompt,
} from "../state/actions";
import { type TabState, toast, useStore } from "../state/store";
import { SpinnerIcon } from "./SpinnerIcon";

interface FigmaConnectFlowState {
	status: FigmaXcodeAuthStatus | null;
	phase: "checking" | "waiting" | "importing" | "failed";
	message?: string;
}

function StepRow({ done, title, detail }: { done: boolean; title: string; detail: string }) {
	return (
		<div className="small-text" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
			<span style={{ color: done ? "var(--success)" : "var(--text-muted)" }}>{done ? "✓" : "•"}</span>
			<div>
				<div style={{ color: done ? "var(--text)" : undefined }}>{title}</div>
				<div className="muted">{detail}</div>
			</div>
		</div>
	);
}

function getFigmaServer(servers: McpServerDefinition[]): McpServerDefinition | undefined {
	return servers.find((server) => server.name === "figma" && server.active);
}

function FigmaConnectDialog({
	flow,
	onClose,
	onRefresh,
	onLaunchPlugin,
	onContinue,
}: {
	flow: FigmaConnectFlowState;
	onClose(): void;
	onRefresh(): void;
	onLaunchPlugin(): void;
	onContinue(): void;
}) {
	const status = flow.status;
	const connected = !!status?.piOAuthConnected;
	const waiting = flow.phase === "checking" || flow.phase === "importing";
	const needsXcode = status ? !status.xcodeInstalled : false;
	const needsPlugin = status ? status.xcodeInstalled && !status.xcodeHasFigmaServer : false;
	const waitingForSignIn = status
		? status.xcodeInstalled && status.xcodeHasFigmaServer && !status.xcodeHasBearerToken && !status.piOAuthConnected
		: false;
	return (
		<div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="modal small" role="dialog" aria-label="Connect Figma">
				<div className="login-body">
					<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<Plug size={18} />
						<h3 style={{ flex: 1 }}>Connect Figma</h3>
						<button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
							<X size={16} />
						</button>
					</div>

					{waiting && (
						<div className="working">
							<SpinnerIcon size={14} />
							{flow.phase === "importing" ? " Importing Figma sign-in from Xcode…" : " Checking Xcode and Figma sign-in…"}
						</div>
					)}
					{connected && flow.phase !== "failed" && (
						<div className="notice info" style={{ color: "var(--success)" }}>
							<CircleCheck size={16} /> Figma is connected in Cosmos.
						</div>
					)}
					{flow.phase === "failed" && (
						<div className="notice warning">{flow.message ?? "Could not finish Figma sign-in."}</div>
					)}
					{flow.message && flow.phase !== "failed" && (
						<div className="notice info">{flow.message}</div>
					)}

					<div className="small-text" style={{ whiteSpace: "pre-wrap" }}>
						Cosmos can complete the one-time Figma setup from here, then retry your blocked request automatically.
					</div>

					<div style={{ display: "grid", gap: 10 }}>
						<StepRow
							done={!!status?.xcodeInstalled}
							title="Install Xcode beta"
							detail={needsXcode ? "Install Xcode beta first, then come back here and press Continue." : "Xcode is available on this Mac."}
						/>
						<StepRow
							done={!!status?.xcodeHasFigmaServer}
							title="Add the Figma MCP plugin in Xcode"
							detail={needsPlugin ? "Cosmos can open the Xcode add-plugin flow for you." : "The Figma plugin is already present in Xcode."}
						/>
						<StepRow
							done={!!status?.xcodeHasBearerToken}
							title="Sign in to Figma inside Xcode"
							detail={waitingForSignIn ? "Finish the sign-in in Xcode, then press Continue or wait for Cosmos to detect it." : "Once Xcode has a usable Figma token, Cosmos can import it here."}
						/>
						<StepRow
							done={!!status?.piOAuthConnected}
							title="Verify Figma in a fresh Cosmos session"
							detail={connected ? "Cosmos will verify the tools before retrying your request." : "Cosmos checks a fresh Pi session before continuing."}
						/>
					</div>

					<div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
						<button type="button" className="btn" onClick={onRefresh}>
							<RefreshCw size={12} /> Refresh status
						</button>
						{needsXcode && (
							<button type="button" className="btn" onClick={() => void api.openExternal("https://developer.apple.com/xcode/")}>
								<ExternalLink size={12} /> Get Xcode beta
							</button>
						)}
						{status?.xcodeInstalled && status.xcodeAppPath && (
							<button type="button" className="btn" onClick={() => void api.openPath(status.xcodeAppPath!)}>
								Open Xcode
							</button>
						)}
						{status?.xcodeInstalled && !status.xcodeHasFigmaServer && !connected && (
							<button type="button" className="btn" onClick={onLaunchPlugin}>
								<ExternalLink size={12} /> Add Figma to Xcode
							</button>
						)}
						<button type="button" className="btn primary" onClick={onContinue}>
							{waitingForSignIn ? "I signed in" : "Continue"}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

export function FigmaChatAssist({ tab }: { tab: TabState }) {
	const [flow, setFlow] = useState<FigmaConnectFlowState | null>(null);
	const figmaAssist = tab.figmaAssist;

	const refreshFlow = useCallback(
		async (options?: { launchPlugin?: boolean; importIfReady?: boolean }) => {
			try {
				const status = await api.getFigmaXcodeAuthStatus();
				setFlow((current) =>
					current
						? {
								...current,
								status,
								phase: current.phase === "importing" ? "importing" : "waiting",
							}
						: current,
				);
				if (options?.launchPlugin && status.xcodeInstalled && !status.xcodeHasFigmaServer) {
					await api.launchFigmaXcodePluginInstall();
					setFlow((current) =>
						current
							? {
									...current,
									status,
									phase: "waiting",
									message: "Xcode opened the Figma plugin install flow. Add the plugin there, then sign in.",
								}
							: current,
					);
					return;
				}
				if (options?.importIfReady !== false && status.xcodeHasBearerToken && !status.piOAuthConnected) {
					setFlow((current) =>
						current ? { ...current, status, phase: "importing", message: undefined } : current,
					);
					await api.importXcodeFigmaAuth();
				}
				const overview = await api.getMcpOverview();
				const figma = getFigmaServer(overview.servers);
				if (figma?.sessionAvailable) {
					await retryBlockedFigmaPrompt(tab.tabId);
					toast("info", "Figma is ready. Retrying your request.");
					setFlow(null);
					return;
				}
				setFlow((current) =>
					current
						? {
								...current,
								status,
								phase: "failed",
								message:
									figma?.sessionAvailabilityMessage ??
									(status.xcodeHasBearerToken
										? "Cosmos found a Figma sign-in, but fresh sessions still are not loading the Figma tools."
										: status.xcodeInstalled
											? status.xcodeHasFigmaServer
												? "Finish the Figma sign-in inside Xcode, then press Continue."
												: "Add the Figma plugin in Xcode to continue."
											: "Install Xcode beta to continue."),
							}
						: current,
				);
			} catch (error) {
				setFlow((current) =>
					current
						? { ...current, phase: "failed", message: errorMessage(error) }
						: current,
				);
			}
		},
		[tab.tabId],
	);

	useEffect(() => {
		if (!flow) return;
		if (flow.phase === "failed") return;
		const timer = setInterval(() => {
			void refreshFlow({ importIfReady: true });
		}, 2000);
		return () => clearInterval(timer);
	}, [flow, refreshFlow]);

	if (!figmaAssist) return null;

	return (
		<>
			<div className="welcome-card compact" style={{ margin: "16px 28px 0" }}>
				<Plug size={18} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 2 }} />
				<div>
					<div style={{ fontWeight: 600, marginBottom: 2 }}>Connect Figma to continue</div>
					<div className="small-text muted" style={{ marginBottom: 10 }}>
						{figmaAssist.message}
					</div>
					<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
						<button
							type="button"
							className="btn primary small"
							onClick={() => {
								setFlow({ status: null, phase: "checking" });
								void refreshFlow({ launchPlugin: true, importIfReady: true });
							}}
						>
							Connect Figma
						</button>
						<button type="button" className="btn small" onClick={() => dismissBlockedFigmaPrompt(tab.tabId, true)}>
							Keep editing prompt
						</button>
						<button type="button" className="btn small" onClick={() => useStore.setState({ settingsPane: "mcps" })}>
							Troubleshoot
						</button>
					</div>
				</div>
			</div>
			{flow && (
				<FigmaConnectDialog
					flow={flow}
					onClose={() => setFlow(null)}
					onRefresh={() => void refreshFlow({ importIfReady: false })}
					onLaunchPlugin={() => void refreshFlow({ launchPlugin: true, importIfReady: false })}
					onContinue={() => void refreshFlow({ importIfReady: true })}
				/>
			)}
		</>
	);
}
