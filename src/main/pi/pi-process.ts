import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { encodeJsonl, JsonlDecoder } from "./jsonl";

export interface PiLaunchSpec {
	/** Executable to spawn (Electron itself, running as Node). */
	command: string;
	/** Full argument list, including the script and `--mode rpc`. */
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export interface PiResponse {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

export class PiCommandError extends Error {
	constructor(
		readonly command: string,
		message: string,
	) {
		super(message);
		this.name = "PiCommandError";
	}
}

interface Pending {
	resolve(data: unknown): void;
	reject(error: Error): void;
	timer?: NodeJS.Timeout;
}

const STDERR_LIMIT = 16_000;

/**
 * One `pi --mode rpc` child process.
 *
 * Emits:
 *   "record"  every stdout record that is not a command response (events, extension UI)
 *   "exit"    (code, signal, stderrTail) once the process is gone
 */
export class PiProcess extends EventEmitter {
	private child: ChildProcessWithoutNullStreams | null = null;
	private readonly pending = new Map<string, Pending>();
	private nextId = 0;
	private stderrTail = "";
	private exited = false;

	constructor(private readonly spec: PiLaunchSpec) {
		super();
	}

	get running(): boolean {
		return this.child !== null && !this.exited;
	}

	/** The last ~16KB of stderr, for diagnostics. */
	get recentStderr(): string {
		return this.stderrTail;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	start(): void {
		if (this.child) throw new Error("pi process already started");
		const child = spawn(this.spec.command, this.spec.args, {
			cwd: this.spec.cwd,
			env: this.spec.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;

		const decoder = new JsonlDecoder(
			(record) => this.handleRecord(record),
			(line) => this.appendStderr(`[cosmos] unparseable stdout line: ${line.slice(0, 500)}\n`),
		);
		child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
		child.stdout.on("end", () => decoder.end());
		child.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk.toString("utf8")));
		child.stdin.on("error", () => {
			// EPIPE after the child died; the exit handler reports the failure.
		});

		child.on("error", (error) => this.finish(null, null, `Failed to start pi: ${error.message}`));
		child.on("exit", (code, signal) => this.finish(code, signal));
	}

	/** Send a command and resolve with its response `data`. Rejects on `success: false`. */
	request<T = unknown>(command: { type: string; [key: string]: unknown }, timeoutMs?: number): Promise<T> {
		if (!this.child || this.exited) {
			return Promise.reject(new PiCommandError(command.type, "pi process is not running"));
		}
		const id = `desk-${++this.nextId}`;
		return new Promise<T>((resolve, reject) => {
			const entry: Pending = { resolve: resolve as (data: unknown) => void, reject };
			if (timeoutMs) {
				entry.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new PiCommandError(command.type, `pi did not answer "${command.type}" within ${timeoutMs}ms`));
				}, timeoutMs);
			}
			this.pending.set(id, entry);
			this.write({ ...command, id });
		});
	}

	/** Write a record that has no response (e.g. extension_ui_response). */
	send(record: Record<string, unknown>): void {
		if (!this.child || this.exited) throw new Error("pi process is not running");
		this.write(record);
	}

	/**
	 * Orderly shutdown: closing stdin asks pi to dispose and exit. Escalate to signals if
	 * it does not exit in time.
	 */
	async stop(graceMs = 3000): Promise<void> {
		const child = this.child;
		if (!child || this.exited) return;
		const exited = new Promise<void>((resolve) => this.once("exit", () => resolve()));
		child.stdin.end();
		const term = setTimeout(() => child.kill("SIGTERM"), graceMs);
		const kill = setTimeout(() => child.kill("SIGKILL"), graceMs * 2);
		await exited;
		clearTimeout(term);
		clearTimeout(kill);
	}

	private write(record: Record<string, unknown>): void {
		this.child?.stdin.write(encodeJsonl(record));
	}

	private handleRecord(record: unknown): void {
		if (!record || typeof record !== "object") return;
		const typed = record as { type?: unknown; id?: unknown };
		if (typed.type === "response") {
			const response = record as PiResponse;
			const pending = response.id ? this.pending.get(response.id) : undefined;
			if (pending && response.id) {
				this.pending.delete(response.id);
				if (pending.timer) clearTimeout(pending.timer);
				if (response.success) pending.resolve(response.data);
				else pending.reject(new PiCommandError(response.command, response.error ?? "Command failed"));
				return;
			}
			// Uncorrelated responses (e.g. parse errors) are diagnostics, not events.
			if (!response.success) this.appendStderr(`[cosmos] ${response.command}: ${response.error}\n`);
			return;
		}
		this.emit("record", record);
	}

	private appendStderr(text: string): void {
		this.stderrTail = (this.stderrTail + text).slice(-STDERR_LIMIT);
		this.emit("stderr", text);
	}

	private finish(code: number | null, signal: NodeJS.Signals | null, reason?: string): void {
		if (this.exited) return;
		this.exited = true;
		if (reason) this.appendStderr(`${reason}\n`);
		const message = reason ?? `pi exited (${signal ?? `code ${code}`})`;
		for (const [, pending] of this.pending) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(new Error(message));
		}
		this.pending.clear();
		this.emit("exit", code, signal, this.stderrTail);
	}
}
