/**
 * Export dialog, preview modal, status dashboard, and vault intelligence explorer.
 *
 * The dialog is intentionally a *profile picker with a few overrides* rather
 * than a wall of settings: the profile is the configuration, and everything
 * else lives in the settings tab. The preview modal is the trust builder —
 * you see the exact text that will be written, part by part, with the numbers,
 * pipeline funnel, export report, and warnings that explain how it was built.
 */

import { App, Component, MarkdownRenderer, Modal, Notice, Setting, TFile, normalizePath } from "obsidian";
import type { ExportProfile, ExportResult } from "../core/types";
import { redactSecretsInText } from "../core/intel/safety";
import { describeProfile } from "../core/profiles";
import { describeChanges, isStale, type ProfileStatus } from "../core/state/status";
import { formatBytes, formatCount } from "../core/util";
import type { ExportRunner, VaultIntelligenceReport } from "./runner";
import type { PluginSettings } from "./settings";
import { PROJECT_SAFETY_WARNING } from "../safetyWarning";

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
	private redactSecrets: boolean;
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
		options: { target?: string; profileId?: string; focusQuery?: string } = {},
	) {
		super(app);
		this.profile =
			this.settings.profiles.find((p) => p.id === (options.profileId ?? this.settings.activeProfileId)) ??
			this.settings.profiles[0];
		this.target = options.target ?? (this.profile.targets.length === 1 ? this.profile.targets[0] : "");
		this.destination = this.profile.output.destination;
		this.incremental = this.profile.output.incremental;
		this.copyToClipboard = this.profile.output.alsoCopyToClipboard;
		this.redactSecrets = Boolean(this.profile.condensation.redactSecrets);
		this.focus = options.focusQuery ?? this.profile.filters.focus?.query ?? "";
		this.focusMaxNotes = this.profile.filters.focus?.maxNotes ?? 30;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("cve-dialog");
		contentEl.createEl("h2", { text: "Export to an AI-ready bundle" });
		contentEl.createDiv({ cls: "cve-warning-line cve-error", text: PROJECT_SAFETY_WARNING });

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
					this.redactSecrets = Boolean(next.condensation.redactSecrets);
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
			.setName("Topic focus & query")
			.setDesc(
				"Optional: rank notes against a topic or use operators (e.g. \"rank fusion\" tag:research path:Projects/ has:code hops:1 -draft).",
			)
			.addText((text) =>
				text
					.setValue(this.focus)
					.setPlaceholder("e.g. retrieval evaluation #research hops:1")
					.onChange((value) => {
						this.focus = value;
						this.renderSummary();
					}),
			)
			.addText((capText) => {
				capText
					.setValue(String(this.focusMaxNotes))
					.setPlaceholder("Max notes (0=all)")
					.onChange((value) => {
						const parsed = Number.parseInt(value.trim(), 10);
						if (Number.isFinite(parsed) && parsed >= 0) {
							this.focusMaxNotes = parsed;
							this.renderSummary();
						}
					});
				capText.inputEl.type = "number";
				capText.inputEl.style.width = "76px";
				capText.inputEl.setAttribute("aria-label", "Maximum notes to keep for topic focus (0 for no limit)");
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

		new Setting(contentEl)
			.setName("Redact detected credentials")
			.setDesc("Replace API keys, tokens, and private keys with [REDACTED] placeholders before writing.")
			.addToggle((toggle) =>
				toggle.setValue(this.redactSecrets).onChange((value) => {
					this.redactSecrets = value;
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
			.estimateScope(target, this.profile)
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
			condensation: {
				...this.profile.condensation,
				redactSecrets: this.redactSecrets,
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

type PreviewTab = "bundle" | "funnel" | "report" | "instructions";

export class PreviewModal extends Modal {
	private partIndex = 0;
	private activeTab: PreviewTab = "bundle";
	private searchFilter = "";
	private readonly closeables: Component[] = [];
	private readonly container: HTMLElement;
	private copyButton: HTMLButtonElement | null = null;
	private tabBarEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;

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
		contentEl.createDiv({ cls: "cve-warning-line cve-error", text: PROJECT_SAFETY_WARNING });

		const stats = contentEl.createDiv({ cls: "cve-preview-stats" });
		this.renderStats(stats);

		const warnings = contentEl.createDiv({ cls: "cve-preview-warnings" });
		this.renderWarnings(warnings);

		this.renderDelta(contentEl);

		// Interactive view tabs (Bundle content | Pipeline funnel | Export report | Instructions)
		this.tabBarEl = contentEl.createDiv({ cls: "cve-tab-bar" });
		this.renderTabBar();

		if (this.result.parts.length > 1) {
			new Setting(contentEl).setName("Part").addDropdown((dropdown) => {
				for (const part of this.result.parts) {
					dropdown.addOption(
						String(part.index),
						`Part ${part.index + 1} of ${part.total} — ${formatCount(part.words)} words (~${formatCount(part.tokens)} tokens)`,
					);
				}
				dropdown.setValue("0").onChange((value) => {
					this.partIndex = Number(value);
					void this.renderActiveTab();
				});
			});
		}

		this.bodyEl = contentEl.createDiv({ cls: "cve-preview-body" });
		void this.renderActiveTab();

		const buttons = contentEl.createDiv({ cls: "cve-dialog-buttons" });
		this.copyButton = buttons.createEl("button", { text: "Copy to clipboard" });
		this.copyButton.onclick = () => void this.copy();

		const hasSecretWarning = this.result.warnings.some((w) => /credential/i.test(w));
		if (hasSecretWarning) {
			const copyRedacted = buttons.createEl("button", { text: "Copy redacted" });
			copyRedacted.setAttribute("aria-label", "Scrub detected credentials and copy the safe text to the clipboard");
			copyRedacted.onclick = () => void this.copyRedacted();
		}

		if (this.result.instructions) {
			const instructions = buttons.createEl("button", { text: "Copy custom instructions" });
			instructions.setAttribute(
				"aria-label",
				"Copy the paste-ready instructions for the destination model",
			);
			instructions.onclick = () => {
				void this.copyText(
					this.result.instructions ?? "",
					"Instructions copied — paste them into the notebook's instructions field.",
				);
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

	private renderTabBar(): void {
		if (!this.tabBarEl) return;
		this.tabBarEl.empty();
		const tabs: { id: PreviewTab; label: string; show: boolean }[] = [
			{ id: "bundle", label: `Bundle (${this.result.parts.length})`, show: true },
			{ id: "funnel", label: "Pipeline funnel", show: true },
			{ id: "report", label: "Export report", show: Boolean(this.result.report) },
			{ id: "instructions", label: "AI instructions", show: Boolean(this.result.instructions) },
		];
		for (const tab of tabs) {
			if (!tab.show) continue;
			const pill = this.tabBarEl.createEl("span", {
				cls: `cve-tab-pill${this.activeTab === tab.id ? " is-active" : ""}`,
				text: tab.label,
			});
			pill.onclick = () => {
				this.activeTab = tab.id;
				this.renderTabBar();
				void this.renderActiveTab();
			};
		}
	}

	private async renderActiveTab(): Promise<void> {
		if (!this.bodyEl) return;
		this.bodyEl.empty();
		switch (this.activeTab) {
			case "funnel":
				this.renderFunnelView(this.bodyEl);
				return;
			case "report":
				await this.renderMarkdownView(this.bodyEl, this.result.report ?? "");
				return;
			case "instructions":
				await this.renderMarkdownView(this.bodyEl, this.result.instructions ?? "");
				return;
			case "bundle":
			default:
				await this.renderPart();
				return;
		}
	}

	private renderFunnelView(parent: HTMLElement): void {
		const s = this.result.stats;
		const box = parent.createDiv({ cls: "cve-funnel-view" });
		box.createEl("h3", { text: "Condensation & selection funnel" });
		const maxNotes = Math.max(1, s.discovered);
		const stages: { label: string; count: number; detail: string }[] = [
			{ label: "1. Discovered in scope", count: s.discovered, detail: "Candidate Markdown & Canvas files" },
			{
				label: "2. Passed profile filters",
				count: Math.max(0, s.discovered - s.droppedByFilter),
				detail: s.droppedByFilter > 0 ? `${s.droppedByFilter} excluded by tag/date/word filters` : "All notes matched filters",
			},
			{
				label: "3. After deduplication",
				count: Math.max(0, s.discovered - s.droppedByFilter - s.droppedAsDuplicate),
				detail: s.droppedAsDuplicate > 0 ? `${s.droppedAsDuplicate} near/exact duplicate(s) collapsed` : "No duplicates found",
			},
			{
				label: "4. After stub removal",
				count: Math.max(0, s.discovered - s.droppedByFilter - s.droppedAsDuplicate - s.droppedAsStub),
				detail: s.droppedAsStub > 0 ? `${s.droppedAsStub} near-empty stub(s) dropped` : "No stubs dropped",
			},
			{
				label: "5. Final notes in bundle",
				count: s.kept,
				detail:
					s.summarized > 0
						? `${s.summarized} note(s) extractively summarized · ${s.boilerplateLines} boilerplate lines stripped`
						: `${s.boilerplateLines} boilerplate lines stripped`,
			},
		];
		const table = box.createEl("table", { cls: "cve-status-table" });
		for (const stage of stages) {
			const row = table.createEl("tr");
			row.createEl("th", { text: stage.label });
			const pct = Math.round((stage.count / maxNotes) * 100);
			row.createEl("td", { text: `${formatCount(stage.count)} (${pct}%)` });
			row.createEl("td", { cls: "cve-hint", text: stage.detail });
		}
	}

	private async renderMarkdownView(parent: HTMLElement, markdown: string): Promise<void> {
		if (markdown.length < 200_000) {
			const target = parent.createDiv({ cls: "markdown-rendered cve-preview-markdown" });
			const component = new Component();
			component.load();
			await MarkdownRenderer.render(this.app, markdown, target, "", component);
			this.closeables.push(component);
		} else {
			const pre = parent.createEl("pre", { cls: "cve-preview-raw" });
			pre.setText(markdown.slice(0, 200_000));
		}
	}

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
				el.createEl("div", { cls: `cve-warning-line ${cls}`, text: message.replace(/^[❌⚠️ℹ️🛡️]\s*/u, "") });
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

	private async copyRedacted(): Promise<void> {
		const raw = this.result.parts.map((p) => p.content).join("\n\n");
		const scrubbed = redactSecretsInText(raw);
		await this.copyText(
			scrubbed.text,
			`Redacted ${scrubbed.redactedCount} credential(s) and copied ${formatCount(scrubbed.text.length)} characters to the clipboard.`,
		);
	}

	onClose(): void {
		for (const component of this.closeables) component.unload();
		this.closeables.length = 0;
		this.contentEl.empty();
	}
}

/* -------------------------------------------------------------------------- */
/*  Vault Intelligence & Health Explorer                                       */
/* -------------------------------------------------------------------------- */

type ExplorerTab = "overview" | "graph" | "duplicates" | "drift";

export class VaultExplorerModal extends Modal {
	private activeTab: ExplorerTab = "overview";
	private report: VaultIntelligenceReport | null = null;
	private closed = false;
	private tabBarEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly analyze: () => Promise<VaultIntelligenceReport>,
		private readonly onExportFocus?: (focusQuery: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("cve-preview-modal");
		contentEl.createEl("h2", { text: "Vault intelligence & health explorer" });

		this.tabBarEl = contentEl.createDiv({ cls: "cve-tab-bar" });
		this.bodyEl = contentEl.createDiv({ cls: "cve-status-body" });

		const buttons = contentEl.createDiv({ cls: "cve-dialog-buttons" });
		const refresh = buttons.createEl("button", { text: "Refresh scan" });
		refresh.onclick = () => void this.load();
		const close = buttons.createEl("button", { text: "Close" });
		close.onclick = () => this.close();

		void this.load();
	}

	private async load(): Promise<void> {
		if (!this.bodyEl) return;
		this.bodyEl.empty();
		this.bodyEl.createEl("p", { cls: "cve-hint", text: "Analysing vault graph, themes, duplicates and drift…" });
		try {
			this.report = await this.analyze();
		} catch {
			if (this.bodyEl) this.bodyEl.setText("Could not analyse the vault.");
			return;
		}
		if (this.closed || !this.bodyEl) return;
		this.renderTabs();
		this.renderBody();
	}

	private renderTabs(): void {
		if (!this.tabBarEl || !this.report) return;
		this.tabBarEl.empty();
		const m = this.report.map;
		const openCount = (m.openItems?.tasks.length ?? 0) + (m.openItems?.questions.length ?? 0);
		const tabs: { id: ExplorerTab; label: string }[] = [
			{ id: "overview", label: `Overview & schema (${m.themes.length} themes)` },
			{ id: "graph", label: `Graph & phantoms (${m.hubs.length} hubs · ${m.phantoms.length} missing)` },
			{ id: "duplicates", label: `Duplicates & boilerplate (${m.duplicates.length})` },
			{ id: "drift", label: `Drift & open items (${m.contradictions.length + openCount})` },
		];
		for (const tab of tabs) {
			const pill = this.tabBarEl.createEl("span", {
				cls: `cve-tab-pill${this.activeTab === tab.id ? " is-active" : ""}`,
				text: tab.label,
			});
			pill.onclick = () => {
				this.activeTab = tab.id;
				this.renderTabs();
				this.renderBody();
			};
		}
	}

	private renderBody(): void {
		if (!this.bodyEl || !this.report) return;
		this.bodyEl.empty();
		const m = this.report.map;
		const o = m.overview;

		if (this.activeTab === "overview") {
			this.bodyEl.createEl("p", {
				text: `${formatCount(o.notes)} notes · ${formatCount(o.words)} words (~${formatCount(o.tokens)} tokens) · analysed in ${this.report.durationMs} ms.`,
			});
			if (m.keyTerms.length > 0) {
				this.bodyEl.createEl("h3", { text: "Characteristic vault terms" });
				this.bodyEl.createEl("p", {
					cls: "cve-hint",
					text: m.keyTerms.slice(0, 20).map((t) => `${t.term} (${t.notes})`).join(" · "),
				});
			}
			this.bodyEl.createEl("h3", { text: "Detected thematic clusters" });
			if (m.themes.length === 0) {
				this.bodyEl.createEl("p", { cls: "cve-hint", text: "No multi-note themes detected yet." });
			} else {
				const table = this.bodyEl.createEl("table", { cls: "cve-status-table" });
				for (const theme of m.themes) {
					const row = table.createEl("tr");
					row.createEl("td", { text: theme.label });
					row.createEl("td", { text: `${theme.notes} notes · ${formatCount(theme.words)} words` });
					row.createEl("td", { cls: "cve-hint", text: theme.paths.slice(0, 3).join(", ") });
					const actions = row.createEl("td");
					if (this.onExportFocus) {
						const btn = actions.createEl("button", { text: "Export theme" });
						btn.onclick = () => {
							const q = theme.label.split("/").map((s) => s.trim()).join(" ");
							this.close();
							this.onExportFocus!(q);
						};
					}
				}
			}
			if ((m.schema?.length ?? 0) > 0) {
				this.bodyEl.createEl("h3", { text: "Frontmatter property schema" });
				const table = this.bodyEl.createEl("table", { cls: "cve-status-table" });
				for (const prop of m.schema.slice(0, 12)) {
					const row = table.createEl("tr");
					row.createEl("th", { text: prop.key });
					row.createEl("td", { text: `${prop.type} (${prop.notes} notes)` });
					row.createEl("td", {
						cls: "cve-hint",
						text: prop.topValues.map((v) => `${v.value} (${v.count})`).join(", "),
					});
				}
			}
			return;
		}

		if (this.activeTab === "graph") {
			this.bodyEl.createEl("h3", { text: "Central hubs (most referenced)" });
			if (m.hubs.length === 0) {
				this.bodyEl.createEl("p", { cls: "cve-hint", text: "No internal links resolved between notes." });
			} else {
				const list = this.bodyEl.createEl("ul", { cls: "cve-summary-list" });
				for (const hub of m.hubs.slice(0, 10)) {
					list.createEl("li", { text: `${hub.title} (${hub.path}) — ${hub.inbound} incoming links` });
				}
			}

			if (m.bridges.length > 0) {
				this.bodyEl.createEl("h3", { text: "Bridge notes (connecting folders)" });
				const list = this.bodyEl.createEl("ul", { cls: "cve-summary-list" });
				for (const b of m.bridges.slice(0, 8)) {
					list.createEl("li", {
						text: `${b.title} (${b.path}) — spans ${b.foldersBridged} folder(s), ${b.inbound} in / ${b.outbound} out`,
					});
				}
			}

			this.bodyEl.createEl("h3", { text: "Phantom concepts (missing notes cited across the vault)" });
			if (m.phantoms.length === 0) {
				this.bodyEl.createEl("p", { cls: "cve-hint", text: "No unresolved wiki-links found." });
			} else {
				const table = this.bodyEl.createEl("table", { cls: "cve-status-table" });
				for (const ph of m.phantoms.slice(0, 12)) {
					const row = table.createEl("tr");
					row.createEl("td", { text: `[[${ph.target}]]` });
					row.createEl("td", { text: `Cited by ${ph.count} note(s)` });
					row.createEl("td", { cls: "cve-hint", text: ph.referencedBy.slice(0, 3).join(", ") });
				}
			}

			if (m.orphans.length > 0) {
				this.bodyEl.createEl("h3", { text: `Orphan notes (${m.orphans.length})` });
				this.bodyEl.createEl("p", {
					cls: "cve-hint",
					text: m.orphans.slice(0, 15).map((o) => o.path).join(", "),
				});
			}
			return;
		}

		if (this.activeTab === "duplicates") {
			this.bodyEl.createEl("h3", { text: "Duplicate & near-duplicate groups" });
			if (m.duplicates.length === 0) {
				this.bodyEl.createEl("p", { cls: "cve-hint", text: "No duplicate notes detected." });
			} else {
				const list = this.bodyEl.createEl("ul", { cls: "cve-summary-list" });
				for (const group of m.duplicates) {
					list.createEl("li", {
						text: `${group.representative} (${group.kind}, ${Math.round(group.similarity * 100)}% similar) ← ${group.duplicates.join(", ")}`,
					});
				}
			}

			this.bodyEl.createEl("h3", { text: "Recurring boilerplate lines" });
			if (m.boilerplate.length === 0) {
				this.bodyEl.createEl("p", { cls: "cve-hint", text: "No repeated boilerplate lines detected." });
			} else {
				const list = this.bodyEl.createEl("ul", { cls: "cve-summary-list" });
				for (const bp of m.boilerplate) {
					list.createEl("li", { text: `“${bp.text}” — repeated in ${bp.docs} notes` });
				}
			}
			return;
		}

		if (this.activeTab === "drift") {
			this.bodyEl.createEl("h3", { text: "Temporal metric drift & conflicting claims" });
			if (m.contradictions.length === 0) {
				this.bodyEl.createEl("p", {
					cls: "cve-hint",
					text: "No conflicting numeric metrics or status reversals detected across related notes.",
				});
			} else {
				const table = this.bodyEl.createEl("table", { cls: "cve-status-table" });
				for (const c of m.contradictions) {
					const row = table.createEl("tr");
					row.createEl("th", { text: c.subject });
					row.createEl("td", { text: `${c.older.path}: ${c.older.value}` });
					row.createEl("td", { text: `→ ${c.newer.path}: ${c.newer.value}` });
				}
			}

			const tasks = m.openItems?.tasks ?? [];
			const questions = m.openItems?.questions ?? [];
			this.bodyEl.createEl("h3", { text: `Open tasks & blockers (${tasks.length})` });
			if (tasks.length === 0) {
				this.bodyEl.createEl("p", { cls: "cve-hint", text: "No open tasks or TODOs found." });
			} else {
				const list = this.bodyEl.createEl("ul", { cls: "cve-summary-list" });
				for (const item of tasks.slice(0, 12)) {
					const tag = item.priority === "high" ? "[HIGH] " : item.kind === "in-progress" ? "[WIP] " : "";
					list.createEl("li", { text: `${tag}${item.text} (${item.path})` });
				}
			}

			this.bodyEl.createEl("h3", { text: `Unanswered questions (${questions.length})` });
			if (questions.length === 0) {
				this.bodyEl.createEl("p", { cls: "cve-hint", text: "No open questions found." });
			} else {
				const list = this.bodyEl.createEl("ul", { cls: "cve-summary-list" });
				for (const q of questions.slice(0, 12)) {
					list.createEl("li", { text: `❓ ${q.text} (${q.path})` });
				}
			}
		}
	}

	onClose(): void {
		this.closed = true;
		this.contentEl.empty();
	}
}

/* -------------------------------------------------------------------------- */
/*  Small confirm dialog & status dashboard                                    */
/* -------------------------------------------------------------------------- */

/**
 * One row per profile: what it last wrote, and what the vault has done since.
 * This is the screen that answers "which of my bundles is out of date?" without
 * running anything — and every row previews its own profile.
 */
export class StatusModal extends Modal {
	private bodyEl: HTMLElement | null = null;
	private buttonsEl: HTMLElement | null = null;
	/** The scan is async: the modal may be gone by the time it answers. */
	private closed = false;

	constructor(
		app: App,
		private readonly collect: () => Promise<ProfileStatus[]>,
		private readonly onPreview: (profileId: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("cve-dialog");
		contentEl.createEl("h2", { text: "Export status" });
		this.bodyEl = contentEl.createDiv({ cls: "cve-status-body" });
		this.buttonsEl = contentEl.createDiv({ cls: "cve-dialog-buttons" });
		const refresh = this.buttonsEl.createEl("button", { text: "Refresh" });
		refresh.onclick = () => void this.render();
		const close = this.buttonsEl.createEl("button", { text: "Close" });
		close.onclick = () => this.close();
		void this.render();
	}

	private async render(): Promise<void> {
		if (!this.bodyEl) return;
		this.bodyEl.empty();
		this.bodyEl.createEl("p", { cls: "cve-hint", text: "Reading the export sidecars…" });
		let statuses: ProfileStatus[];
		try {
			statuses = await this.collect();
		} catch {
			this.bodyEl.setText("Could not read the export status.");
			return;
		}
		if (this.closed || !this.bodyEl) return;
		this.bodyEl.empty();
		if (statuses.length === 0) {
			this.bodyEl.createEl("p", { text: "No profiles configured." });
			return;
		}
		const table = this.bodyEl.createEl("table", { cls: "cve-status-table" });
		const head = table.createEl("tr");
		for (const label of ["Profile", "Last export", "Notes", "Last bundle", "Since then", ""]) {
			head.createEl("th", { text: label });
		}
		for (const status of statuses) {
			const row = table.createEl("tr");
			row.createEl("td", { text: status.profileName });
			row.createEl("td", { text: relativeTime(status.lastExportAt) });
			row.createEl("td", {
				text:
					status.exported > 0
						? `${formatCount(status.exported)} of ${formatCount(status.notes)}`
						: formatCount(status.notes),
			});
			row.createEl("td", {
				text:
					status.parts > 0
						? `${formatCount(status.parts)} part(s) · ~${formatCount(status.tokens)} tokens`
						: `${formatBytes(status.bytes)} of Markdown`,
			});
			const changes = row.createEl("td", { text: status.tracked ? describeChanges(status) : "not tracked" });
			if (isStale(status)) changes.addClass("cve-status-stale");
			const actions = row.createEl("td");
			const preview = actions.createEl("button", { text: "Preview" });
			preview.setAttribute("aria-label", `Preview what “${status.profileName}” would write now`);
			preview.onclick = () => {
				this.close();
				this.onPreview(status.profileId);
			};
		}
		this.bodyEl.createEl("p", {
			cls: "cve-hint",
			text: "Changes compare the vault with the state recorded by the last export of that profile.",
		});
	}

	onClose(): void {
		this.closed = true;
		this.contentEl.empty();
	}
}

/** Short relative time, stable enough for a status table. */
function relativeTime(at: number): string {
	if (!at || !Number.isFinite(at)) return "never";
	const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (seconds < 90) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 90) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 36) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days} day(s) ago`;
	return new Date(at).toISOString().slice(0, 10);
}

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
