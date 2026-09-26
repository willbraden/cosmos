import { randomUUID } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { shell } from "electron";
import log from "electron-log/main";
import type { AuthProgressEvent, AuthPromptRequest, ProviderInfo } from "../shared/ipc";

type AuthPrompt = Parameters<Parameters<ModelRuntime["login"]>[2]["prompt"]>[0];
type AuthEvent = Parameters<Parameters<ModelRuntime["login"]>[2]["notify"]>[0];

interface PendingPrompt {
	resolve(value: string): void;
	reject(error: Error): void;
}

/**
 * Provider sign-in using pi's own ModelRuntime, so credentials land in pi's auth.json
 * exactly as `/login` in the terminal would store them. Prompts and progress are relayed
 * to the renderer; the renderer never sees stored credentials.
 */
export class AuthService {
	private runtime: Promise<ModelRuntime> | null = null;
	private login: AbortController | null = null;
	private readonly prompts = new Map<string, PendingPrompt>();

	constructor(
		private readonly ui: {
			event(event: AuthProgressEvent): void;
			prompt(prompt: AuthPromptRequest): void;
			credentialsChanged(): void;
		},
	) {}

	async listProviders(): Promise<ProviderInfo[]> {
		const runtime = await this.fresh();
		const stored = new Map<string, "oauth" | "api_key">();
		try {
			for (const credential of await runtime.listCredentials({ signal: AbortSignal.timeout(15_000) })) {
				stored.set(credential.providerId, credential.type);
			}
		} catch (error) {
			log.warn("Could not list stored credentials", error);
		}
		return runtime
			.getProviders()
			.map((provider): ProviderInfo => {
				const status = runtime.getProviderAuthStatus(provider.id);
				const oauth = provider.auth.oauth;
				const apiKey = provider.auth.apiKey;
				return {
					id: provider.id,
					name: provider.name,
					oauth: oauth ? { label: oauth.loginLabel ?? `Sign in with ${provider.name}` } : undefined,
					apiKey: apiKey ? { label: apiKey.name, interactive: typeof apiKey.login === "function" } : undefined,
					configured: status.configured,
					source: status.label ?? status.source,
					storedCredential: stored.get(provider.id),
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	async startLogin(providerId: string, method: "oauth" | "api_key"): Promise<void> {
		if (typeof providerId !== "string" || (method !== "oauth" && method !== "api_key")) {
			throw new Error("Invalid login request");
		}
		this.cancelLogin();
		const controller = new AbortController();
		this.login = controller;
		const runtime = await this.fresh();
		if (!runtime.getProvider(providerId)) throw new Error(`Unknown provider: ${providerId}`);

		// Run in the background; completion is reported through auth events.
		void runtime
			.login(providerId, method, {
				signal: controller.signal,
				prompt: (prompt) => this.askRenderer(prompt, controller.signal),
				notify: (event) => this.relay(event),
			})
			.then(() => {
				log.info(`Signed in to ${providerId} (${method})`);
				this.ui.credentialsChanged();
				if (this.login === controller) this.ui.event({ type: "done", providerId });
			})
			.catch((error: unknown) => {
				// A login replaced by a newer one reports nothing; the new flow owns the dialog.
				if (this.login !== controller) return;
				const message = error instanceof Error ? error.message : String(error);
				if (!controller.signal.aborted) log.warn(`Sign-in to ${providerId} failed: ${message}`);
				this.ui.event({ type: "failed", providerId, message: controller.signal.aborted ? "Login cancelled" : message });
			})
			.finally(() => {
				if (this.login === controller) this.login = null;
				this.rejectPrompts(new Error("Login finished"));
			});
	}

	answerPrompt(promptId: string, value: string | null): void {
		const pending = this.prompts.get(promptId);
		if (!pending) return;
		this.prompts.delete(promptId);
		if (typeof value === "string") pending.resolve(value);
		else pending.reject(new Error("Login cancelled"));
	}

	cancelLogin(): void {
		this.login?.abort();
		this.login = null;
		this.rejectPrompts(new Error("Login cancelled"));
	}

	async logout(providerId: string): Promise<void> {
		const runtime = await this.fresh();
		await runtime.logout(providerId, { signal: AbortSignal.timeout(15_000) });
		log.info(`Signed out of ${providerId}`);
		this.ui.credentialsChanged();
	}

	/** Recreate the runtime so auth.json/models.json edits made elsewhere are picked up. */
	private fresh(): Promise<ModelRuntime> {
		this.runtime = ModelRuntime.create();
		return this.runtime;
	}

	private askRenderer(prompt: AuthPrompt, loginSignal: AbortSignal): Promise<string> {
		const promptId = randomUUID();
		const request: AuthPromptRequest =
			prompt.type === "select"
				? { promptId, kind: "select", message: prompt.message, options: [...prompt.options] }
				: { promptId, kind: prompt.type, message: prompt.message, placeholder: prompt.placeholder };
		return new Promise<string>((resolve, reject) => {
			this.prompts.set(promptId, { resolve, reject });
			const abort = () => this.answerPrompt(promptId, null);
			loginSignal.addEventListener("abort", abort, { once: true });
			prompt.signal?.addEventListener("abort", abort, { once: true });
			this.ui.prompt(request);
		});
	}

	private relay(event: AuthEvent): void {
		if (event.type === "auth_url") {
			// Open the provider's page right away, like the terminal flow does.
			if (/^https?:\/\//i.test(event.url)) void shell.openExternal(event.url);
			this.ui.event({ type: "auth_url", url: event.url, instructions: event.instructions });
		} else if (event.type === "device_code") {
			this.ui.event({ type: "device_code", userCode: event.userCode, verificationUri: event.verificationUri });
		} else if (event.type === "info") {
			this.ui.event({ type: "info", message: event.message, links: event.links?.map((link) => ({ ...link })) });
		} else {
			this.ui.event({ type: "progress", message: event.message });
		}
	}

	private rejectPrompts(error: Error): void {
		for (const [, pending] of this.prompts) pending.reject(error);
		this.prompts.clear();
	}
}
