import { useEffect, useRef } from "react";

/**
 * Drifting stars joined by proximity lines, behind the home page only.
 *
 * Sized to its container rather than the window: it lives inside `.home`, so
 * window-sized geometry would misplace the field whenever the sidebar is
 * resized or collapsed.
 */

const COUNT = 50;
/** Stars closer than this get a connecting line; opacity falls off with distance. */
const LINK_DISTANCE = 120;
const DRIFT = 0.15;

interface Star {
	x: number;
	y: number;
	vx: number;
	vy: number;
	r: number;
	phase: number;
}

export function ConstellationField() {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		let width = 0;
		let height = 0;
		let stars: Star[] = [];

		const seed = () => {
			stars = Array.from({ length: COUNT }, () => ({
				x: Math.random() * width,
				y: Math.random() * height,
				vx: (Math.random() - 0.5) * DRIFT,
				vy: (Math.random() - 0.5) * DRIFT,
				r: 0.8 + Math.random() * 0.8,
				phase: Math.random() * Math.PI * 2,
			}));
		};

		const resize = () => {
			const rect = canvas.getBoundingClientRect();
			width = rect.width;
			height = rect.height;
			canvas.width = Math.max(1, Math.round(width * dpr));
			canvas.height = Math.max(1, Math.round(height * dpr));
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			// Re-seed so stars spread across the new area instead of clumping
			// wherever they happened to be.
			seed();
		};

		resize();

		let t = 0;
		const draw = () => {
			if (width <= 0 || height <= 0) return;
			// Read every frame so the field retints with the theme, with no
			// need to tear the animation down and restart it.
			const color =
				getComputedStyle(canvas).getPropertyValue("--home-constellation-color").trim() ||
				"#888888";

			t += 0.01;
			ctx.clearRect(0, 0, width, height);

			for (const s of stars) {
				s.x += s.vx;
				s.y += s.vy;
				if (s.x < 0) s.x = width;
				if (s.x > width) s.x = 0;
				if (s.y < 0) s.y = height;
				if (s.y > height) s.y = 0;
			}

			ctx.strokeStyle = color;
			ctx.lineWidth = 0.5;
			for (let i = 0; i < stars.length; i++) {
				for (let j = i + 1; j < stars.length; j++) {
					const dx = stars[i].x - stars[j].x;
					const dy = stars[i].y - stars[j].y;
					const d = Math.hypot(dx, dy);
					if (d >= LINK_DISTANCE) continue;
					ctx.globalAlpha = (1 - d / LINK_DISTANCE) * 0.15;
					ctx.beginPath();
					ctx.moveTo(stars[i].x, stars[i].y);
					ctx.lineTo(stars[j].x, stars[j].y);
					ctx.stroke();
				}
			}

			ctx.fillStyle = color;
			for (const s of stars) {
				const twinkle = 0.5 + 0.5 * Math.sin(t * 2 + s.phase);
				ctx.globalAlpha = 0.15 + twinkle * 0.25;
				ctx.beginPath();
				ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
				ctx.fill();
			}
			ctx.globalAlpha = 1;
		};

		const observer = new ResizeObserver(() => {
			resize();
			draw();
		});
		observer.observe(canvas);

		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
		let raf = 0;

		const start = () => {
			cancelAnimationFrame(raf);
			if (reduced.matches) {
				// One static frame: the texture survives, the motion does not.
				draw();
				return;
			}
			const tick = () => {
				draw();
				raf = requestAnimationFrame(tick);
			};
			raf = requestAnimationFrame(tick);
		};

		start();
		reduced.addEventListener("change", start);

		return () => {
			cancelAnimationFrame(raf);
			reduced.removeEventListener("change", start);
			observer.disconnect();
		};
	}, []);

	return <canvas ref={canvasRef} className="home-constellations" aria-hidden="true" />;
}
