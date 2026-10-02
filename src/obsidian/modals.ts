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
import { formatCount } from "../core/util";
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
	private folders: string[] = [];
	private running = false;
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
		const profile: ExportProfile = {
			...this.profile,
			targets: this.target === "" ? this.profile.targets : [this.target],
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

		this.bodyEl = contentEl.createDiv({ cls: "cve-preview-body" });
		void this.renderPart();

		const buttons = contentEl.createDiv({ cls: "cve-dialog-buttons" });
		this.copyButton = buttons.createEl("button", { text: "Copy to clipboard" });
		this.copyButton.onclick = () => void this.copy();
		const exportButton = buttons.createEl("button", { text: "Export now", cls: "mod-cta" });
		exportButton.onclick = () => {
			this.close();
			this.onExport();
		};
		const close = buttons.createEl("button", { text: "Close" });
		close.onclick = () => this.close();
	}

	private bodyEl: HTMLElement | null = null;

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
