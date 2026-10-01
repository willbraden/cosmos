import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

const TOOLTIP_TARGET = "button.icon-btn";
const VIEWPORT_MARGIN = 8;
const TOOLTIP_GAP = 10;

type TooltipState = {
	target: HTMLButtonElement;
	text: string;
};

type TooltipPosition = {
	left: number;
	top: number;
	placement: "top" | "bottom";
};

function findTarget(node: EventTarget | null): HTMLButtonElement | null {
	if (!(node instanceof Element)) return null;
	const target = node.closest(TOOLTIP_TARGET);
	return target instanceof HTMLButtonElement ? target : null;
}

function tooltipText(target: HTMLButtonElement): string {
	return (
		target.dataset.tooltip?.trim() ||
		target.getAttribute("aria-label")?.trim() ||
		target.getAttribute("title")?.trim() ||
		""
	);
}

function computePosition(target: HTMLButtonElement, tooltip: HTMLDivElement): TooltipPosition {
	const rect = target.getBoundingClientRect();
	const tip = tooltip.getBoundingClientRect();
	const viewportWidth = window.innerWidth;
	const viewportHeight = window.innerHeight;
	const centerX = rect.left + rect.width / 2;
	const centerY = rect.top + rect.height / 2;
	const preferBottom = centerY <= viewportHeight / 2;
	const fitsBelow = rect.bottom + TOOLTIP_GAP + tip.height <= viewportHeight - VIEWPORT_MARGIN;
	const fitsAbove = rect.top - TOOLTIP_GAP - tip.height >= VIEWPORT_MARGIN;
	const placement = preferBottom
		? fitsBelow || !fitsAbove
			? "bottom"
			: "top"
		: fitsAbove || !fitsBelow
			? "top"
			: "bottom";

	let top = placement === "bottom" ? rect.bottom + TOOLTIP_GAP : rect.top - TOOLTIP_GAP - tip.height;
	let left = centerX - tip.width / 2;
	if (centerX <= viewportWidth * 0.35) left = rect.left;
	else if (centerX >= viewportWidth * 0.65) left = rect.right - tip.width;

	left = Math.min(Math.max(left, VIEWPORT_MARGIN), viewportWidth - VIEWPORT_MARGIN - tip.width);
	top = Math.min(Math.max(top, VIEWPORT_MARGIN), viewportHeight - VIEWPORT_MARGIN - tip.height);
	return { left, top, placement };
}

export function IconButtonTooltips() {
	const tooltipRef = useRef<HTMLDivElement>(null);
	const activeTargetRef = useRef<HTMLButtonElement | null>(null);
	const titleCacheRef = useRef(new WeakMap<HTMLButtonElement, string>());
	const [tooltip, setTooltip] = useState<TooltipState | null>(null);
	const [position, setPosition] = useState<TooltipPosition | null>(null);

	const restoreTitle = (target: HTMLButtonElement | null) => {
		if (!target) return;
		const title = titleCacheRef.current.get(target);
		if (title && !target.hasAttribute("title")) target.setAttribute("title", title);
	};

	const hideTooltip = () => {
		restoreTitle(activeTargetRef.current);
		activeTargetRef.current = null;
		setTooltip(null);
		setPosition(null);
	};

	const showTooltip = (target: HTMLButtonElement) => {
		if (target.disabled) return hideTooltip();
		const text = tooltipText(target);
		if (!text) return hideTooltip();
		if (activeTargetRef.current && activeTargetRef.current !== target)
			restoreTitle(activeTargetRef.current);
		activeTargetRef.current = target;
		const title = target.getAttribute("title");
		if (title) {
			titleCacheRef.current.set(target, title);
			target.removeAttribute("title");
		}
		setPosition(null);
		setTooltip((current) =>
			current?.target === target && current.text === text ? current : { target, text },
		);
	};

	const updatePosition = () => {
		const target = activeTargetRef.current;
		const tooltipNode = tooltipRef.current;
		if (!target || !tooltipNode) return;
		if (!target.isConnected) return hideTooltip();
		setPosition(computePosition(target, tooltipNode));
	};

	useEffect(() => {
		const onPointerOver = (event: PointerEvent) => {
			const target = findTarget(event.target);
			if (target) showTooltip(target);
		};
		const onPointerOut = (event: PointerEvent) => {
			const current = activeTargetRef.current;
			if (!current) return;
			const next = findTarget(event.relatedTarget);
			if (next) return showTooltip(next);
			if (event.target instanceof Node && current.contains(event.target)) hideTooltip();
		};
		const onFocusIn = (event: FocusEvent) => {
			const target = findTarget(event.target);
			if (target) showTooltip(target);
		};
		const onFocusOut = (event: FocusEvent) => {
			const next = findTarget(event.relatedTarget);
			if (next) return showTooltip(next);
			hideTooltip();
		};
		const onPointerDown = () => hideTooltip();
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") hideTooltip();
		};

		document.addEventListener("pointerover", onPointerOver);
		document.addEventListener("pointerout", onPointerOut);
		document.addEventListener("focusin", onFocusIn);
		document.addEventListener("focusout", onFocusOut);
		document.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerover", onPointerOver);
			document.removeEventListener("pointerout", onPointerOut);
			document.removeEventListener("focusin", onFocusIn);
			document.removeEventListener("focusout", onFocusOut);
			document.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
			window.removeEventListener("keydown", onKeyDown);
			restoreTitle(activeTargetRef.current);
		};
	}, []);

	useLayoutEffect(() => {
		if (!tooltip) return;
		updatePosition();
	}, [tooltip]);

	if (!tooltip) return null;
	return createPortal(
		<div
			ref={tooltipRef}
			role="tooltip"
			className={`icon-tooltip${position ? " visible" : ""}`}
			data-placement={position?.placement ?? "bottom"}
			style={{
				left: position?.left ?? -9999,
				top: position?.top ?? -9999,
			}}
		>
			{tooltip.text}
		</div>,
		document.body,
	);
}
