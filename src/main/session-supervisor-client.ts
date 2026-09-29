import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
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
	type SupervisorMessage,
	type SupervisorMethod,
	type SupervisorResponse,
} from "./session-supervisor-protocol";

interface Pending {
	resolve(data: unknown): void;
	reject(error: Error): void;
}

export interface SupervisorClientOptions {
	socketPath: string;
	nodePath: string;
	sink: {
		events(batches: SessionEventBatch[]): void;
		exit(exit: SessionExit): void;
	};
}

export class SessionSupervisorClient {
	private socket: net.Socket | null = null;
	private connectPromise: Promise<void> | null = null;
	private readonly pending = new Map<string, Pending>();
	private nextId = 0;

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

	private async request<T = unknown>(payload: SupervisorMethod): Promise<T> {
		await this.ensureConnected();
		const socket = this.socket;
		if (!socket) throw new Error("Session supervisor is not connected");
		const id = `sup-${++this.nextId}`;
		return await new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject });
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
		try {
			await this.connectOnce();
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ECONNREFUSED" && existsSync(this.options.socketPath)) {
				unlinkSync(this.options.socketPath);
			} else if (code !== "ENOENT" && code !== "ECONNREFUSED") {
				throw error;
			}
		}
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
