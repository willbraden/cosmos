import type {
	LiveSessionState,
	OpenSessionRequest,
	PiCommand,
	SessionEventBatch,
	SessionExit,
} from "../shared/ipc";

export interface SupervisorConfig {
	nodePath: string;
	launcherPath: string;
	extensionPath: string;
	cliPath: string;
	workspaceRoot: string;
	idleSuspendMinutes: number;
	agentDir?: string;
	glayvinHome?: string;
}

export type SupervisorMethod =
	| { method: "configure"; config: SupervisorConfig }
	| { method: "getSnapshot" }
	| { method: "open"; request: OpenSessionRequest }
	| { method: "command"; tabId: string; command: PiCommand }
	| { method: "respondToUi"; tabId: string; response: Record<string, unknown> }
	| { method: "setVisible"; tabId: string | null }
	| { method: "close"; tabId: string }
	| { method: "restartForNewCredentials" };

export interface SupervisorRequest {
	type: "request";
	id: string;
	payload: SupervisorMethod;
}

export interface SupervisorResponse {
	type: "response";
	id: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

export type SupervisorEvent =
	| { type: "event"; event: "sessionEvents"; data: SessionEventBatch[] }
	| { type: "event"; event: "sessionExit"; data: SessionExit };

export type SupervisorMessage =
	| SupervisorRequest
	| SupervisorResponse
	| SupervisorEvent;

export interface SnapshotResponse extends LiveSessionState {}
