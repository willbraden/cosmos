import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
	main: {
		build: {
			rollupOptions: {
				input: { index: resolve("src/main/index.ts") },
			},
		},
	},
	preload: {
		build: {
			rollupOptions: {
				input: { index: resolve("src/preload/index.ts") },
				// Sandboxed preload scripts must be CommonJS.
				output: { format: "cjs", entryFileNames: "[name].cjs" },
			},
		},
	},
	renderer: {
		root: resolve("src/renderer"),
		resolve: { alias: { "@shared": resolve("src/shared") } },
		build: {
			rollupOptions: { input: { index: resolve("src/renderer/index.html") } },
		},
		plugins: [react()],
	},
});
