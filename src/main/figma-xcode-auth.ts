import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const FIGMA_SERVER_NAME = "figma";
const FIGMA_SERVER_URL = "https://mcp.figma.com/mcp";
const FIGMA_CLIENT_ID = "UpT6gWrT9oYPgGy75V8ae8";
const PI_MCP_KEYCHAIN_SERVICE = "pi-mcp-adapter.oauth";

export const FIGMA_XCODE_PLUGIN_URL =
	"xcode://agent-plugin-clone?repo=https://github.com/figma/mcp-server-guide";
export const XCODE_BETA_DOWNLOAD_URL = "https://developer.apple.com/xcode/";

export interface FigmaXcodeAuthStatus {
	xcodeInstalled: boolean;
	xcodeAppPath?: string;
	xcodePluginInstalled: boolean;
	xcodeHasFigmaServer: boolean;
	xcodeHasBearerToken: boolean;
	xcodeMcpConfigPath: string;
	xcodePluginPath: string;
	piOAuthConnected: boolean;
	piOAuthTokensPath: string;
}

export interface FigmaXcodeImportResult {
	imported: boolean;
	alreadyConnected: boolean;
	message: string;
	status: FigmaXcodeAuthStatus;
}

export interface FigmaAuthResetResult {
	removed: boolean;
	message: string;
	status: FigmaXcodeAuthStatus;
}

interface XcodeMcpServersFile {
	mcpServers?: Record<string, { headers?: Record<string, unknown> }>;
}

function execFileAsync(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { timeout: 10_000 }, (error) =>
			error ? reject(error) : resolve(),
		);
	});
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function authAccount(serverName: string): string {
	return `sha256-${sha256(serverName)}`;
}

function xcodeAppCandidates(): string[] {
	const home = homedir();
	return [
		"/Applications/Xcode.app",
		"/Applications/Xcode-beta.app",
		join(home, "Applications", "Xcode.app"),
		join(home, "Applications", "Xcode-beta.app"),
	];
}

export function detectXcodeApp(paths = xcodeAppCandidates()): string | undefined {
	return paths.find((path) => existsSync(path));
}

export function xcodeMcpConfigPath(homeDir = homedir()): string {
	return join(homeDir, "Library", "Developer", "Xcode", "CodingAssistant", "mcp-servers.json");
}

export function xcodeFigmaPluginPath(homeDir = homedir()): string {
	return join(homeDir, "Library", "Developer", "Xcode", "CodingAssistant", "AgentPlugins", "figma");
}

function readJsonFile<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function readXcodeFigmaBearerToken(path = xcodeMcpConfigPath()): string | undefined {
	const root = readJsonFile<XcodeMcpServersFile>(path);
	const auth = root?.mcpServers?.figma?.headers?.Authorization;
	if (typeof auth !== "string") return undefined;
	const trimmed = auth.trim();
	return trimmed.startsWith("Bearer ") ? trimmed.slice("Bearer ".length).trim() || undefined : undefined;
}

export function piOauthTokensPath(agentDir: string, serverName = FIGMA_SERVER_NAME): string {
	return join(agentDir, "mcp-oauth", authAccount(serverName), "tokens.json");
}

async function hasPiOauthKeychainEntry(serverName: string): Promise<boolean> {
	if (process.platform !== "darwin") return false;
	try {
		await execFileAsync("security", [
			"find-generic-password",
			"-s",
			PI_MCP_KEYCHAIN_SERVICE,
			"-a",
			authAccount(serverName),
		]);
		return true;
	} catch {
		return false;
	}
}

async function deletePiOauthKeychainEntry(serverName: string): Promise<boolean> {
	if (process.platform !== "darwin") return false;
	try {
		await execFileAsync("security", [
			"delete-generic-password",
			"-s",
			PI_MCP_KEYCHAIN_SERVICE,
			"-a",
			authAccount(serverName),
		]);
		return true;
	} catch {
		return false;
	}
}

export async function hasPiOauthConnection(agentDir: string, serverName = FIGMA_SERVER_NAME): Promise<boolean> {
	return existsSync(piOauthTokensPath(agentDir, serverName)) || (await hasPiOauthKeychainEntry(serverName));
}

export function buildFigmaPiAuthEntry(accessToken: string): Record<string, unknown> {
	return {
		tokens: {
			accessToken,
			scope: "mcp:connect",
		},
		clientInfo: {
			clientId: FIGMA_CLIENT_ID,
		},
		serverUrl: FIGMA_SERVER_URL,
	};
}

export function writeLegacyPiOauthEntry(path: string, entry: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

export async function getFigmaXcodeAuthStatus(agentDir: string): Promise<FigmaXcodeAuthStatus> {
	const appPath = detectXcodeApp();
	const configPath = xcodeMcpConfigPath();
	const pluginPath = xcodeFigmaPluginPath();
	const token = readXcodeFigmaBearerToken(configPath);
	const config = readJsonFile<XcodeMcpServersFile>(configPath);
	const hasServer = !!config?.mcpServers?.figma;
	return {
		xcodeInstalled: !!appPath,
		xcodeAppPath: appPath,
		xcodePluginInstalled: existsSync(pluginPath),
		xcodeHasFigmaServer: hasServer,
		xcodeHasBearerToken: !!token,
		xcodeMcpConfigPath: configPath,
		xcodePluginPath: pluginPath,
		piOAuthConnected: await hasPiOauthConnection(agentDir, FIGMA_SERVER_NAME),
		piOAuthTokensPath: piOauthTokensPath(agentDir, FIGMA_SERVER_NAME),
	};
}

export async function importXcodeFigmaAuthToPi(agentDir: string): Promise<FigmaXcodeImportResult> {
	const token = readXcodeFigmaBearerToken();
	if (!token) {
		return {
			imported: false,
			alreadyConnected: false,
			message: "Figma is not signed in inside Xcode yet.",
			status: await getFigmaXcodeAuthStatus(agentDir),
		};
	}
	const alreadyConnected = await hasPiOauthConnection(agentDir, FIGMA_SERVER_NAME);
	writeLegacyPiOauthEntry(
		piOauthTokensPath(agentDir, FIGMA_SERVER_NAME),
		buildFigmaPiAuthEntry(token),
	);
	return {
		imported: !alreadyConnected,
		alreadyConnected,
		message: alreadyConnected
			? "Refreshed the existing Figma sign-in for Pi."
			: "Imported the Xcode Figma sign-in into Pi.",
		status: await getFigmaXcodeAuthStatus(agentDir),
	};
}

export async function resetFigmaAuth(agentDir: string): Promise<FigmaAuthResetResult> {
	const paths = [
		dirname(piOauthTokensPath(agentDir, FIGMA_SERVER_NAME)),
		join(agentDir, "mcp-oauth", FIGMA_SERVER_NAME),
	];
	let removed = false;
	for (const path of paths) {
		if (!existsSync(path)) continue;
		rmSync(path, { recursive: true, force: true });
		removed = true;
	}
	if (await deletePiOauthKeychainEntry(FIGMA_SERVER_NAME)) removed = true;
	return {
		removed,
		message: removed
			? "Reset Figma sign-in for Pi. Start a fresh auth flow to connect again."
			: "No saved Figma sign-in was found for Pi.",
		status: await getFigmaXcodeAuthStatus(agentDir),
	};
}
