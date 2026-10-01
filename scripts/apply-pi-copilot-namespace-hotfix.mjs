import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const target = join(
	process.cwd(),
	"node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-WIUZI2CJ.js",
);

const before =
	"...isSameModel&&toolCall.namespace!==void 0?{namespace:toolCall.namespace}:{}";
const after =
	"...toolCall.namespace!==void 0?{namespace:toolCall.namespace}:{}";

const source = readFileSync(target, "utf8");
if (source.includes(after)) {
	console.log("Pi Copilot namespace hotfix already applied.");
	process.exit(0);
}
if (!source.includes(before)) {
	console.error("Pi Copilot namespace hotfix target not found:", target);
	process.exit(1);
}

writeFileSync(target, source.replaceAll(before, after));
console.log("Applied Pi Copilot namespace hotfix:", target);
