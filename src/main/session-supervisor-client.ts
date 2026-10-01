import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	LiveSessionState,
	OpenSessionRequest,
	PiCommand,
	SessionEventBatch,
	SessionExit,
} from "../shared/ipc";
import { encodeJsonl, JsonlDecoder } from "./pi/jsonl";
import {
	type SnapshotResponse,
	type SupervisorConfig,
	type SupervisorEvent,
	type SupervisorIdentity,
	type SupervisorMessage,
	type SupervisorMethod,
	type SupervisorResponse,
	supervisorPidFilePath,
} from "./session-supervisor-protocol";
import { supervisorBuildId } from "./supervisor-identity";

const HELLO_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

interface Pending {
	resolve(data: unknown): void;
	reject(error: Error): void;
	timer?: NodeJS.Timeout;
}

export interface SupervisorClientOptions {
	socketPath: string;
	nodePath: string;
	sink: {
		events(batches: SessionEventBatch[]): void;
		exit(exit: SessionExit): void;
	};
	log?: {
		info(message: string): void;
		warn(message: string): void;
	};
}

export class SessionSupervisorClient {
	private socket: net.Socket | null = null;
	private connectPromise: Promise<void> | null = null;
	private readonly pending = new Map<string, Pending>();
	private nextId = 0;
	private cachedBuildId: string | null = null;

	constructor(private readonly options: SupervisorClientOptions) {}

	async start(config: SupervisorConfig): Promise<void> {
		await this.configure(config);
	}

	async configure(config: SupervisorConfig): Promise<void> {
		await this.request<void>({ method: "configure", config });
	}

	getSnapshot(): Promise<LiveSessionState> {
		return this.request<SnapshotResponse>({ method: "getSnapshot" });
	}

	open(request: OpenSessionRequest): Promise<void> {
		return this.request<void>({ method: "open", request });
	}

	command<T = unknown>(tabId: string, command: PiCommand): Promise<T> {
		return this.request<T>({ method: "command", tabId, command });
	}

	respondToUi(tabId: string, response: Record<string, unknown>): Promise<void> {
		return this.request<void>({ method: "respondToUi", tabId, response });
	}

	setVisible(tabId: string | null): void {
		void this.request<void>({ method: "setVisible", tabId }).catch(() => undefined);
	}

	close(tabId: string): Promise<void> {
		return this.request<void>({ method: "close", tabId });
	}

	restartForNewCredentials(): Promise<void> {
		return this.request<void>({ method: "restartForNewCredentials" });
	}

	private async request<T = unknown>(payload: SupervisorMethod, timeoutMs?: number): Promise<T> {
		await this.ensureConnected();
		return await this.send<T>(payload, timeoutMs);
	}

	/** Sends on the current socket without re-entering connection setup, for use during the handshake. */
	private send<T = unknown>(payload: SupervisorMethod, timeoutMs?: number): Promise<T> {
		const socket = this.socket;
		if (!socket) return Promise.reject(new Error("Session supervisor is not connected"));
		const id = `sup-${++this.nextId}`;
		return new Promise<T>((resolve, reject) => {
			const pending: Pending = { resolve: resolve as (data: unknown) => void, reject };
			if (timeoutMs !== undefined) {
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`Session supervisor did not answer ${payload.method} in ${timeoutMs}ms`));
				}, timeoutMs);
			}
			this.pending.set(id, pending);
			socket.write(encodeJsonl({ type: "request", id, payload }));
		});
	}

	private async ensureConnected(): Promise<void> {
		if (this.socket && !this.socket.destroyed) return;
		this.connectPromise ??= this.connectOrSpawn().finally(() => {
			this.connectPromise = null;
		});
		await this.connectPromise;
	}

	private async connectOrSpawn(): Promise<void> {
		if (await this.tryConnectExisting()) {
			if (await this.isCurrentBuild()) return;
			await this.replaceStaleSupervisor();
		}
		await this.spawnAndConnect();
		if (!(await this.isCurrentBuild())) {
			this.log.warn(
				"The session supervisor still reports a different build after being replaced; sessions may behave unexpectedly.",
			);
		}
	}

	/** Connects to a supervisor that is already listening. Returns false when none is. */
	private async tryConnectExisting(): Promise<boolean> {
		try {
			await this.connectOnce();
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ECONNREFUSED" && existsSync(this.options.socketPath)) {
				unlinkSync(this.options.socketPath);
			} else if (code !== "ENOENT" && code !== "ECONNREFUSED") {
				throw error;
			}
			return false;
		}
	}

	private async spawnAndConnect(): Promise<void> {
		this.spawnSupervisor();
		const deadline = Date.now() + 15_000;
		let lastError: unknown;
		while (Date.now() < deadline) {
			try {
				await delay(200);
				await this.connectOnce();
				return;
			} catch (error) {
				lastError = error;
			}
		}
		throw new Error(
			`Timed out connecting to the session supervisor${lastError ? `: ${(lastError as Error).message}` : ""}`,
		);
	}

	/**
	 * A supervisor outlives the app on purpose, and every Cosmos install on the machine shares one
	 * socket. Without this check an old build silently hosts sessions for a new one, so code changes
	 * appear to have no effect.
	 */
	private async isCurrentBuild(): Promise<boolean> {
		const expected = this.buildId();
		try {
			const identity = await this.send<SupervisorIdentity>({ method: "hello" }, HELLO_TIMEOUT_MS);
			if (identity?.buildId === expected) return true;
			this.log.warn(
				`Session supervisor pid ${identity?.pid} is build ${identity?.buildId ?? "unknown"} from ${identity?.entryPath ?? "an unknown path"}; this app is build ${expected}. Replacing it.`,
			);
		} catch (error) {
			// Supervisors predating the handshake reject "hello" outright, which is itself the answer.
			this.log.warn(
				`Session supervisor did not identify itself (${(error as Error).message}); assuming it predates build ${expected} and replacing it.`,
			);
		}
		return false;
	}

	private async replaceStaleSupervisor(): Promise<void> {
		const closed = this.waitForClose();
		try {
			await this.send<void>({ method: "shutdown" }, SHUTDOWN_TIMEOUT_MS);
		} catch {
			// Older supervisors do not know "shutdown"; fall through to the pid file.
		}
		await Promise.race([closed, delay(SHUTDOWN_TIMEOUT_MS)]);
		if (this.socket && !this.socket.destroyed) {
			this.terminateByPidFile();
			await Promise.race([closed, delay(SHUTDOWN_TIMEOUT_MS)]);
		}
		this.socket?.destroy();
		this.socket = null;
		if (existsSync(this.options.socketPath)) {
			try {
				unlinkSync(this.options.socketPath);
			} catch {}
		}
	}

	private terminateByPidFile(): void {
		const pidFile = supervisorPidFilePath(this.options.socketPath);
		let pid = 0;
		try {
			pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
		} catch {}
		if (!Number.isInteger(pid) || pid <= 0) {
			this.log.warn(
				`Could not identify the stale session supervisor (no pid file at ${pidFile}). Quit Cosmos everywhere and kill the process listening on ${this.options.socketPath}, then reopen.`,
			);
			return;
		}
		try {
			process.kill(pid, "SIGTERM");
			this.log.info(`Sent SIGTERM to the stale session supervisor (pid ${pid}).`);
		} catch (error) {
			this.log.warn(`Could not stop the stale session supervisor (pid ${pid}): ${(error as Error).message}`);
		}
	}

	private waitForClose(): Promise<void> {
		const socket = this.socket;
		if (!socket || socket.destroyed) return Promise.resolve();
		return new Promise<void>((resolve) => socket.once("close", () => resolve()));
	}

	private buildId(): string {
		this.cachedBuildId ??= supervisorBuildId(supervisorEntryPath());
		return this.cachedBuildId;
	}

	private get log(): NonNullable<SupervisorClientOptions["log"]> {
		return this.options.log ?? consoleLog;
	}

	private connectOnce(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const socket = net.createConnection(this.options.socketPath);
			const decoder = new JsonlDecoder(
				(record) => this.handleMessage(record as SupervisorMessage),
				() => undefined,
			);
			const onError = (error: Error) => {
				socket.removeAllListeners();
				reject(error);
			};
			socket.once("error", onError);
			socket.once("connect", () => {
				socket.removeListener("error", onError);
				this.socket = socket;
				socket.on("data", (chunk: Buffer) => decoder.push(chunk));
				socket.on("close", () => this.handleDisconnect());
				socket.on("error", () => undefined);
				resolve();
			});
		});
	}

	private handleMessage(message: SupervisorMessage): void {
		if (!message || typeof message !== "object") return;
		if (message.type === "response") {
			const response = message as SupervisorResponse;
			const pending = this.pending.get(response.id);
			if (!pending) return;
			this.pending.delete(response.id);
			if (pending.timer) clearTimeout(pending.timer);
			if (response.success) pending.resolve(response.data);
			else pending.reject(new Error(response.error ?? "Supervisor request failed"));
			return;
		}
		const event = message as SupervisorEvent;
		if (event.type !== "event") return;
		if (event.event === "sessionEvents") this.options.sink.events(event.data);
		else if (event.event === "sessionExit") this.options.sink.exit(event.data);
	}

	private handleDisconnect(): void {
		this.socket = null;
		for (const [, pending] of this.pending) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(new Error("Session supervisor disconnected"));
		}
		this.pending.clear();
	}

	private spawnSupervisor(): void {
		const child = spawn(
			this.options.nodePath,
			[supervisorEntryPath(), this.options.socketPath],
			{
				detached: true,
				stdio: "ignore",
				env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
			},
		);
		child.unref();
	}
}

function supervisorEntryPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "session-supervisor.js");
}

const consoleLog = {
	info: (message: string) => console.info(message),
	warn: (message: string) => console.warn(message),
};

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
