// Renders build/icon.svg to build/icon.png (1024x1024) with Electron's own renderer.
// electron-builder generates the macOS .icns from icon.png.
//   npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

app.dock?.hide();
app.whenReady().then(async () => {
	const svg = readFileSync(join(__dirname, "../build/icon.svg"), "utf8");
	const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
	win.webContents.setZoomFactor(1);
	await win.loadURL(`data:text/html,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)}`);
	await new Promise((r) => setTimeout(r, 400));
	const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
	const png = image.getSize().width === 1024 ? image.toPNG() : image.resize({ width: 1024, height: 1024, quality: "best" }).toPNG();
	writeFileSync(join(__dirname, "../build/icon.png"), png);
	console.log("wrote build/icon.png", image.getSize());
	app.quit();
});
