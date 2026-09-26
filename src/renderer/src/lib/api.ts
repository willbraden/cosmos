import type { DesktopApi } from "@shared/ipc";

declare global {
	interface Window {
		pi: DesktopApi;
	}
}

export const api: DesktopApi = window.pi;

export function errorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	// Electron prefixes errors thrown in IPC handlers; strip that for display.
	return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

export function tildify(path: string, home: string | undefined): string {
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function relativeTime(epochMs: number, now = Date.now()): string {
	const seconds = Math.round((now - epochMs) / 1000);
	if (seconds < 45) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 7) return `${days}d ago`;
	// Stored timestamps are UTC; format in the viewer's local time zone.
	return new Date(epochMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
	return String(n);
}

export function formatCost(dollars: number): string {
	if (dollars === 0) return "$0";
	if (dollars < 0.01) return "<$0.01";
	return `$${dollars.toFixed(2)}`;
}
