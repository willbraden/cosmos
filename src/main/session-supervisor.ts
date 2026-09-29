import { mkdirSync, unlinkSync } from "node:fs";
import net from "node:net";
import { dirname } from "node:path";
import type {
	LiveSessionState,
	OpenSessionRequest,
	PiCommand,
	SessionEventBatch,
	SessionExit,
} from "../shared/ipc";
import { encodeJsonl, JsonlDecoder } from "./pi/jsonl";
import { SessionHost } from "./pi/session-host";
import { runtimeLog as log } from "./runtime-log";
import { type SupervisorConfig, type SupervisorMessage, type SupervisorRequest } from "./session-supervisor-protocol";
import { resolveShellEnv } from "./shell-env";

const socketPath = process.argv[2];
if (!socketPath) throw new Error("Session supervisor requires a socket path argument");

const clients = new Set<net.Socket>();
let shuttingDown = false;
let runtime: SupervisorConfig = {
	nodePath: process.execPath,
	launcherPath: "",
	extensionPath: "",
	cliPath: "",
	workspaceRoot: process.cwd(),
	idleSuspendMinutes: 15,
};

const host = new SessionHost(
	{
		get nodePath() {
			return runtime.nodePath;
		},
		get launcherPath() {
			return runtime.launcherPath;
		},
		cliPath: () => runtime.cliPath,
		get extensionPath() {
			return runtime.extensionPath;
		},
		env: resolveShellEnv,
		workspaceRoot: () => runtime.workspaceRoot,
		idleSuspendMinutes: () => runtime.idleSuspendMinutes,
	},
	{
		events: (batches: SessionEventBatch[]) => broadcast({ type: "event", event: "sessionEvents", data: batches }),
		exit: (exit: SessionExit) => broadcast({ type: "event", event: "sessionExit", data: exit }),
	},
);

const server = net.createServer((socket) => {
	clients.add(socket);
	const decoder = new JsonlDecoder(
		(record) => void handleMessage(socket, record as SupervisorMessage),
		(line, error) => log.warn("Invalid supervisor message", line, error),
	);
	socket.on("data", (chunk: Buffer) => decoder.push(chunk));
	socket.on("close", () => clients.delete(socket));
	socket.on("error", (error) => log.warn("Supervisor client socket error", error));
});

server.on("error", (error) => {
	log.error("Session supervisor server error", error);
	void shutdown(1);
});

mkdirSync(dirname(socketPath), { recursive: true });
try {
	unlinkSync(socketPath);
} catch {}
server.listen(socketPath, () => {
	log.info(`Session supervisor listening on ${socketPath}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		void shutdown(0);
	});
}
process.on("disconnect", () => {
	if (clients.size === 0) void shutdown(0);
});

async function handleMessage(socket: net.Socket, message: SupervisorMessage): Promise<void> {
	if (!message || typeof message !== "object" || message.type !== "request") return;
	const request = message as SupervisorRequest;
	try {
		const data = await routeRequest(request);
		socket.write(encodeJsonl({ type: "response", id: request.id, success: true, data }));
	} catch (error) {
		socket.write(
			encodeJsonl({
				type: "response",
				id: request.id,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}
}

async function routeRequest(request: SupervisorRequest): Promise<unknown> {
	switch (request.payload.method) {
		case "configure":
			runtime = { ...request.payload.config };
			applyRuntimeEnv(runtime);
			return null;
		case "getSnapshot":
			return host.snapshot() satisfies LiveSessionState;
		case "open":
			await ensureConfigured();
			await host.open(request.payload.request as OpenSessionRequest);
			return null;
		case "command":
			await ensureConfigured();
			return await host.command(
				request.payload.tabId,
				request.payload.command as PiCommand,
			);
		case "respondToUi":
			host.respondToUi(request.payload.tabId, request.payload.response);
			return null;
		case "setVisible":
			host.setVisible(request.payload.tabId);
			return null;
		case "close":
			await host.close(request.payload.tabId);
			return null;
		case "restartForNewCredentials":
			host.restartForNewCredentials();
			return null;
		default:
			throw new Error("Unknown session supervisor request");
	}
}

function applyRuntimeEnv(config: SupervisorConfig): void {
	if (config.agentDir) process.env.PI_CODING_AGENT_DIR = config.agentDir;
	else delete process.env.PI_CODING_AGENT_DIR;
	if (config.glayvinHome) process.env.GLAYVIN_HOME = config.glayvinHome;
	else delete process.env.GLAYVIN_HOME;
}

async function ensureConfigured(): Promise<void> {
	if (runtime.launcherPath && runtime.extensionPath && runtime.cliPath && runtime.nodePath) return;
	throw new Error("Session supervisor is not configured yet");
}

function broadcast(message: SupervisorMessage): void {
	const encoded = encodeJsonl(message);
	for (const client of clients) {
		if (!client.destroyed) client.write(encoded);
	}
}

async function shutdown(code: number): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	server.close();
	for (const client of clients) client.destroy();
	try {
		await host.dispose();
	} catch (error) {
		log.error("Error disposing session supervisor", error);
	}
	try {
		unlinkSync(socketPath);
	} catch {}
	process.exit(code);
}
