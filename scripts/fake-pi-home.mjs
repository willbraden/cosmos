// Creates an isolated pi agent directory wired to the fake LLM server, so the app and
// tests can run without touching the user's real ~/.pi or needing API keys.
//
//   node scripts/fake-pi-home.mjs <agentDir> <port>
//   PI_CODING_AGENT_DIR=<agentDir> npm run dev

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeFakePiHome(agentDir, port) {
	mkdirSync(join(agentDir, "sessions"), { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					fake: {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						apiKey: "fake-key",
						models: [
							{
								id: "fake-model",
								name: "Fake Model",
								reasoning: true,
								input: ["text", "image"],
								contextWindow: 128000,
								maxTokens: 8192,
								cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
							},
						],
					},
				},
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model", defaultThinkingLevel: "medium" }, null, 2),
	);
	return agentDir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [agentDir, port] = process.argv.slice(2);
	if (!agentDir || !port) {
		console.error("usage: node scripts/fake-pi-home.mjs <agentDir> <port>");
		process.exit(2);
	}
	writeFakePiHome(agentDir, Number(port));
	console.log(`Wrote fake pi home to ${agentDir}`);
}
