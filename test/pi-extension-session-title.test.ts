import { describe, expect, it } from "vitest";
import {
	buildTitlePrompt,
	fallbackTitleFromTranscript,
	sanitizeGeneratedTitle,
} from "../resources/pi-extension/session-title";

describe("pi extension session title helpers", () => {
	it("sanitizes plain model output", () => {
		expect(sanitizeGeneratedTitle('"Debugging modal focus trap."')).toBe(
			"Debugging modal focus trap",
		);
	});

	it("rejects banned generic prefixes", () => {
		expect(sanitizeGeneratedTitle("Help with sidebar bug")).toBe("");
		expect(sanitizeGeneratedTitle("How to fix drag and drop")).toBe("");
	});

	it("caps long titles on a word boundary", () => {
		expect(
			sanitizeGeneratedTitle(
				"Comparing sidebar session naming approaches in Cosmos desktop",
			),
		).toBe("Comparing sidebar session naming");
	});

	it("derives a useful fallback title from an early transcript", () => {
		expect(
			fallbackTitleFromTranscript(
				"User: Hey i just want to test out the new session titles feature. what do you think of it?\nAssistant: I think it's a great quality-of-life feature.",
			),
		).toBe("Testing session titles");
	});

	it("builds a focused prompt with negative examples", () => {
		const prompt = buildTitlePrompt("User: fix drag and drop\nAssistant: investigating sidebar ordering");
		expect(prompt).toContain("Write a 2 to 5 word title");
		expect(prompt).toContain("Bad: I'm inspecting a UI");
		expect(prompt).toContain("User: fix drag and drop");
	});
});
