import { describe, expect, it } from "vitest";
import { summarizeSessionTitle } from "../src/renderer/src/lib/session-title";
import { sessionTitle } from "../src/renderer/src/state/store";

describe("session titles", () => {
	it("turns a first message into a short natural summary title", () => {
		expect(summarizeSessionTitle("this is how the tool thinks.")).toBe(
			"How the tool thinks",
		);
		expect(sessionTitle({ firstMessage: "tell me what you can do" })).toBe(
			"What you can do",
		);
	});

	it("keeps explicit session names", () => {
		expect(
			sessionTitle({ name: "Pinned Debug Session", firstMessage: "ignored" }),
		).toBe("Pinned Debug Session");
	});

	it("pulls the topical phrase toward the front when structure makes it clear", () => {
		expect(
			summarizeSessionTitle(
				"build a react hook for session title summarization in the sidebar",
			),
		).toBe("Session title summarization");
	});

	it("formats common technical acronyms cleanly in sentence case", () => {
		expect(summarizeSessionTitle("fix mcp oauth setup")).toBe(
			"MCP OAuth setup",
		);
	});

	it("can front-load the topic after a generic request verb", () => {
		expect(
			summarizeSessionTitle(
				"help me understand the couchvox osascript blocker",
			),
		).toBe("Couchvox osascript blocker");
	});

	it("prefers a frozen auto-title so the title does not drift later", () => {
		expect(
			sessionTitle(
				{ firstMessage: "what can you tell me about this implementation detail" },
				"New session",
				"tell me what you can do",
				"What you can do",
			),
		).toBe("What you can do");
	});

	it("does not show a live first-message fallback for a brand-new session", () => {
		expect(
			sessionTitle(undefined, "New session", "hey i just want to test this"),
		).toBe("New session");
	});

	it("falls back when there is no usable text", () => {
		expect(sessionTitle(undefined)).toBe("New session");
		expect(sessionTitle({ firstMessage: "   " }, "Untitled")).toBe("Untitled");
	});
});
