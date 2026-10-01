import type { SessionEntry } from "../shared/pi-types";
import { PiProcess } from "./pi/pi-process";

export const DESKTOP_ACTIVE_TOOLS_COMMAND = "/desktop-report-active-tools";
export const DESKTOP_ACTIVE_TOOLS_CUSTOM_TYPE = "desktop-active-tools";

export interface ActiveToolsProbeSpec {
	nodePath: string;
	launcherPath: string;
	cliPath: string;
	extensionPath: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

function parseTools(value: unknown): string[] | undefined {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: undefined;
}

export function extractReportedActiveTools(entries: SessionEntry[]): string[] | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom_message") continue;
		if (entry.customType !== DESKTOP_ACTIVE_TOOLS_CUSTOM_TYPE) continue;
		const detailsTools = parseTools(entry.details && typeof entry.details === "object" ? (entry.details as Record<string, unknown>).tools : undefined);
		if (detailsTools) return detailsTools;
		const content = typeof entry.content === "string" ? entry.content : "";
		try {
			const parsed = JSON.parse(content) as { tools?: unknown };
			const contentTools = parseTools(parsed.tools);
			if (contentTools) return contentTools;
		} catch {
			// Ignore malformed probe payloads.
		}
	}
	return undefined;
}

export async function probeFreshSessionActiveTools(spec: ActiveToolsProbeSpec): Promise<string[]> {
	const proc = new PiProcess({
		command: spec.nodePath,
		args: [
			spec.launcherPath,
			spec.cliPath,
			"--mode",
			"rpc",
			"-e",
			spec.extensionPath,
		],
		cwd: spec.cwd,
		env: spec.env,
	});
	proc.start();
	try {
		await proc.request({ type: "prompt", message: DESKTOP_ACTIVE_TOOLS_COMMAND }, 10_000);
		for (let attempt = 0; attempt < 4; attempt++) {
			const entries = await proc.request<{ entries: SessionEntry[]; leafId: string | null }>(
				{ type: "get_entries" },
				10_000,
			);
			const tools = extractReportedActiveTools(entries.entries);
			if (tools) return tools;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("Pi did not report active tools for the fresh-session probe.");
	} finally {
		await proc.stop().catch(() => undefined);
	}
}
