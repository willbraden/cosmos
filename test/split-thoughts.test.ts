import { describe, expect, it } from "vitest";
import { splitThoughts } from "../src/renderer/src/lib/activity";

describe("splitThoughts", () => {
	it("splits a reasoning block on its bold section headings", () => {
		const text = [
			"**Evaluating performance card layout**",
			"",
			"I'm considering changing the performance cards.",
			"",
			"**Inspecting section layout**",
			"",
			"I'm thinking about a plain header instead.",
		].join("\n");

		expect(splitThoughts(text)).toEqual([
			{
				title: "Evaluating performance card layout",
				body: "I'm considering changing the performance cards.",
			},
			{
				title: "Inspecting section layout",
				body: "I'm thinking about a plain header instead.",
			},
		]);
	});

	it("keeps untitled reasoning as a single untitled section", () => {
		expect(splitThoughts("Just a plain thought.\nAcross two lines.")).toEqual([
			{ title: null, body: "Just a plain thought.\nAcross two lines." },
		]);
	});

	it("keeps prose that precedes the first heading", () => {
		const text = ["A preamble.", "**Then a heading**", "And its body."].join("\n");
		expect(splitThoughts(text)).toEqual([
			{ title: null, body: "A preamble." },
			{ title: "Then a heading", body: "And its body." },
		]);
	});

	it("keeps a heading that has no body", () => {
		expect(splitThoughts("**Just a heading**")).toEqual([
			{ title: "Just a heading", body: "" },
		]);
	});

	it("ignores bold spans that are not the whole line", () => {
		const text = "I need **bold** emphasis mid-sentence.";
		expect(splitThoughts(text)).toEqual([{ title: null, body: text }]);
	});

	it("returns nothing for empty reasoning", () => {
		expect(splitThoughts("")).toEqual([]);
		expect(splitThoughts("   \n  ")).toEqual([]);
	});
});
