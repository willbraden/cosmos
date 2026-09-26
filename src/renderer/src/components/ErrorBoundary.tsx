import { Component, type ReactNode } from "react";
import { api } from "../lib/api";

interface State {
	error: Error | null;
}

/** Last line of defence: log the crash and offer a reload instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode; inline?: boolean }, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
		api.log("error", `React render error: ${error.stack ?? error.message}\n${info.componentStack ?? ""}`);
	}

	render(): ReactNode {
		if (!this.state.error) return this.props.children;
		if (this.props.inline) {
			return <div className="notice error">This item could not be displayed: {this.state.error.message}</div>;
		}
		return (
			<div className="empty">
				<h1>Something went wrong</h1>
				<p className="selectable">{this.state.error.message}</p>
				<button type="button" className="btn primary" onClick={() => window.location.reload()}>
					Reload window
				</button>
			</div>
		);
	}
}
