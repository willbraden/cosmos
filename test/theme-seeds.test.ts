import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, shell: {} }));
vi.mock("electron-log/main", () => ({
	default: { info() {}, warn() {}, error() {}, debug() {} },
}));

import { DEFAULT_THEME_SEEDS } from "../src/shared/ipc";
import { sanitizeSettingsPatch } from "../src/main/settings";
import { __test } from "../src/renderer/src/lib/theme-colors";

const { tokensFor, contrast, readableOn } = __test;

describe("theme seed sanitizing", () => {
	it("keeps a well-formed seed set", () => {
		const patch = sanitizeSettingsPatch({
			themeSeeds: {
				light: { bg: "#ffffff", fg: "#111111", accent: "#222222" },
				dark: { bg: "#000000", fg: "#eeeeee", accent: "#dddddd" },
			},
		});
		expect(patch.themeSeeds?.light.fg).toBe("#111111");
		expect(patch.themeSeeds?.dark.accent).toBe("#dddddd");
	});

	it("normalizes case and drops values that are not hex colours", () => {
		const patch = sanitizeSettingsPatch({
			themeSeeds: {
				light: { bg: "#FFFFFF", fg: "red", accent: "#222222" },
				dark: { bg: "#000000", fg: "#eeeeee", accent: "#dddddd" },
			},
		});
		// Valid values survive and are lowercased.
		expect(patch.themeSeeds?.light.bg).toBe("#ffffff");
		// A non-hex value falls back to the default rather than reaching CSS.
		expect(patch.themeSeeds?.light.fg).toBe(DEFAULT_THEME_SEEDS.light.fg);
	});

	it("ignores a themeSeeds value that is not an object", () => {
		expect(sanitizeSettingsPatch({ themeSeeds: "nope" }).themeSeeds).toBeUndefined();
		expect(sanitizeSettingsPatch({ themeSeeds: null }).themeSeeds).toBeUndefined();
	});

	it("only accepts a boolean for homeConstellations", () => {
		expect(sanitizeSettingsPatch({ homeConstellations: false }).homeConstellations).toBe(false);
		expect(sanitizeSettingsPatch({ homeConstellations: "yes" }).homeConstellations).toBeUndefined();
	});
});

describe("token derivation", () => {
	it("defaults are monochrome: every seed has equal RGB channels", () => {
		for (const mode of ["light", "dark"] as const) {
			for (const key of ["bg", "fg", "accent"] as const) {
				const hex = DEFAULT_THEME_SEEDS[mode][key];
				const [r, g, b] = [1, 3, 5].map((i) => hex.slice(i, i + 2));
				expect(`${mode}.${key}=${hex} ${r}${g}${b}`).toBe(`${mode}.${key}=${hex} ${r}${r}${r}`);
			}
		}
	});

	it("default seeds clear AAA contrast for text and accent", () => {
		for (const mode of ["light", "dark"] as const) {
			const { bg, fg, accent } = DEFAULT_THEME_SEEDS[mode];
			expect(contrast(fg, bg)).toBeGreaterThanOrEqual(7);
			expect(contrast(accent, bg)).toBeGreaterThanOrEqual(7);
		}
	});

	it("picks a foreground that is readable on the accent", () => {
		for (const accent of ["#1a1a1a", "#f2f2f2", "#008060", "#ffcc00"]) {
			expect(contrast(readableOn(accent), accent)).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("maps the surface and brand tokens straight from the seeds", () => {
		const t = tokensFor({ bg: "#ffffff", fg: "#1a1a1a", accent: "#1a1a1a" });
		expect(t["--color-surface-default"]).toBe("#ffffff");
		expect(t["--color-background-brand-default-strong-idle"]).toBe("#1a1a1a");
	});

	it("emits every token as a concrete hex value", () => {
		for (const mode of ["light", "dark"] as const) {
			for (const [name, value] of Object.entries(tokensFor(DEFAULT_THEME_SEEDS[mode]))) {
				expect(`${name}=${value}`).toMatch(/=#[0-9a-f]{6}$/);
			}
		}
	});
});
