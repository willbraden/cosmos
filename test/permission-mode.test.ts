import { describe, expect, it } from "vitest";
import { tabsNeedPermissionModeSync } from "../src/renderer/src/state/permission-mode";

describe("tabsNeedPermissionModeSync", () => {
	it("returns true when any open tab is still on a different mode", () => {
		expect(
			tabsNeedPermissionModeSync(
				[{ permissionMode: "ask" }, { permissionMode: "auto" }],
				"auto",
			),
		).toBe(true);
	});

	it("returns false when every tab already matches the target mode", () => {
		expect(
			tabsNeedPermissionModeSync(
				[{ permissionMode: "auto" }, { permissionMode: "auto" }],
				"auto",
			),
		).toBe(false);
	});
});
