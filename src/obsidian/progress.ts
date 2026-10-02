/**
 * Progress reporting + cancellation for a run.
 *
 * A run can last from a second to a minute on a big vault, so the plugin shows
 * a live status-bar line (clickable to cancel) and, when the user asked for
 * it, a notice. The same object implements the engine's `CancelSignal`.
 */

import { Notice, setIcon } from "obsidian";
import { ExportCancelledError, type CancelSignal, type ProgressEvent } from "../core/types";

export class ExportProgress implements CancelSignal {
	private cancelledFlag = false;
	private listeners: (() => void)[] = [];
	private lastMessage = "";
	private lastRender = 0;
	private notice: Notice | null = null;

	constructor(
		private readonly statusEl: HTMLElement | null,
		private readonly showNotice: boolean,
	) {}

	get cancelled(): boolean {
		return this.cancelledFlag;
	}

	throwIfCancelled(): void {
		if (this.cancelledFlag) throw new ExportCancelledError();
	}

	onCancel(cb: () => void): void {
		this.listeners.push(cb);
	}

	cancel(): void {
		if (this.cancelledFlag) return;
		this.cancelledFlag = true;
		for (const listener of this.listeners) listener();
		this.render("Cancelling…", -1);
	}

	/** Feed an engine progress event to the UI. */
	handle = (event: ProgressEvent): void => {
		if (this.cancelledFlag) return;
		if (event.phase === "done") {
			this.render(event.message, 1);
			return;
		}
		this.render(event.message, event.progress);
	};

	private render(message: string, progress: number): void {
		const now = Date.now();
		// Throttle: the status bar does not need 200 updates per second.
		if (message === this.lastMessage && now - this.lastRender < 120) return;
		this.lastMessage = message;
		this.lastRender = now;

		if (this.statusEl) {
			this.statusEl.empty();
			this.statusEl.addClass("mod-clickable");
			this.statusEl.setAttribute("aria-label", `${message} (click to cancel)`);
			const icon = this.statusEl.createSpan({ cls: "cve-status-icon" });
			setIcon(icon, this.cancelledFlag ? "x-circle" : "loader-2");
			const text = this.statusEl.createSpan({ cls: "cve-status-text" });
			text.setText(progress > 0 && progress < 1 ? `${message} ${Math.round(progress * 100)}%` : message);
			this.statusEl.toggleClass("cve-status-error", this.cancelledFlag);
		}

		if (this.showNotice && this.notice === null) {
			this.notice = new Notice(message, 0);
		} else if (this.notice) {
			this.notice.setMessage(message);
		}
	}

	finish(): void {
		this.notice?.hide();
		this.notice = null;
		if (this.statusEl) {
			this.statusEl.empty();
			this.statusEl.removeClass("mod-clickable", "cve-status-error");
			this.statusEl.removeAttribute("aria-label");
		}
	}
}
