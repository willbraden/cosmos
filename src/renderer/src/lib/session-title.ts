const TITLE_WORD_RE = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;

const LEADING_TITLE_PREFIXES = [
	/^(?:please|pls)\s+/i,
	/^(?:can|could|would|will)\s+you\s+/i,
	/^(?:tell|show|help|walk|guide)\s+me(?:\s+through)?\s+/i,
	/^i(?:'m| am)?\s+(?:trying|want|need|would\s+like)\s+to\s+/i,
	/^this\s+is\s+/i,
];

const TOPIC_PREPOSITIONS = new Set([
	"about",
	"for",
	"in",
	"into",
	"on",
	"regarding",
	"with",
]);

const ACTION_VERBS = new Set([
	"add",
	"analyze",
	"audit",
	"build",
	"check",
	"create",
	"debug",
	"document",
	"explore",
	"find",
	"fix",
	"implement",
	"improve",
	"investigate",
	"make",
	"refactor",
	"rename",
	"review",
	"ship",
	"summarize",
	"troubleshoot",
	"understand",
	"update",
	"write",
]);

const LEADING_FILLER_WORDS = new Set([
	"a",
	"an",
	"my",
	"our",
	"some",
	"the",
	"this",
	"that",
	"these",
	"those",
	"your",
]);

const TRAILING_FILLER_WORDS = new Set([
	"a",
	"an",
	"and",
	"for",
	"from",
	"in",
	"into",
	"of",
	"on",
	"or",
	"the",
	"to",
	"with",
]);

const TITLE_EXCEPTIONS: Record<string, string> = {
	api: "API",
	cli: "CLI",
	cwd: "CWD",
	gui: "GUI",
	ipc: "IPC",
	ios: "iOS",
	json: "JSON",
	jsonl: "JSONL",
	llm: "LLM",
	mcp: "MCP",
	oauth: "OAuth",
	ts: "TS",
	tsx: "TSX",
	js: "JS",
	jsx: "JSX",
	mdx: "MDX",
	typescript: "TypeScript",
	javascript: "JavaScript",
	react: "React",
};

export function summarizeSessionTitle(input: string): string {
	const normalized = input
		.replace(/https?:\/\/\S+/gi, " ")
		.replace(/[`*_#>[\](){},]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) return "";

	const phrase = firstClause(stripLeadingPrefixes(normalized));
	const topical = topicalPhrase(phrase);
	const words = pickWords(topical.words, topical.preferredLength);
	if (words.length === 0) return "";
	return formatSentenceCase(words);
}

function stripLeadingPrefixes(text: string): string {
	let next = text.trim();
	for (;;) {
		const prev = next;
		for (const prefix of LEADING_TITLE_PREFIXES)
			next = next.replace(prefix, "").trim();
		if (next === prev) return next;
	}
}

function firstClause(text: string): string {
	return text.split(/[.!?\n:;]+|\s[—-]\s|\sbut\s|\sso\s/i)[0]?.trim() ?? text;
}

function topicalPhrase(text: string): { words: string[]; preferredLength: number } {
	const words = text.match(TITLE_WORD_RE) ?? [];
	if (words.length === 0) return { words: [], preferredLength: 4 };

	for (let i = 0; i < words.length - 1; i++) {
		if (!TOPIC_PREPOSITIONS.has(words[i]!.toLowerCase())) continue;
		const tail = trimFiller(words.slice(i + 1));
		if (tail.length >= 2) return { words: tail, preferredLength: 4 };
	}

	const first = words[0]!.toLowerCase();
	if (ACTION_VERBS.has(first)) {
		const tail = trimFiller(words.slice(1));
		if (tail.length >= 3) return { words: tail, preferredLength: 4 };
		if (tail.length >= 2) return { words, preferredLength: 3 };
	}

	return { words: trimTrailingFiller(words), preferredLength: 4 };
}

function trimFiller(words: string[]): string[] {
	let start = 0;
	while (
		start < words.length &&
		LEADING_FILLER_WORDS.has(words[start]!.toLowerCase())
	) {
		start++;
	}
	return trimTrailingFiller(words.slice(start));
}

function trimTrailingFiller(words: string[]): string[] {
	const trimmed = [...words];
	while (
		trimmed.length > 2 &&
		TRAILING_FILLER_WORDS.has(trimmed[trimmed.length - 1]!.toLowerCase())
	) {
		trimmed.pop();
	}
	return trimmed;
}

function pickWords(words: string[], preferredLength: number): string[] {
	if (words.length <= 5) return words;
	const target = Math.min(5, Math.max(3, preferredLength));
	const picked = trimTrailingFiller(words.slice(0, target));
	if (picked.length >= 3) return picked;
	return trimTrailingFiller(words.slice(0, 5));
}

function formatSentenceCase(words: string[]): string {
	return words.map((word, index) => formatWord(word, index === 0)).join(" ");
}

function formatWord(word: string, capitalize: boolean): string {
	const lower = word.toLowerCase();
	const exception = TITLE_EXCEPTIONS[lower];
	if (exception) return exception;
	if (/^[A-Z0-9]{2,}$/.test(word)) return word;
	if (/[a-z][A-Z]|[A-Z][a-z].*[A-Z]/.test(word)) return word;
	if (!capitalize) return lower;
	if (word.length === 1) return word.toUpperCase();
	return word[0]!.toUpperCase() + lower.slice(1);
}
