function stamp(): string {
	return new Date().toISOString();
}

function emit(level: "debug" | "info" | "warn" | "error", args: unknown[]): void {
	const prefix = `[cosmos ${stamp()}]`;
	const fn = level === "debug" ? console.debug : level === "info" ? console.info : level === "warn" ? console.warn : console.error;
	fn(prefix, ...args);
}

export const runtimeLog = {
	debug: (...args: unknown[]) => emit("debug", args),
	info: (...args: unknown[]) => emit("info", args),
	warn: (...args: unknown[]) => emit("warn", args),
	error: (...args: unknown[]) => emit("error", args),
};
