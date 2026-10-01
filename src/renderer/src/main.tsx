import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { api } from "./lib/api";
import { bootstrap } from "./state/actions";
import "./styles/tokens.css";
import "./styles/app.css";

window.addEventListener("error", (event) => api.log("error", `${event.message}\n${event.error?.stack ?? ""}`));
window.addEventListener("unhandledrejection", (event) => {
	const reason = event.reason instanceof Error ? `${event.reason.message}\n${event.reason.stack}` : String(event.reason);
	api.log("error", `Unhandled rejection: ${reason}`);
});

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<ErrorBoundary>
			<App />
		</ErrorBoundary>
	</StrictMode>,
);

void bootstrap().catch((error) => api.log("error", `bootstrap failed: ${error instanceof Error ? error.stack : error}`));
