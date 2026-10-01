export interface UiInspectSelection {
	title: string;
	summary: string;
	promptContext: string;
	rect: {
		top: number;
		left: number;
		width: number;
		height: number;
	};
}

const INTERACTIVE_SELECTOR = [
	"button",
	"a",
	"input",
	"textarea",
	"select",
	"label",
	"summary",
	"[role='button']",
	"[role='link']",
	"[role='tab']",
	"[role='menuitem']",
	"[role='switch']",
	"[role='checkbox']",
	"[role='radio']",
	"[role='textbox']",
].join(", ");

function clean(text: string | null | undefined): string {
	return (text ?? "").replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function selectorFor(element: HTMLElement): string {
	const tag = element.tagName.toLowerCase();
	const id = element.id ? `#${element.id}` : "";
	const classes = Array.from(element.classList)
		.slice(0, 4)
		.map((name) => `.${name}`)
		.join("");
	return `${tag}${id}${classes}`;
}

function domPath(element: HTMLElement): string {
	const parts: string[] = [];
	let current: HTMLElement | null = element;
	while (current && parts.length < 5) {
		if (current.id === "root" || current.tagName === "BODY") break;
		parts.unshift(selectorFor(current));
		current = current.parentElement;
	}
	return parts.join(" > ");
}

function findNearbyLabel(element: HTMLElement): string {
	const attributes = [
		element.getAttribute("aria-label"),
		element.getAttribute("title"),
		element.getAttribute("placeholder"),
		element.getAttribute("name"),
		element.getAttribute("data-testid"),
		element.getAttribute("data-test-id"),
		element.getAttribute("data-slot"),
		element.getAttribute("data-state"),
	].map(clean);
	const text = clean(element.innerText || element.textContent || "");
	return attributes.find(Boolean) || text;
}

function ancestorSummary(element: HTMLElement): string {
	const rows: string[] = [];
	let current = element.parentElement;
	while (current && rows.length < 3) {
		if (current.id === "root" || current.tagName === "BODY") break;
		const label = findNearbyLabel(current);
		rows.push(
			`${selectorFor(current)}${label ? ` — ${truncate(label, 90)}` : ""}`,
		);
		current = current.parentElement;
	}
	return rows.length > 0 ? rows.join("\n") : "None";
}

function outerHtmlSnippet(element: HTMLElement): string {
	return truncate(clean(element.outerHTML), 1200);
}

export function pickInspectableElement(node: Element | null): HTMLElement | null {
	let element = node instanceof HTMLElement ? node : node?.parentElement ?? null;
	if (!element) return null;
	if (element.closest("[data-ui-inspector-ignore='true']")) return null;

	const interactive = element.closest(INTERACTIVE_SELECTOR);
	if (interactive instanceof HTMLElement) element = interactive;

	while (element) {
		if (element.closest("[data-ui-inspector-ignore='true']")) return null;
		if (element.tagName === "HTML" || element.tagName === "BODY") return null;
		const rect = element.getBoundingClientRect();
		if (rect.width >= 12 && rect.height >= 12) break;
		element = element.parentElement;
	}
	if (!element) return null;
	const rect = element.getBoundingClientRect();
	if (rect.width < 12 || rect.height < 12) return null;
	if (
		rect.width >= window.innerWidth - 8 &&
		rect.height >= window.innerHeight - 8
	)
		return null;
	return element;
}

export function describeInspectableElement(
	element: HTMLElement,
): UiInspectSelection {
	const rect = element.getBoundingClientRect();
	const tag = element.tagName.toLowerCase();
	const role = clean(element.getAttribute("role"));
	const label = findNearbyLabel(element);
	const title = truncate(label || selectorFor(element), 80);
	const summary = [selectorFor(element), label && truncate(label, 120)]
		.filter(Boolean)
		.join(" — ");
	const promptContext = [
		"Selected UI element",
		`- Selector: ${selectorFor(element)}`,
		`- DOM path: ${domPath(element) || selectorFor(element)}`,
		`- Tag: ${tag}`,
		role ? `- Role: ${role}` : "",
		label ? `- Text/label: ${truncate(label, 240)}` : "",
		element.getAttribute("title")
			? `- Title attribute: ${truncate(clean(element.getAttribute("title")), 160)}`
			: "",
		element.getAttribute("placeholder")
			? `- Placeholder: ${truncate(clean(element.getAttribute("placeholder")), 160)}`
			: "",
		element.getAttribute("aria-label")
			? `- Aria label: ${truncate(clean(element.getAttribute("aria-label")), 160)}`
			: "",
		element.getAttribute("data-testid")
			? `- data-testid: ${element.getAttribute("data-testid")}`
			: "",
		`- Bounds: x=${Math.round(rect.left)}, y=${Math.round(rect.top)}, width=${Math.round(rect.width)}, height=${Math.round(rect.height)}`,
		`- Ancestors:\n${ancestorSummary(element)}`,
		`- HTML snippet: ${outerHtmlSnippet(element)}`,
	]
		.filter(Boolean)
		.join("\n");
	return {
		title,
		summary,
		promptContext,
		rect: {
			top: rect.top,
			left: rect.left,
			width: rect.width,
			height: rect.height,
		},
	};
}

export function buildUiInspectPrompt(
	selection: UiInspectSelection,
	userPrompt: string,
): string {
	return [
		"I'm inspecting a UI element inside the Cosmos desktop app.",
		"",
		"What I want help with:",
		userPrompt.trim(),
		"",
		selection.promptContext,
		"",
		"Use the selected UI context above when answering. If useful, reference the relevant component, styles, state, keyboard interactions, and implementation details.",
	].join("\n");
}
