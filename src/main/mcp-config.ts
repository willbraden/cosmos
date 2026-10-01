import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { McpConfigOverview, McpServerDefinition } from "../shared/ipc";
import { hasPiOauthConnection } from "./figma-xcode-auth";

function readJsonObject(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
	});
	renameSync(tmp, path);
}

function toObjectMap(
	value: unknown,
): Record<string, Record<string, unknown>> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, Record<string, unknown>> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (entry && typeof entry === "object" && !Array.isArray(entry)) {
			out[key] = entry as Record<string, unknown>;
		}
	}
	return out;
}

function toStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function normalizeServerName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Server name is required");
	if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
		throw new Error(
			"Server names may only use letters, numbers, dot, underscore, and dash.",
		);
	}
	return trimmed;
}

function validateServerConfig(config: unknown): Record<string, unknown> {
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error("Server config must be a JSON object");
	}
	const next = config as Record<string, unknown>;
	if (typeof next.url !== "string" && typeof next.command !== "string") {
		throw new Error("Server config needs either a string 'url' or a string 'command'");
	}
	if (next.args !== undefined && !Array.isArray(next.args)) {
		throw new Error("'args' must be an array when provided");
	}
	if (next.tools !== undefined && !Array.isArray(next.tools)) {
		throw new Error("'tools' must be an array when provided");
	}
	return next;
}

function inferTransport(config: Record<string, unknown>): McpServerDefinition["transport"] {
	if (typeof config.command === "string") return "command";
	if (typeof config.url === "string") return "http";
	if (typeof config.type === "string" && config.type.trim())
		return config.type.trim();
	return "unknown";
}

function oauthTokensPath(agentDir: string, serverName: string): string {
	const hash = createHash("sha256").update(serverName).digest("hex");
	return join(agentDir, "mcp-oauth", `sha256-${hash}`, "tokens.json");
}

async function summarizeServer(
	name: string,
	activeConfig: Record<string, unknown> | undefined,
	personalConfig: Record<string, unknown> | undefined,
	disabled: ReadonlySet<string>,
	agentDir: string,
): Promise<McpServerDefinition> {
	const config = activeConfig ?? personalConfig ?? {};
	const auth = typeof config.auth === "string" ? config.auth : undefined;
	const oauthPath = auth === "oauth" ? oauthTokensPath(agentDir, name) : undefined;
	return {
		name,
		active: !!activeConfig,
		personal: !!personalConfig,
		disabled: disabled.has(name),
		transport: inferTransport(config),
		url: typeof config.url === "string" ? config.url : undefined,
		command: typeof config.command === "string" ? config.command : undefined,
		args: toStringArray(config.args),
		auth,
		tools: toStringArray(config.tools),
		oauthConnected: oauthPath ? await hasPiOauthConnection(agentDir, name) : undefined,
		oauthTokensPath: oauthPath,
		config,
	};
}

export async function getMcpOverview(
	glayvinHome: string | undefined,
	agentDir: string,
): Promise<McpConfigOverview> {
	if (!glayvinHome) {
		return {
			available: false,
			agentDir,
			servers: [],
			notes: [
				"MCP management is available when Cosmos can see a Glayvin home.",
			],
		};
	}

	const mergedConfigPath = join(glayvinHome, ".local", "mcp-config.merged.json");
	const personalConfigPath = join(glayvinHome, ".local", "mcp-config.json");
	const personalDisabledPath = join(glayvinHome, ".local", "disabled.json");
	const adapterConfigPath = join(homedir(), ".config", "mcp", "mcp.json");

	const mergedRoot = readJsonObject(mergedConfigPath) ?? {};
	const personalRoot = readJsonObject(personalConfigPath) ?? {};
	const disabledRoot = readJsonObject(personalDisabledPath) ?? {};

	const mergedServers = toObjectMap(mergedRoot.mcpServers);
	const personalServers = toObjectMap(personalRoot.mcpServers);
	const disabled = new Set(toStringArray(disabledRoot.mcpServers));
	const names = [...new Set([
		...Object.keys(mergedServers),
		...Object.keys(personalServers),
		...disabled,
	])].sort((a, b) => a.localeCompare(b));

	const servers = await Promise.all(
		names.map((name) =>
			summarizeServer(
				name,
				mergedServers[name],
				personalServers[name],
				disabled,
				agentDir,
			),
		),
	);

	const notes: string[] = [];
	if (!existsSync(mergedConfigPath)) {
		notes.push(
			"The merged Glayvin MCP config has not been generated yet. Start a new Glayvin session or run glayvin-setup.",
		);
	}
	if (
		servers.some((server) => server.personal && !server.active && !server.disabled)
	) {
		notes.push(
			"Some personal MCP servers are saved locally but are not active in the merged config yet. Start a new Glayvin session or run glayvin-setup to apply them.",
		);
	}
	if (servers.some((server) => server.disabled)) {
		notes.push(
			"Servers listed as disabled come from your personal .local/disabled.json and will stay out of the merged config.",
		);
	}

	return {
		available: true,
		glayvinHome,
		agentDir,
		mergedConfigPath,
		personalConfigPath,
		personalDisabledPath,
		adapterConfigPath,
		servers,
		notes,
	};
}

export function upsertPersonalMcpServer(
	glayvinHome: string | undefined,
	name: string,
	config: unknown,
): void {
	if (!glayvinHome)
		throw new Error("No Glayvin home is available for MCP configuration");
	const serverName = normalizeServerName(name);
	const serverConfig = validateServerConfig(config);
	const path = join(glayvinHome, ".local", "mcp-config.json");
	const root = readJsonObject(path) ?? {};
	const servers = toObjectMap(root.mcpServers);
	servers[serverName] = serverConfig;
	writeJson(path, { ...root, mcpServers: servers });
}

export function removePersonalMcpServer(
	glayvinHome: string | undefined,
	name: string,
): void {
	if (!glayvinHome)
		throw new Error("No Glayvin home is available for MCP configuration");
	const serverName = normalizeServerName(name);
	const path = join(glayvinHome, ".local", "mcp-config.json");
	const root = readJsonObject(path) ?? {};
	const servers = toObjectMap(root.mcpServers);
	delete servers[serverName];
	writeJson(path, { ...root, mcpServers: servers });
}
