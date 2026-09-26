import { X } from "lucide-react";
import { dismissToast, useStore } from "../state/store";

export function Toasts() {
	const toasts = useStore((s) => s.toasts);
	return (
		<div className="toasts" aria-live="polite">
			{toasts.map((t) => (
				<div key={t.id} className={`toast ${t.level}`} role={t.level === "error" ? "alert" : "status"}>
					<span className="selectable">{t.message}</span>
					{t.action && (
						<button
							type="button"
							onClick={() => {
								t.action?.run();
								dismissToast(t.id);
							}}
						>
							{t.action.label}
						</button>
					)}
					<button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)} style={{ background: "transparent", padding: 2 }}>
						<X size={13} />
					</button>
				</div>
			))}
		</div>
	);
}
