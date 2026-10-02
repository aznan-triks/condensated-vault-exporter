/**
 * The bridge between the UI and `runExport`: it assembles the engine's
 * dependencies from Obsidian, keeps the analysis cache alive between runs,
 * persists the delta state, and turns the result into user feedback.
 */

import { App, Notice, TFile, normalizePath } from "obsidian";
import type { ExportProfile, ExportResult, SourceFile } from "../core/types";
import { runExport, type ExportDeps, type PreviousManifestLike } from "../core/pipeline";
import { AnalysisCache } from "../core/state/cache";
import { createState, type ExportState } from "../core/state/manifest";
import { formatCount } from "../core/util";
import { ExportProgress } from "./progress";
import { FileSystemSinkPort, ObsidianVaultPort, VaultSinkPort } from "./vaultPort";
import type { PluginSettings } from "./settings";

export interface RunOptions {
	mode?: "export" | "preview";
	/** Overrides the profile's output (used by the folder menu command). */
	target?: string;
	/** Called as soon as the run finishes, before any notice is shown. */
	onDone?: (result: ExportResult) => Promise<void> | void;
	/** Set to false for a silent run (e.g. a quick export with quiet mode). */
	announce?: boolean;
}

export interface RunOutcome {
	ok: boolean;
	cancelled?: boolean;
	error?: string;
	result?: ExportResult;
}

export class ExportRunner {
	private readonly cache = new AnalysisCache();
	private readonly vaultPort: ObsidianVaultPort;
	private current: ExportProgress | null = null;
	private statusEl: HTMLElement | null = null;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => PluginSettings,
		private readonly saveSettings: () => Promise<void>,
	) {
		this.vaultPort = new ObsidianVaultPort(app);
	}

	/** The status-bar element the progress line should use. */
	setStatusElement(el: HTMLElement | null): void {
		this.statusEl = el;
	}

	get busy(): boolean {
		return this.current !== null;
	}

	cancel(): void {
		this.current?.cancel();
	}

	/** Clears the analysis cache (used by the "reload the vault" command). */
	clearCache(): void {
		this.cache.clear();
		this.vaultPort.invalidate();
	}

	invalidatePath(path: string): void {
		this.cache.invalidate(path);
	}

	async run(profile: ExportProfile, options: RunOptions = {}): Promise<RunOutcome> {
		if (this.busy) {
			new Notice("An export is already running — cancel it first.");
			return { ok: false, error: "already-running" };
		}

		const settings = this.getSettings();
		const progress = new ExportProgress(this.statusEl, settings.notifications === "verbose");
		this.current = progress;

		let sink: VaultSinkPort | FileSystemSinkPort;
		if (profile.output.destination === "filesystem") {
			const external = new FileSystemSinkPort();
			if (external.available) sink = external;
			else {
				new Notice("Writing outside the vault needs the desktop app — exporting into the vault instead.");
				sink = new VaultSinkPort(this.app);
			}
		} else {
			sink = new VaultSinkPort(this.app);
		}

		const state: ExportState = settings.rememberHistory ? settings.state : createState();
		const requestProfile: ExportProfile =
			options.target === undefined
				? profile
				: { ...profile, targets: [options.target], depth: profile.depth };

		const deps: ExportDeps = {
			vault: this.vaultPort,
			sink,
			cache: this.cache,
			state,
			onProgress: progress.handle,
			signal: progress,
			clipboard: { write: (text: string) => this.writeClipboard(text) },
			now: () => Date.now(),
			pluginVersion: this.pluginVersion(),
			readPreviousManifest: (profileId) => this.readManifest(profileId),
			readNote: async (path: string) => {
				const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
				if (file instanceof TFile) return await this.app.vault.cachedRead(file);
				return null;
			},
			readBinary: async (path: string) => {
				try {
					return await this.vaultPort.readBinary(path);
				} catch {
					return null;
				}
			},
		};

		try {
			const result = await runExport(
				{ profile: requestProfile, mode: options.mode ?? "export" },
				deps,
			);

			if (settings.rememberHistory) settings.state = state;
			progress.finish();
			this.current = null;

			await options.onDone?.(result);
			if (options.announce !== false) await this.announce(profile, result, options);
			return { ok: true, result };
		} catch (error) {
			progress.finish();
			this.current = null;
			if (isCancellation(error)) {
				new Notice("Export cancelled — nothing was written.");
				return { ok: false, cancelled: true };
			}
			const message = error instanceof Error ? error.message : String(error);
			console.error("Condensated Vault Exporter", error);
			new Notice(`Export failed: ${message}`, 8000);
			return { ok: false, error: message };
		} finally {
			this.current = null;
			if (settings.rememberHistory) await this.saveSettings().catch(() => undefined);
		}
	}

	/** Reads the previous manifest so delta exports can be diffed. */
	private async readManifest(profileId: string): Promise<PreviousManifestLike | null> {
		const settings = this.getSettings();
		const profile = settings.profiles.find((p) => p.id === profileId);
		const folder = profile?.output.folder ?? "Exports";
		const adapter = this.app.vault.adapter;
		const candidates = await this.findManifests(folder);
		for (const candidate of candidates) {
			try {
				const raw = await adapter.read(candidate);
				const parsed = JSON.parse(raw) as PreviousManifestLike & { profileId?: string };
				if (!parsed.profileId || parsed.profileId === profileId) return parsed;
			} catch {
				// Unreadable or stale manifest: just ignore it.
			}
		}
		return null;
	}

	private async findManifests(folder: string): Promise<string[]> {
		const prefix = normalizePath(folder);
		const listing = await this.app.vault.adapter.list(prefix).catch(() => null);
		if (!listing) return [];
		return listing.files.filter((file) => file.endsWith(".manifest.json")).slice(0, 8);
	}

	private async announce(profile: ExportProfile, result: ExportResult, options: RunOptions): Promise<void> {
		const settings = this.getSettings();
		if (settings.notifications === "quiet" && result.warnings.length === 0) return;
		const parts = result.parts.length;
		const head =
			options.mode === "preview"
				? `Preview ready — ${parts} part(s), ${formatCount(result.stats.words)} words, ~${formatCount(result.stats.tokens)} tokens.`
				: `Exported ${parts} part(s) — ${formatCount(result.stats.words)} words, ~${formatCount(result.stats.tokens)} tokens.`;

		const problems = result.warnings.filter((w) => w.startsWith("❌") || w.startsWith("⚠️"));
		const notice = new Notice(
			problems.length > 0 ? `${head}\n⚠️ ${problems[0].replace(/^[❌⚠️]\s*/u, "")}` : head,
			problems.length > 0 ? 8000 : 4000,
		);
		notice.noticeEl.addClass("cve-notice");

		if (options.mode !== "preview" && settings.openAfterExport && profile.output.openAfterExport) {
			const first = result.written.find((path) => path.endsWith(".md"));
			if (first) {
				const file = this.app.vault.getAbstractFileByPath(normalizePath(first));
				if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
			}
		}
	}

	private async writeClipboard(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// Fallback for older Electron builds.
			const el = document.createElement("textarea");
			el.value = text;
			el.style.position = "fixed";
			el.style.opacity = "0";
			document.body.appendChild(el);
			el.select();
			document.execCommand("copy");
			el.remove();
		}
	}

	/** Set by the plugin at load time (the app object does not expose it). */
	version = "0.0.0";

	private pluginVersion(): string {
		return this.version;
	}

	/** Lists markdown files (used by the folder picker in the modal). */
	async listFolders(): Promise<string[]> {
		const files: SourceFile[] = await this.vaultPort.listFiles();
		const folders = new Set<string>();
		for (const file of files) if (file.folder !== "") folders.add(file.folder);
		return Array.from(folders).sort((a, b) => a.localeCompare(b));
	}
}

function isCancellation(error: unknown): boolean {
	if (error instanceof Error) {
		return error.name === "ExportCancelledError" || /cancel/i.test(error.message);
	}
	return false;
}
