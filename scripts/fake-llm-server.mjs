// Scripted OpenAI-compatible chat-completions server for testing Cosmos end to end
// without a real provider. Pi talks to it through a models.json provider entry
// (see scripts/fake-pi-home.mjs). Responses are chosen from keywords in the last user
// message so tests and manual runs can exercise text, thinking, and each tool.
//
//   node scripts/fake-llm-server.mjs [port]

import { createServer } from "node:http";

const DEFAULT_REPLY = `## Hello from the fake model

This reply exercises **markdown** rendering:

- a bullet with \`inline code\`
- a [link](https://pi.dev)

\`\`\`ts
export function greet(name: string): string {
	return \`Hello, \${name}!\`;
}
\`\`\`

| Feature | Status |
| --- | --- |
| Streaming | ✅ |
| Tables | ✅ |
`;

function scenario(messages) {
	const last = messages[messages.length - 1];
	if (last?.role === "tool") {
		const failed = typeof last.content === "string" && /denied|blocked/i.test(last.content);
		return {
			text: failed
				? "Understood — I won't do that. How would you like to proceed?"
				: "Done. The tool finished successfully — let me know if you want anything else.",
		};
	}
	const text = userText(last).toLowerCase();
	if (text.includes("write")) {
		return {
			thinking: "The user wants a file. I'll create hello.txt with a greeting.",
			tool: { name: "write", args: { path: "hello.txt", content: "Hello from Pi Desktop\nSecond line\n" } },
		};
	}
	if (text.includes("edit")) {
		return {
			thinking: "I'll change the greeting in hello.txt.",
			tool: { name: "edit", args: { path: "hello.txt", edits: [{ oldText: "Hello", newText: "Howdy" }] } },
		};
	}
	if (text.includes("bash") || text.includes("run")) {
		return { tool: { name: "bash", args: { command: "echo 'running in' && pwd && ls" } } };
	}
	if (text.includes("fail")) return { status: 500 };
	if (text.includes("slow")) return { text: DEFAULT_REPLY.repeat(3), delayMs: 60 };
	return { thinking: "Simple greeting; respond with a markdown sample.", text: DEFAULT_REPLY };
}

function userText(message) {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return (message.content ?? []).map((part) => part.text ?? "").join(" ");
}

function chunk(id, delta, finish = null) {
	return `data: ${JSON.stringify({
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "fake-model",
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function split(text, size) {
	const parts = [];
	for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
	return parts;
}

async function stream(res, plan) {
	const id = `chatcmpl-${Date.now()}`;
	const delay = plan.delayMs ?? 15;
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	res.write(chunk(id, { role: "assistant", content: "" }));
	if (plan.thinking) {
		for (const part of split(plan.thinking, 12)) {
			res.write(chunk(id, { reasoning_content: part }));
			await sleep(delay);
		}
	}
	if (plan.text) {
		for (const part of split(plan.text, 8)) {
			res.write(chunk(id, { content: part }));
			await sleep(delay);
		}
	}
	if (plan.tool) {
		const args = JSON.stringify(plan.tool.args);
		res.write(
			chunk(id, {
				tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: plan.tool.name, arguments: "" } }],
			}),
		);
		for (const part of split(args, 16)) {
			res.write(chunk(id, { tool_calls: [{ index: 0, function: { arguments: part } }] }));
			await sleep(delay);
		}
	}
	res.write(chunk(id, {}, plan.tool ? "tool_calls" : "stop"));
	res.write(
		`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 } })}\n\n`,
	);
	res.write("data: [DONE]\n\n");
	res.end();
}

export function startFakeLlmServer(port = 0) {
	const requests = [];
	const server = createServer((req, res) => {
		if (req.method === "GET" && req.url?.endsWith("/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ data: [{ id: "fake-model", object: "model" }] }));
		}
		if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
			res.writeHead(404);
			return res.end();
		}
		let body = "";
		req.on("data", (data) => (body += data));
		req.on("end", () => {
			const payload = JSON.parse(body || "{}");
			requests.push(payload);
			const plan = scenario(payload.messages ?? []);
			if (plan.status) {
				res.writeHead(plan.status, { "content-type": "application/json" });
				return res.end(JSON.stringify({ error: { message: "Scripted failure from fake model" } }));
			}
			stream(res, plan).catch(() => res.end());
		});
	});
	return new Promise((resolve) => {
		server.listen(port, "127.0.0.1", () => {
			resolve({ server, port: server.address().port, requests, close: () => new Promise((r) => server.close(r)) });
		});
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const { port } = await startFakeLlmServer(Number(process.argv[2] ?? 4891));
	console.log(`Fake LLM server listening on http://127.0.0.1:${port}/v1`);
}
