import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, shell: {} }));
vi.mock("electron-log/main", () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));

import * as bridge from "../resources/pi-extension/desktop-bridge";
import { fuzzyScore } from "../src/main/files";
import { encodeJsonl, JsonlDecoder } from "../src/main/pi/jsonl";
import { sanitizeSettingsPatch } from "../src/main/settings";
import { parseEnvOutput } from "../src/main/shell-env";
import { PERMISSION_OPTIONS, PERMISSION_PROMPT_MARKER } from "../src/shared/pi-types";

describe("JsonlDecoder", () => {
	function decode(chunks: (string | Buffer)[]) {
		const records: unknown[] = [];
		const invalid: string[] = [];
		const decoder = new JsonlDecoder((r) => records.push(r), (line) => invalid.push(line));
		for (const chunk of chunks) decoder.push(chunk);
		decoder.end();
		return { records, invalid };
	}

	it("splits only on LF, keeping U+2028/U+2029 inside strings", () => {
		const text = "a b c";
		const { records } = decode([encodeJsonl({ text }), encodeJsonl({ n: 2 })]);
		expect(records).toEqual([{ text }, { n: 2 }]);
	});

	it("reassembles records and multi-byte characters split across chunks", () => {
		const bytes = Buffer.from(encodeJsonl({ emoji: "héllo 👋" }));
		const { records } = decode([bytes.subarray(0, 13), bytes.subarray(13, 15), bytes.subarray(15)]);
		expect(records).toEqual([{ emoji: "héllo 👋" }]);
	});

	it("accepts CRLF and a final unterminated record", () => {
		expect(decode(['{"a":1}\r\n{"b":2}']).records).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("reports malformed lines without stopping", () => {
		const { records, invalid } = decode(['{"a":1}\nnot json\n{"b":2}\n']);
		expect(records).toEqual([{ a: 1 }, { b: 2 }]);
		expect(invalid).toEqual(["not json"]);
	});
});

describe("desktop bridge extension", () => {
	it("shares its protocol constants with the renderer", () => {
		expect(bridge.PERMISSION_PROMPT_MARKER).toBe(PERMISSION_PROMPT_MARKER);
		expect(bridge.OPTIONS).toEqual(PERMISSION_OPTIONS);
	});

	it("classifies tools and applies permission modes", () => {
		const none = new Set<string>();
		expect(bridge.needsApproval("ask", "read", none)).toBe(false);
		expect(bridge.needsApproval("ask", "edit", none)).toBe(true);
		expect(bridge.needsApproval("ask", "bash", none)).toBe(true);
		expect(bridge.needsApproval("acceptEdits", "write", none)).toBe(false);
		expect(bridge.needsApproval("acceptEdits", "bash", none)).toBe(true);
		expect(bridge.needsApproval("acceptEdits", "some_extension_tool", none)).toBe(true);
		expect(bridge.needsApproval("auto", "bash", none)).toBe(false);
		expect(bridge.needsApproval("ask", "bash", new Set(["bash"]))).toBe(false);
	});

	it("parses modes strictly", () => {
		expect(bridge.parseMode(" auto ")).toBe("auto");
		expect(bridge.parseMode("yolo")).toBeUndefined();
		expect(bridge.parseMode(undefined)).toBeUndefined();
	});
});

describe("settings validation", () => {
	it("drops unknown keys and wrongly typed values", () => {
		expect(
			sanitizeSettingsPatch({
				theme: "neon",
				permissionMode: "auto",
				notifications: "yes",
				idleSuspendMinutes: 99999,
				piCliPath: "relative/path.js",
				pinnedSessions: ["/a.jsonl", "b.jsonl", "/a.jsonl"],
				evil: true,
			}),
		).toEqual({ permissionMode: "auto", idleSuspendMinutes: 1440, pinnedSessions: ["/a.jsonl"] });
	});

	it("ignores non-objects", () => {
		expect(sanitizeSettingsPatch(null)).toEqual({});
		expect(sanitizeSettingsPatch("theme=dark")).toEqual({});
	});
});

describe("shell environment parsing", () => {
	it("extracts NUL-separated variables between markers, ignoring shell noise", () => {
		const output = "Welcome banner\n__PI_DESKTOP_ENV_START__PATH=/opt/homebrew/bin:/usr/bin\0MULTI=line1\nline2\0SHLVL=2\0__PI_DESKTOP_ENV_END__";
		expect(parseEnvOutput(output)).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin", MULTI: "line1\nline2" });
	});

	it("throws when the markers are missing", () => {
		expect(() => parseEnvOutput("nothing here")).toThrow();
	});
});

describe("fuzzy file matching", () => {
	it("ranks file-name matches above deep path matches", () => {
		const a = fuzzyScore("src/components/button.tsx", "button") ?? -Infinity;
		const b = fuzzyScore("docs/big/unrelated/tree/notes.md", "button");
		expect(b).toBeNull();
		const c = fuzzyScore("b/u/t/t/o/n/index.ts", "button") ?? -Infinity;
		expect(a).toBeGreaterThan(c);
	});
});
