import { DEFAULT_THEME_SEEDS, type ThemeSeeds, type ThemeSeedSet } from "@shared/ipc";

/**
 * Derives the full colour palette from three seeds per mode.
 *
 * Applied as a runtime <style> override rather than by rewriting tokens.css,
 * so the shipped tokens remain the fallback and nothing breaks if this is
 * switched off.
 *
 * Mode resolution is left to CSS, mirroring how tokens.css already scopes
 * light and dark. A JS `prefers-color-scheme` listener would duplicate that
 * logic and drift out of step with it.
 */

type Rgb = [number, number, number];

function toRgb(hex: string): Rgb {
	const h = hex.replace("#", "");
	const full =
		h.length === 3
			? h
					.split("")
					.map((c) => c + c)
					.join("")
			: h;
	return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

function toHex([r, g, b]: Rgb): string {
	const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
	return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, "0")).join("")}`;
}

function mix(a: string, b: string, t: number): string {
	const x = toRgb(a);
	const y = toRgb(b);
	return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb);
}

/** Relative luminance, for contrast decisions. */
function luminance(hex: string): number {
	const [r, g, b] = toRgb(hex).map((c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
	const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
	return (x + 0.05) / (y + 0.05);
}

/** Whichever of black/white is more readable on `on`. */
function readableOn(on: string): string {
	return contrast("#ffffff", on) >= contrast("#000000", on) ? "#ffffff" : "#000000";
}

function tokensFor(seeds: ThemeSeeds): Record<string, string> {
	const { bg, fg, accent } = seeds;
	const dark = luminance(bg) < 0.5;
	// Raising a surface means stepping it toward the text colour. In dark mode
	// that lightens, in light mode it darkens — one rule, both directions.
	const lift = (t: number) => mix(bg, fg, t);

	return {
		"--color-surface-default": bg,
		"--color-surface-primary": lift(0.03),
		"--color-surface-secondary": lift(0.06),
		"--color-surface-raised": lift(0.09),

		"--color-background-neutral-default-normal-idle": lift(0.04),
		"--color-background-neutral-default-normal-hover": lift(0.08),
		"--color-background-neutral-default-subtle-idle": lift(0.06),
		"--color-background-neutral-default-subtle-hover": lift(0.1),
		"--color-background-neutral-default-minimal-idle": lift(0.02),
		"--color-background-neutral-default-strong-idle": mix(fg, bg, 0.1),
		"--color-background-neutral-default-strong-hover": mix(fg, bg, 0.2),

		"--color-background-brand-default-strong-idle": accent,
		"--color-background-brand-default-strong-hover": mix(accent, bg, 0.18),
		"--color-background-brand-default-subtle-idle": mix(bg, accent, 0.12),

		"--color-foreground-neutral-default-strong": fg,
		"--color-foreground-neutral-default-normal": mix(fg, bg, 0.26),
		"--color-foreground-neutral-default-subtle": mix(fg, bg, 0.48),
		"--color-foreground-neutral-inverse-strong": readableOn(fg),
		"--color-foreground-brand-strong": accent,

		"--color-border-neutral-subtle": lift(dark ? 0.12 : 0.14),
		"--color-border-neutral-normal": lift(dark ? 0.2 : 0.24),
		"--color-border-neutral-strong": lift(dark ? 0.36 : 0.42),
		"--color-border-brand-strong": accent,

		"--accent": accent,
		// Label colour for text sitting on an accent-filled surface. Derived,
		// because a white-on-white button is the obvious way this breaks.
		"--app-foreground-on-brand-strong": readableOn(accent),

		// Drives the constellation field; kept with the palette so it retints
		// with the theme instead of being hardcoded in the component.
		"--home-constellation-color": mix(bg, fg, dark ? 0.72 : 0.55),
	};
}

const STYLE_ID = "cosmos-theme-seeds";

function block(selector: string, seeds: ThemeSeeds): string {
	const body = Object.entries(tokensFor(seeds))
		.map(([k, v]) => `\t${k}: ${v};`)
		.join("\n");
	return `${selector} {\n${body}\n}`;
}

export function applyThemeSeeds(seeds: ThemeSeedSet = DEFAULT_THEME_SEEDS): void {
	let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
	if (!style) {
		style = document.createElement("style");
		style.id = STYLE_ID;
		// Last in <head> so these win over tokens.css without needing
		// !important, while still losing to anything more specific.
		document.head.append(style);
	}
	style.textContent = [
		block(":root", seeds.light),
		block(':root[data-theme="dark"]', seeds.dark),
		`@media (prefers-color-scheme: dark) {\n${block(
			':root:not([data-theme="light"])',
			seeds.dark,
		)
			.split("\n")
			.map((l) => `\t${l}`)
			.join("\n")}\n}`,
	].join("\n\n");
}

export const __test = { tokensFor, contrast, readableOn, mix };

/** Exposed so the settings pane can warn before the user saves something unreadable. */
export function contrastRatio(a: string, b: string): number {
	return contrast(a, b);
}
