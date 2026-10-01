export const AUTO_TITLE_CUSTOM_TYPE = "cosmos.auto-title";

const BANNED_PREFIXES = [
	"help with",
	"discussion about",
	"question about",
	"how to",
];

const LEADING_CHATTER = [
	/^(?:hey|hi|hello)\b[!, ]*/i,
	/^i\s+just\s+want\s+to\s+/i,
	/^i\s+want\s+to\s+/i,
	/^can\s+you\s+/i,
	/^could\s+you\s+/i,
	/^please\s+/i,
];

const ACTION_REWRITES: Array<[RegExp, string]> = [
	[/^test\s+(?:out\s+)?(?:the\s+)?(?:new\s+)?(.+?)(?:\s+feature)?$/i, "Testing $1"],
	[/^debug\s+(.+)$/i, "Debugging $1"],
	[/^fix\s+(.+)$/i, "Fixing $1"],
	[/^compare\s+(.+)$/i, "Comparing $1"],
	[/^review\s+(.+)$/i, "Reviewing $1"],
	[/^inspect\s+(.+)$/i, "Inspecting $1"],
	[/^find\s+(.+)$/i, "Finding $1"],
	[/^build\s+(.+)$/i, "Building $1"],
];

export function buildTitlePrompt(transcript: string): string {
	return [
		"Write a 2 to 5 word title for this conversation.",
		"",
		"Name the subject and the action. Sentence case. No trailing period.",
		"No quotes. Never start with \"Help with\", \"Discussion about\", \"Question about\", or \"How to\".",
		"Describe what the user is trying to accomplish, not how they phrased it.",
		"",
		"Bad: I'm inspecting a UI",
		"Good: Debugging modal focus trap",
		"",
		"Bad: The benefits of using",
		"Good: Comparing state libraries",
		"",
		"Return only the title.",
		"",
		transcript,
	].join("\n");
}

export function sanitizeGeneratedTitle(raw: string): string {
	const cleaned = cleanTitle(raw);
	if (!cleaned) return "";
	const lower = cleaned.toLowerCase();
	if (BANNED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return "";
	const words = cleaned.split(/\s+/).filter(Boolean);
	if (words.length < 2) return "";
	return clampWords(cleaned, 40);
}

export function fallbackTitleFromTranscript(transcript: string): string {
	const userLine = transcript
		.split(/\r?\n/)
		.find((line) => line.startsWith("User: "))
		?.slice(6)
		.trim();
	if (!userLine) return "";
	let text = (userLine.split(/[?!.]/, 1)[0] ?? userLine)
		.replace(/\s+/g, " ")
		.trim();
	for (const prefix of LEADING_CHATTER) text = text.replace(prefix, "").trim();
	for (const [pattern, replacement] of ACTION_REWRITES) {
		if (!pattern.test(text)) continue;
		text = text.replace(pattern, replacement);
		break;
	}
	text = text
		.replace(/\b(?:the|a|an)\b\s+(?=session|sidebar|title|titles|feature|bug|issue)/gi, "")
		.replace(/\s+/g, " ")
		.trim();
	const words = text.split(/\s+/).filter(Boolean).slice(0, 5);
	if (words.length < 2) return "";
	return sentenceCase(words.join(" "));
}

function cleanTitle(raw: string): string {
	const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
	return firstLine
		.replace(/^['"“”‘’]+|['"“”‘’]+$/g, "")
		.replace(/[.]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function sentenceCase(text: string): string {
	if (!text) return text;
	const lower = text.toLowerCase();
	return lower[0]!.toUpperCase() + lower.slice(1);
}

function clampWords(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const words = text.split(/\s+/);
	let out = "";
	for (const word of words) {
		const next = out ? `${out} ${word}` : word;
		if (next.length > maxChars) break;
		out = next;
	}
	return out || text.slice(0, maxChars).trim();
}
