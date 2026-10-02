/**
 * Condensated Vault Exporter — Obsidian entry point.
 *
 * The plugin itself is thin: it owns the settings, the commands and the UI.
 * All the interesting work (analysis, condensation, packaging) lives in
 * `src/core`, which knows nothing about Obsidian.
 */

import { Notice, Plugin, TFolder } from "obsidian";
import type { ExportProfile } from "./core/types";
import { normalizeSettings, compactSettings, type PluginSettings } from "./obsidian/settings";
import { ExportSettingsTab } from "./obsidian/settingsTab";
import { ExportRunner } from "./obsidian/runner";
import { ExportDialog, PreviewModal, openFirstResult } from "./obsidian/modals";

export default class CondensatedVaultExporter extends Plugin {
	settings!: PluginSettings;
	private runner!: ExportRunner;
	private statusBarEl: HTMLElement | null = null;
	/** Timer for the automatic refresh (quiet period after the last edit). */
	private autoRefreshTimer: number | null = null;

	async onload(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
		this.runner = new ExportRunner(
			this.app,
			() => this.settings,
			() => this.saveSettings(),
		);
		this.runner.version = this.manifest.version;

		this.app.workspace.onLayoutReady(() => this.setupStatusBar());
		this.addSettingTab(new ExportSettingsTab(this.app, this, this.settings));

		this.addRibbonIcon("package-plus", "Export a bundle of notes", () => this.openDialog());

		this.addCommand({
			id: "export-active-profile",
			name: "Export with the active profile",
			callback: () => void this.runActive("export"),
		});
		this.addCommand({
			id: "export-dialog",
			name: "Open the export dialog",
			callback: () => this.openDialog(),
		});
		this.addCommand({
			id: "preview-active-profile",
			name: "Preview the active profile's bundle",
			callback: () => void this.runActive("preview"),
		});
		this.addCommand({
			id: "copy-active-profile",
			name: "Copy the bundle to the clipboard",
			callback: () => void this.runActive("export", { destination: "clipboard" }),
		});
		this.addCommand({
			id: "cancel-export",
			name: "Cancel the running export",
			checkCallback: (checking) => {
				if (!this.runner.busy) return false;
				if (!checking) {
					this.runner.cancel();
					new Notice("Cancelling the export…");
				}
				return true;
			},
		});
		this.addCommand({
			id: "clear-analysis-cache",
			name: "Clear the analysis cache",
			callback: () => {
				this.runner.clearCache();
				new Notice("Analysis cache cleared — the next export re-reads every note.");
			},
		});

		this.registerProfileCommands();

		// Folder context menu: export right where you are.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFolder)) return;
				menu.addItem((item) => {
					item.setTitle("Export as an AI-ready bundle…")
						.setIcon("package-plus")
						.onClick(() => this.openDialog(file.path));
				});
			}),
		);

		// Editing a note must invalidate its cached analysis, not the whole cache.
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				this.runner.invalidatePath(file.path);
				this.scheduleAutoRefresh();
			}),
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				this.runner.invalidatePath(file.path);
				this.scheduleAutoRefresh();
			}),
		);
		this.registerEvent(this.app.vault.on("delete", (file) => this.runner.invalidatePath(file.path)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.runner.invalidatePath(oldPath)));
	}

	/**
	 * Quiet-period timer behind the automatic refresh: a run starts once the
	 * vault has been still for `autoRefresh.debounceSeconds`. Typing a sentence
	 * therefore costs one run, not one per keystroke.
	 */
	private scheduleAutoRefresh(): void {
		if (!this.settings.autoRefresh.enabled) return;
		if (this.autoRefreshTimer !== null) window.clearTimeout(this.autoRefreshTimer);
		const delay = Math.max(2, this.settings.autoRefresh.debounceSeconds) * 1000;
		const timer = window.setTimeout(() => {
			this.autoRefreshTimer = null;
			void this.runAutoRefresh();
		}, delay);
		// Kept so the timer can be cleared on unload.
		this.autoRefreshTimer = timer;
	}

	/** Runs the auto-refresh profile, silently, if it has something to do. */
	private async runAutoRefresh(): Promise<void> {
		if (!this.settings.autoRefresh.enabled || this.runner.busy) return;
		const id = this.settings.autoRefresh.profileId || this.settings.activeProfileId;
		const profile = this.settings.profiles.find((p) => p.id === id);
		if (!profile) return;
		const outcome = await this.runner.run(profile, {
			skipUnchanged: this.settings.autoRefresh.skipUnchanged,
			announce: this.settings.notifications !== "quiet",
		});
		if (outcome.ok && !outcome.skipped && this.statusBarEl) {
			this.statusBarEl.setText(`$(package-plus) ${profile.name} refreshed`);
		}
	}

	onunload(): void {
		if (this.autoRefreshTimer !== null) window.clearTimeout(this.autoRefreshTimer);
		this.autoRefreshTimer = null;
		this.runner?.cancel();
	}

	/**
	 * One command per profile: `Export: NotebookLM`, `Export: RAG chunks`…
	 * The command palette becomes a destination picker.
	 */
	private registerProfileCommands(): void {
		const add = () => {
			for (const profile of this.settings.profiles) {
				const id = `export-profile-${profile.id}`;
				if (this.profileCommandIds.has(id)) continue;
				this.profileCommandIds.add(id);
				this.addCommand({
					id,
					name: `Export with “${profile.name}”`,
					callback: () => void this.execute(profile, "export"),
				});
			}
		};
		add();
		this.refreshProfileCommands = add;
	}

	private profileCommandIds = new Set<string>();
	private refreshProfileCommands: () => void = () => {};

	/* ------------------------------------------------------------------ */

	private setupStatusBar(): void {
		if (!this.settings.statusBar) return;
		if (this.statusBarEl) return;
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("cve-status");
		this.statusBarEl.setAttribute("aria-label", "Condensated Vault Exporter");
		this.statusBarEl.onClickEvent(() => {
			if (this.runner.busy) this.runner.cancel();
			else this.openDialog();
		});
		this.runner.setStatusElement(this.statusBarEl);
	}

	/** Re-applies settings that affect the UI shell (called by the tab). */
	async applySettings(): Promise<void> {
		// Turning auto-refresh off must also cancel a pending run.
		if (!this.settings.autoRefresh.enabled && this.autoRefreshTimer !== null) {
			window.clearTimeout(this.autoRefreshTimer);
			this.autoRefreshTimer = null;
		}
		if (!this.settings.statusBar && this.statusBarEl) {
			this.runner.setStatusElement(null);
			this.statusBarEl.remove();
			this.statusBarEl = null;
		} else if (this.settings.statusBar && !this.statusBarEl) {
			this.setupStatusBar();
		}
		await this.saveSettings();
	}

	async saveSettings(): Promise<void> {
		const known = new Set(this.app.vault.getFiles().map((file) => file.path));
		const settings = compactSettings(this.settings, known);
		await this.saveData(settings);
	}

	clearCache(): void {
		this.runner.clearCache();
	}

	/** Makes sure every profile has a command in the palette. */
	syncProfileCommands(): void {
		this.refreshProfileCommands();
	}

	/* ------------------------------------------------------------------ */

	private openDialog(target?: string): void {
		new ExportDialog(
			this.app,
			this.settings,
			this.runner,
			(submitted, mode) => void this.execute(submitted.profile, mode, submitted.target),
			{ target, profileId: this.settings.activeProfileId },
		).open();
	}

	private async runActive(
		mode: "export" | "preview",
		outputOverride?: Partial<ExportProfile["output"]>,
	): Promise<void> {
		const profile = this.activeProfile();
		if (!profile) {
			new Notice("No export profile configured.");
			return;
		}
		const effective =
			outputOverride === undefined ? profile : { ...profile, output: { ...profile.output, ...outputOverride } };
		await this.execute(effective, mode);
	}

	private async execute(profile: ExportProfile, mode: "export" | "preview", target?: string): Promise<void> {
		const run = async () => {
			const outcome = await this.runner.run(profile, {
				mode,
				target,
				announce: mode === "export",
			});
			if (!outcome.ok || !outcome.result) return;
			if (mode === "preview") {
				new PreviewModal(this.app, outcome.result, () => void this.execute(profile, "export", target)).open();
			} else if (this.settings.openAfterExport && profile.output.openAfterExport) {
				await openFirstResult(this.app, outcome.result);
			}
		};

		await run();
	}

	private activeProfile(): ExportProfile | undefined {
		return (
			this.settings.profiles.find((profile) => profile.id === this.settings.activeProfileId) ??
			this.settings.profiles[0]
		);
	}
}
