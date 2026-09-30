import type { PermissionMode } from "@shared/ipc";

export interface PermissionModeState {
	permissionMode: PermissionMode;
}

export function tabsNeedPermissionModeSync(
	tabs: Iterable<PermissionModeState>,
	mode: PermissionMode,
): boolean {
	for (const tab of tabs) {
		if (tab.permissionMode !== mode) return true;
	}
	return false;
}
