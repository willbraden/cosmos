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

/** Identifies the process answering the socket, so clients can detect a supervisor from another build. */
export interface SupervisorIdentity {
	buildId: string;
	pid: number;
	entryPath: string;
	startedAt: number;
}

export type SupervisorMethod =
	| { method: "hello" }
	| { method: "shutdown" }
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

/** Sidecar file holding the listening supervisor's pid, so a stale one can be replaced if it stops answering. */
export function supervisorPidFilePath(socketPath: string): string {
	return `${socketPath}.pid`;
}
