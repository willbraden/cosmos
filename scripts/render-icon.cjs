// Renders build/icon.png (1024x1024) with Electron's own renderer.
// Source priority:
//   1. build/cosmos-icon.icon (Apple Icon Composer bundle)
//   2. build/icon.svg
// Then generate build/icon.icns from build/icon.png separately.
//   npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require("electron");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const buildDir = join(__dirname, "../build");
const iconBundleDir = join(buildDir, "cosmos-icon.icon");
const svgPath = join(buildDir, "icon.svg");
const pngPath = join(buildDir, "icon.png");

function cssColor(raw) {
	if (typeof raw !== "string") return "rgba(0, 0, 0, 1)";
	const match = raw.match(/^display-p3:([\d.]+),([\d.]+),([\d.]+),([\d.]+)$/);
	if (!match) return raw;
	const [, r, g, b, a] = match;
	return `color(display-p3 ${r} ${g} ${b} / ${a})`;
}

function imageDataUrl(path) {
	return `data:image/png;base64,${readFileSync(path).toString("base64")}`;
}

function getOpacity(layer) {
	return layer["opacity-specializations"]?.[0]?.value ?? 1;
}

function buildIconComposerHtml() {
	const iconJson = JSON.parse(readFileSync(join(iconBundleDir, "icon.json"), "utf8"));
	const gradient = iconJson["fill-specializations"]?.[0]?.value?.["linear-gradient"] ?? [
		"display-p3:0.11262,0.11262,0.11262,1.00000",
		"display-p3:0.00000,0.00000,0.00000,1.00000"
	];
	const group = iconJson.groups?.[0];
	const layers = (group?.layers ?? [])
		.map((layer) => {
			const src = imageDataUrl(join(iconBundleDir, "Assets", layer["image-name"]));
			return `<img class="layer" src="${src}" style="opacity:${getOpacity(layer)}">`;
		})
		.join("");

	return `<!doctype html>
<html>
	<head>
		<style>
			html, body {
				margin: 0;
				width: 1024px;
				height: 1024px;
				background: transparent;
				overflow: hidden;
			}
			.stage {
				position: relative;
				width: 1024px;
				height: 1024px;
			}
			.tile {
				position: absolute;
				inset: 0;
				border-radius: 23%;
				background: linear-gradient(180deg, ${cssColor(gradient[0])} 0%, ${cssColor(gradient[1])} 100%);
			}
			.glow {
				position: absolute;
				inset: 0;
				border-radius: 23%;
				background: radial-gradient(circle at 50% 28%, rgba(255,255,255,0.18), rgba(255,255,255,0) 58%);
			}
			.stack {
				position: absolute;
				inset: 0;
				filter: drop-shadow(0 22px 36px rgba(0, 0, 0, 0.30));
			}
			.layer {
				position: absolute;
				inset: 0;
				width: 1024px;
				height: 1024px;
			}
		</style>
	</head>
	<body>
		<div class="stage">
			<div class="tile"></div>
			<div class="glow"></div>
			<div class="stack">${layers}</div>
		</div>
	</body>
</html>`;
}

function buildHtml() {
	if (existsSync(join(iconBundleDir, "icon.json"))) {
		console.log("Rendering icon from build/cosmos-icon.icon");
		return buildIconComposerHtml();
	}

	console.log("Rendering icon from build/icon.svg");
	const svg = readFileSync(svgPath, "utf8");
	return `<!doctype html><html style="margin:0;background:transparent"><body style="margin:0;background:transparent">${svg}</body></html>`;
}

app.dock?.hide();
app.whenReady().then(async () => {
	const win = new BrowserWindow({
		width: 1024,
		height: 1024,
		show: false,
		transparent: true,
		backgroundColor: "#00000000",
		frame: false,
		webPreferences: { offscreen: true }
	});
	win.webContents.setZoomFactor(1);
	await win.loadURL(`data:text/html,${encodeURIComponent(buildHtml())}`);
	await new Promise((r) => setTimeout(r, 400));
	const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
	const png = image.getSize().width === 1024 ? image.toPNG() : image.resize({ width: 1024, height: 1024, quality: "best" }).toPNG();
	writeFileSync(pngPath, png);
	console.log("wrote build/icon.png", image.getSize());
	app.quit();
});
