import { describe, expect, it } from "vitest";
import {
	applyManualSessionOrder,
	compareSessionOrder,
	compareSessionSummaries,
	moveSessionOrderItem,
} from "../src/shared/session-order";

describe("session ordering", () => {
	it("keeps newer sessions ahead even when older ones become more active", () => {
		const newer = {
			path: "/tmp/newer.jsonl",
			created: 200,
			modified: 210,
			cwd: "/tmp",
			id: "newer",
			messageCount: 1,
			firstMessage: "newer",
		};
		const olderButActive = {
			path: "/tmp/older.jsonl",
			created: 100,
			modified: 999,
			cwd: "/tmp",
			id: "older",
			messageCount: 10,
			firstMessage: "older",
		};

		expect([olderButActive, newer].sort(compareSessionSummaries)).toEqual([
			newer,
			olderButActive,
		]);
	});

	it("falls back to modified time only when sessions were created together", () => {
		const first = { created: 100, modified: 110, stableKey: "a" };
		const second = { created: 100, modified: 120, stableKey: "b" };
		expect([first, second].sort(compareSessionOrder)).toEqual([
			second,
			first,
		]);
	});

	it("uses the stable key as the final deterministic tiebreaker", () => {
		const a = { created: 100, modified: 100, stableKey: "a" };
		const b = { created: 100, modified: 100, stableKey: "b" };
		expect([b, a].sort(compareSessionOrder)).toEqual([a, b]);
	});

	it("applies a stored manual order before the default sort", () => {
		const first = { created: 300, modified: 300, stableKey: "first" };
		const second = { created: 200, modified: 200, stableKey: "second" };
		const third = { created: 100, modified: 100, stableKey: "third" };
		expect(
			applyManualSessionOrder([first, second, third], ["third", "first"]),
		).toEqual([third, first, second]);
	});

	it("moves a dragged session after the hovered target", () => {
		expect(
			moveSessionOrderItem(["a", "b", "c"], "a", "b", "after"),
		).toEqual(["b", "a", "c"]);
	});

	it("can move a dragged session to the end of the section", () => {
		expect(moveSessionOrderItem(["a", "b", "c"], "a", null, "end")).toEqual([
			"b",
			"c",
			"a",
		]);
	});
});
