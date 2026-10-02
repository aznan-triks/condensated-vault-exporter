/**
 * Export dialog and preview modal.
 *
 * The dialog is intentionally a *profile picker with a few overrides* rather
 * than a wall of settings: the profile is the configuration, and everything
 * else lives in the settings tab. The preview modal is the trust builder —
 * you see the exact text that will be written, part by part, with the numbers
 * and the warnings that explain how it was built.
 */

import { App, Component, Modal, Notice, Setting, TFile, normalizePath } from "obsidian";
import type { ExportProfile, ExportResult } from "../core/types";
import { describeProfile } from "../core/profiles";
import { formatBytes, formatCount } from "../core/util";
import type { ExportRunner } from "./runner";
import type { PluginSettings } from "./settings";
import { MarkdownRenderer } from "obsidian";

export interface ExportDialogResult {
	profile: ExportProfile;
	target?: string;
}

export class ExportDialog extends Modal {
	private profile: ExportProfile;
	private target: string;
	private destination: ExportProfile["output"]["destination"];
	private incremental: ExportProfile["output"]["incremental"];
	private copyToClipboard: boolean;
	private focus: string;
	private focusMaxNotes: number;
	private folders: string[] = [];
	private running = false;
	/** Guards against a stale scope estimate overwriting a newer one. */
	private scopeToken = 0;
	private progressEl: HTMLElement | null = null;
	private buttonsEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly settings: PluginSettings,
		private readonly runner: ExportRunner,
		private readonly onSubmitted: (result: ExportDialogResult, mode: "export" | "preview") => void,
		options: { target?: string; profileId?: string } = {},
	) {
		super(app);
		this.profile =
			this.settings.profiles.find((p) => p.id === (options.profileId ?? this.settings.activeProfileId)) ??
			this.settings.profiles[0];
		this.target = options.target ?? (this.profile.targets.length === 1 ? this.profile.targets[0] : "");
		this.destination = this.profile.output.destination;
		this.incremental = this.profile.output.incremental;
		this.copyToClipboard = this.profile.output.alsoCopyToClipboard;
		this.focus = this.profile.filters.focus?.query ?? "";
		this.focusMaxNotes = this.profile.filters.focus?.maxNotes ?? 30;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("cve-dialog");
		contentEl.createEl("h2", { text: "Export to an AI-ready bundle" });

		new Setting(contentEl)
			.setName("Profile")
			.setDesc("A profile bundles the filters, the condensation and the packaging for one destination.")
			.addDropdown((dropdown) => {
				for (const profile of this.settings.profiles) {
					dropdown.addOption(profile.id, profile.name);
				}
				dropdown.setValue(this.profile.id).onChange((value) => {
					const next = this.settings.profiles.find((p) => p.id === value);
					if (!next) return;
					this.profile = next;
					this.destination = next.output.destination;
					this.incremental = next.output.incremental;
					this.copyToClipboard = next.output.alsoCopyToClipboard;
					this.focus = next.filters.focus?.query ?? "";
					this.focusMaxNotes = next.filters.focus?.maxNotes ?? 30;
					this.renderSummary();
				});
			});

		this.summaryEl = contentEl.createDiv({ cls: "cve-profile-summary" });
		this.renderSummary();

		new Setting(contentEl)
			.setName("Folder")
			.setDesc("Leaf to export. Leave empty to use the folders configured in the profile (or the whole vault).")
			.addText((text) => {
				text.setValue(this.target).setPlaceholder("(vault root)");
				text.onChange((value) => {
					this.target = value.trim();
					this.renderSummary();
				});
				const list = text.inputEl;
				list.setAttribute("list", "cve-folder-list");
				const datalist = contentEl.createEl("datalist");
				datalist.id = "cve-folder-list";
				void this.runner.listFolders().then((folders) => {
					this.folders = folders;
					for (const folder of folders.slice(0, 400)) {
						datalist.createEl("option", { value: folder });
					}
				});
			});

		new Setting(contentEl)
			.setName("Topic focus")
			.setDesc("Optional: rank the notes against a topic and export only the best matches.")
			.addText((text) =>
				text.setValue(this.focus).setPlaceholder("e.g. retrieval evaluation").onChange((value) => {
					this.focus = value;
				}),
			)
			.addExtraButton((button) =>
				button
					.setIcon("magnifying-glass")
					.setTooltip("How many notes to keep")
					.onClick(() => {
						const next = window.prompt("Keep how many of the best-matching notes? (0 = no cap)", String(this.focusMaxNotes));
						if (next === null) return;
						const parsed = Number.parseInt(next, 10);
						if (Number.isFinite(parsed) && parsed >= 0) this.focusMaxNotes = parsed;
					}),
			);

		new Setting(contentEl)
			.setName("Destination")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("vault", "Vault folder")
					.addOption("clipboard", "Clipboard")
					.addOption("filesystem", "External folder (desktop)")
					.setValue(this.destination)
					.onChange((value) => {
						this.destination = value as ExportProfile["output"]["destination"];
					});
			});

		new Setting(contentEl)
			.setName("Incremental")
			.setDesc("Only include notes that changed since the last export of this profile.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("off", "Everything")
					.addOption("delta", "Only what changed")
					.setValue(this.incremental)
					.onChange((value) => {
						this.incremental = value as ExportProfile["output"]["incremental"];
					});
			});

		new Setting(contentEl).setName("Also copy to the clipboard").addToggle((toggle) =>
			toggle.setValue(this.copyToClipboard).onChange((value) => {
				this.copyToClipboard = value;
			}),
		);

		this.progressEl = contentEl.createDiv({ cls: "cve-progress" });
		this.buttonsEl = contentEl.createDiv({ cls: "cve-dialog-buttons" });
		this.renderButtons();
	}

	private summaryEl: HTMLElement | null = null;

	private renderSummary(): void {
		if (!this.summaryEl) return;
		this.summaryEl.empty();
		this.summaryEl.createEl("p", { text: this.profile.description });
		const lines = describeProfile(this.profile).split("\n");
		const list = this.summaryEl.createEl("ul", { cls: "cve-summary-list" });
		for (const line of lines.slice(0, 6)) list.createEl("li", { text: line.replace(/^[-•]\s*/, "") });
		if (this.profile.targets.length > 0) {
			this.summaryEl.createEl("p", {
				cls: "cve-hint",
				text: `Profile folders: ${this.profile.targets.join(", ")}`,
			});
		}
		const focus = this.focus.trim();
		if (focus !== "") {
			this.summaryEl.createEl("p", {
				cls: "cve-hint",
				text: `Topic focus: “${focus}”${
					this.focusMaxNotes > 0 ? ` — up to ${formatCount(this.focusMaxNotes)} note(s)` : ""
				}`,
			});
		}
		// A scope estimate costs one cached file listing and answers the first
		// question a user has: how big is this export going to be?
		const scopeEl = this.summaryEl.createEl("p", { cls: "cve-hint" });
		const target = this.target;
		this.scopeToken++;
		const token = this.scopeToken;
		scopeEl.setText("Counting the notes in scope…");
		void this.runner
			.estimateScope(target)
			.then(({ notes, bytes }) => {
				if (token !== this.scopeToken || !scopeEl.isConnected) return;
				const tokens = Math.round(bytes / 4);
				scopeEl.setText(
					`In scope: ${formatCount(notes)} note(s) · ${formatBytes(bytes)} of Markdown (≈ ${formatCount(tokens)} tokens) · ${this.describeBudget()}`,
				);
			})
			.catch(() => scopeEl.setText(""));
	}

	private describeBudget(): string {
		const limits = this.profile.limits;
		if (limits.maxWordsPerPart > 0) return `up to ${formatCount(limits.maxWordsPerPart)} words per part`;
		if (limits.maxTokensPerPart > 0) return `up to ~${formatCount(limits.maxTokensPerPart)} tokens per part`;
		if (limits.maxTotalWords > 0) return `total budget ${formatCount(limits.maxTotalWords)} words`;
		return "no size limit";
	}

	private renderButtons(): void {
		if (!this.buttonsEl) return;
		this.buttonsEl.empty();
		if (this.running) {
			const cancel = this.buttonsEl.createEl("button", { text: "Cancel run" });
			cancel.addClass("mod-warning");
			cancel.onclick = () => {
				this.runner.cancel();
				cancel.setText("Cancelling…");
			};
			return;
		}
		const preview = this.buttonsEl.createEl("button", { text: "Preview" });
		preview.onclick = () => this.submit("preview");
		const exportButton = this.buttonsEl.createEl("button", { text: "Export", cls: "mod-cta" });
		exportButton.onclick = () => this.submit("export");
		const close = this.buttonsEl.createEl("button", { text: "Close" });
		close.onclick = () => this.close();
	}

	private submit(mode: "export" | "preview"): void {
		const query = this.focus.trim();
		const profile: ExportProfile = {
			...this.profile,
			targets: this.target === "" ? this.profile.targets : [this.target],
			filters: {
				...this.profile.filters,
				focus: query === "" ? null : { query, maxNotes: this.focusMaxNotes },
			},
			output: {
				...this.profile.output,
				destination: this.destination,
				incremental: this.incremental,
				alsoCopyToClipboard: this.copyToClipboard,
			},
		};
		this.close();
		this.onSubmitted({ profile, target: this.target === "" ? undefined : this.target }, mode);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/* -------------------------------------------------------------------------- */
/*  Preview                                                                    */
/* -------------------------------------------------------------------------- */

export class PreviewModal extends Modal {
	private partIndex = 0;
	private readonly closeables: Component[] = [];
	private readonly container: HTMLElement;
	private copyButton: HTMLButtonElement | null = null;

	constructor(
		app: App,
		private readonly result: ExportResult,
		private readonly onExport: () => void,
	) {
		super(app);
		this.container = this.contentEl;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("cve-preview-modal");
		contentEl.createEl("h2", { text: "Bundle preview" });

		const stats = contentEl.createDiv({ cls: "cve-preview-stats" });
		this.renderStats(stats);

		const warnings = contentEl.createDiv({ cls: "cve-preview-warnings" });
		this.renderWarnings(warnings);

		if (this.result.parts.length > 1) {
			new Setting(contentEl).setName("Part").addDropdown((dropdown) => {
				for (const part of this.result.parts) {
					dropdown.addOption(String(part.index), `Part ${part.index + 1} of ${part.total} — ${formatCount(part.words)} words`);
				}
				dropdown.setValue("0").onChange((value) => {
					this.partIndex = Number(value);
					void this.renderPart();
				});
			});
		}

		this.renderDelta(contentEl);

		this.bodyEl = contentEl.createDiv({ cls: "cve-preview-body" });
		void this.renderPart();

		const buttons = contentEl.createDiv({ cls: "cve-dialog-buttons" });
		this.copyButton = buttons.createEl("button", { text: "Copy to clipboard" });
		this.copyButton.onclick = () => void this.copy();
		if (this.result.instructions) {
			const instructions = buttons.createEl("button", { text: "Copy custom instructions" });
			instructions.setAttribute(
				"aria-label",
				"Copy the paste-ready instructions for the destination model",
			);
			instructions.onclick = () => {
				void this.copyText(this.result.instructions ?? "", "Instructions copied — paste them into the notebook's instructions field.");
			};
		}
		if (this.result.report) {
			const report = buttons.createEl("button", { text: "Copy export report" });
			report.setAttribute("aria-label", "Copy what was kept, left out and cleaned up, with the reasons");
			report.onclick = () => {
				void this.copyText(this.result.report ?? "", "Export report copied — it lists what was left out and why.");
			};
		}
		const exportButton = buttons.createEl("button", { text: "Export now", cls: "mod-cta" });
		exportButton.onclick = () => {
			this.close();
			this.onExport();
		};
		const close = buttons.createEl("button", { text: "Close" });
		close.onclick = () => this.close();
	}

	private bodyEl: HTMLElement | null = null;

	/** "What changed since the last export" — the question behind a re-run. */
	private renderDelta(parent: HTMLElement): void {
		const delta = this.result.delta;
		if (!delta || !delta.known) return;
		const total = delta.added.length + delta.changed.length + delta.removed.length;
		const box = parent.createDiv({ cls: "cve-preview-delta" });
		if (total === 0) {
			box.setText(`Identical to the previous export (${delta.unchanged} notes unchanged).`);
			return;
		}
		box.setText(
			`Since the previous export: ${delta.added.length} new, ${delta.changed.length} changed, ${delta.removed.length} note(s) gone, ${delta.unchanged} unchanged.`,
		);
		const details = box.createDiv({ cls: "cve-preview-delta-details" });
		for (const [label, paths] of [
			["New", delta.added],
			["Changed", delta.changed],
			["Gone", delta.removed],
		] as [string, string[]][]) {
			if (paths.length === 0) continue;
			details.createDiv({
				text: `${label}: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ` … +${paths.length - 5} more` : ""}`,
			});
		}
	}

	private renderStats(el: HTMLElement): void {
		const stats = this.result.stats;
		const rows: [string, string][] = [
			["Notes kept", `${stats.kept} of ${stats.discovered} discovered`],
			["Words", formatCount(stats.words)],
			["Tokens", `~${formatCount(stats.tokens)}`],
			[
				"Parts",
				this.result.parts[0]?.volumeTotal > 1
					? `${this.result.parts.length} in ${this.result.parts[0].volumeTotal} volumes`
					: `${this.result.parts.length}`,
			],
			["Filters", `${stats.droppedByFilter} filtered · ${stats.droppedAsDuplicate} duplicates · ${stats.droppedAsStub} stubs`],
			["Condensed", `${stats.boilerplateLines} boilerplate lines · ${stats.summarized} summarised notes`],
		];
		if (this.result.chunking.partLimitTokens > 0) {
			rows.push([
				"Part budget",
				`~${formatCount(this.result.chunking.partLimitTokens)} tokens (${formatCount(
					this.result.chunking.overheadTokens,
				)} used by the header/map)`,
			]);
		}
		const table = el.createEl("table");
		for (const [key, value] of rows) {
			const row = table.createEl("tr");
			row.createEl("th", { text: key });
			row.createEl("td", { text: value });
		}
	}

	private renderWarnings(el: HTMLElement): void {
		const errors = this.result.warnings.filter((w) => w.startsWith("❌"));
		const warnings = this.result.warnings.filter((w) => w.startsWith("⚠️"));
		const info = this.result.warnings.filter((w) => !w.startsWith("❌") && !w.startsWith("⚠️"));
		for (const [list, cls] of [
			[errors, "cve-error"],
			[warnings, "cve-warning"],
			[info, "cve-info"],
		] as const) {
			for (const message of list.slice(0, 8)) {
				el.createEl("div", { cls: `cve-warning-line ${cls}`, text: message.replace(/^[❌⚠️ℹ️]\s*/u, "") });
			}
			if (list.length > 8) el.createEl("div", { cls: "cve-hint", text: `… and ${list.length - 8} more` });
		}
	}

	private async renderPart(): Promise<void> {
		if (!this.bodyEl) return;
		const part = this.result.parts[this.partIndex];
		this.bodyEl.empty();
		if (!part) return;
		const format = this.result.manifest.format;
		if (format === "markdown" && part.content.length < 200_000) {
			const target = this.bodyEl.createDiv({ cls: "markdown-rendered cve-preview-markdown" });
			// Rendering markdown can build child components (embeds, links):
			// attach them to the modal so they unload when it closes.
			const component = new Component();
			component.load();
			await MarkdownRenderer.render(this.app, part.content, target, "", component);
			this.closeables.push(component);
		} else {
			const pre = this.bodyEl.createEl("pre", { cls: "cve-preview-raw" });
			pre.setText(part.content.slice(0, 200_000));
		}
	}

	/** Copies arbitrary text, with the same feedback path as the bundle copy. */
	async copyText(text: string, message: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			const el = document.createElement("textarea");
			el.value = text;
			document.body.appendChild(el);
			el.select();
			document.execCommand("copy");
			el.remove();
		}
		new Notice(message);
	}

	private async copy(): Promise<void> {
		const text = this.result.parts.map((p) => p.content).join("\n\n");
		try {
			await navigator.clipboard.writeText(text);
			new Notice(`Copied ${formatCount(text.length)} characters to the clipboard.`);
		} catch {
			new Notice("Could not write to the clipboard.");
		}
	}

	onClose(): void {
		for (const component of this.closeables) component.unload();
		this.closeables.length = 0;
		this.contentEl.empty();
	}
}

/* -------------------------------------------------------------------------- */
/*  Small confirm dialog                                                       */
/* -------------------------------------------------------------------------- */

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly message: string,
		private readonly confirmLabel: string,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h2", { text: this.title });
		this.contentEl.createEl("p", { text: this.message });
		const buttons = this.contentEl.createDiv({ cls: "cve-dialog-buttons" });
		const confirm = buttons.createEl("button", { text: this.confirmLabel, cls: "mod-warning" });
		confirm.onclick = () => {
			this.close();
			this.onConfirm();
		};
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Opens the first produced file, if it lives in the vault. */
export async function openFirstResult(app: App, result: ExportResult): Promise<void> {
	const first = result.written.find((path) => path.endsWith(".md"));
	if (!first) return;
	const file = app.vault.getAbstractFileByPath(normalizePath(first));
	if (file instanceof TFile) await app.workspace.getLeaf(false).openFile(file);
}
