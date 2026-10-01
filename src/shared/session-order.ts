import type { SessionSummary } from "./ipc";

export interface SessionOrderItem {
	created: number;
	modified: number;
	stableKey: string;
}

export type SessionDropPlacement = "before" | "after" | "end";

/**
 * Keep sessions in a stable sidebar order: newest-created first, then most recently
 * modified only as a tiebreaker, then a deterministic key.
 */
export function compareSessionOrder(
	a: SessionOrderItem,
	b: SessionOrderItem,
): number {
	return (
		b.created - a.created ||
		b.modified - a.modified ||
		a.stableKey.localeCompare(b.stableKey)
	);
}

export function compareSessionSummaries(
	a: SessionSummary,
	b: SessionSummary,
): number {
	return compareSessionOrder(
		{ created: a.created, modified: a.modified, stableKey: a.path },
		{ created: b.created, modified: b.modified, stableKey: b.path },
	);
}

/** Apply a saved manual order, keeping unsorted items in the default stable order after it. */
export function applyManualSessionOrder<T extends SessionOrderItem>(
	items: T[],
	manualOrder: string[] | undefined,
): T[] {
	if (!manualOrder?.length) return [...items].sort(compareSessionOrder);
	const orderIndex = new Map(manualOrder.map((key, index) => [key, index]));
	return [...items].sort((a, b) => {
		const aIndex = orderIndex.get(a.stableKey);
		const bIndex = orderIndex.get(b.stableKey);
		if (aIndex !== undefined && bIndex !== undefined)
			return aIndex - bIndex || compareSessionOrder(a, b);
		if (aIndex !== undefined) return -1;
		if (bIndex !== undefined) return 1;
		return compareSessionOrder(a, b);
	});
}

/** Move one session key within the current rendered order. */
export function moveSessionOrderItem(
	currentOrder: string[],
	draggingKey: string,
	targetKey: string | null,
	placement: SessionDropPlacement,
): string[] {
	const deduped = [...new Set(currentOrder)];
	const withoutDragging = deduped.filter((key) => key !== draggingKey);
	if (!deduped.includes(draggingKey)) withoutDragging.unshift(draggingKey);
	if (placement === "end" || !targetKey) return [...withoutDragging, draggingKey];
	const targetIndex = withoutDragging.indexOf(targetKey);
	if (targetIndex < 0) return [...withoutDragging, draggingKey];
	const insertAt = placement === "before" ? targetIndex : targetIndex + 1;
	withoutDragging.splice(insertAt, 0, draggingKey);
	return withoutDragging;
}
