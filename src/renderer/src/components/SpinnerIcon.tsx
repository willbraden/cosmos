import type { CSSProperties } from "react";

export function SpinnerIcon({
	size = 16,
	className = "",
	title,
}: {
	size?: number;
	className?: string;
	title?: string;
}) {
	return (
		<svg
			className={`custom-spinner-icon${className ? ` ${className}` : ""}`}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			aria-hidden={title ? undefined : true}
			role={title ? "img" : undefined}
			style={{ "--spinner-size": `${size}px` } as CSSProperties}
		>
			{title ? <title>{title}</title> : null}
			<circle className="outer" cx="12" cy="12" r="9.28" />
			<circle className="middle" cx="12" cy="12" r="5.776" />
			<circle className="inner" cx="12" cy="12" r="2.564" />
		</svg>
	);
}
