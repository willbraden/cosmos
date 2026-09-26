/** The Cosmos mark: a ringed planet with a small star. Uses currentColor for theming. */
export function CosmosMark({ size = 24 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden>
			{/* Back half of the ring, behind the planet */}
			<path d="M7 31.5c-2.6-4.4 5.3-11.2 17.6-15.2S46.8 13 41 17" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" opacity="0.45" />
			<circle cx="24" cy="24" r="11" fill="currentColor" />
			{/* Front half of the ring, over the planet */}
			<path d="M41 17c2.6 4.4-5.3 11.2-17.6 15.2S1.2 35 7 31.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
			<path d="M38 5.5l1.1 2.9 2.9 1.1-2.9 1.1-1.1 2.9-1.1-2.9-2.9-1.1 2.9-1.1z" fill="currentColor" />
		</svg>
	);
}
