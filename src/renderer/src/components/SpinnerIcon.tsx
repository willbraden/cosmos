import type { CSSProperties } from "react";
import { useId } from "react";

// Two half-discs, mirrored, that scale horizontally to sweep the terminator
// across the moon. Geometry comes straight from the exported artwork.
const HALF_LEFT =
	"M0 5.42257C0 8.41737 2.42777 10.8451 5.42257 10.8451V0C2.42777 0 0 2.42777 0 5.42257Z";
const HALF_RIGHT =
	"M0 5.42257C0 8.41737 2.41966 10.8451 5.40446 10.8451V0C2.41966 0 0 2.42777 0 5.42257Z";
const MIRROR = "matrix(-1 0 0 1 10.827 -0.000170097)";

export function SpinnerIcon({
	size = 16,
	className = "",
	title,
}: {
	size?: number;
	className?: string;
	title?: string;
}) {
	// Each instance needs its own mask id, or they collide on the page.
	// useId() embeds colons, which are legal in an id but awkward in a
	// fragment reference, so strip them.
	const maskId = `moon-phase-${useId().replace(/:/g, "")}`;
	return (
		<svg
			className={`custom-spinner-icon${className ? ` ${className}` : ""}`}
			width={size}
			height={size}
			viewBox="0 0 14 14"
			fill="none"
			aria-hidden={title ? undefined : true}
			role={title ? "img" : undefined}
			style={{ "--spinner-size": `${size}px` } as CSSProperties}
		>
			{title ? <title>{title}</title> : null}
			{/* White shows the lit face, black the shadow, so the unlit side is
			    genuinely transparent and the icon works on any background. */}
			<mask
				id={maskId}
				maskUnits="userSpaceOnUse"
				x="0"
				y="0"
				width="14"
				height="14"
			>
				<g transform="translate(-0.00012207 3.86803) rotate(-20.896)">
					<circle cx="5.42257" cy="5.42257" r="5.42257" fill="black" />
					<path transform={MIRROR} d={HALF_RIGHT} fill="black" />
					<path className="moon-phase lit-left" d={HALF_LEFT} fill="white" />
					<path
						className="moon-phase lit-right"
						transform={MIRROR}
						d={HALF_RIGHT}
						fill="white"
					/>
					<path className="moon-phase dark-left" d={HALF_LEFT} fill="black" />
					<path
						className="moon-phase dark-right"
						transform={MIRROR}
						d={HALF_RIGHT}
						fill="black"
					/>
				</g>
			</mask>
			{/* Earthshine: keeps the disc readable through the new moon, so the
			    indicator never blinks out and looks like it has stalled. */}
			<circle
				className="moon-earthshine"
				cx="7"
				cy="7"
				r="5.42257"
				fill="currentColor"
			/>
			<rect width="14" height="14" fill="currentColor" mask={`url(#${maskId})`} />
		</svg>
	);
}
