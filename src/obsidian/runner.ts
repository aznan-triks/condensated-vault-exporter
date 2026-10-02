/**
 * The bridge between the UI and `runExport`: it assembles the engine's
 * dependencies from Obsidian, keeps the analysis cache alive between runs,
 * persists the delta state, and turns the result into user feedback.
 */

import { App, Modal, Notice, TFile, normalizePath } from "obsidian";
import { ExportAbortedError, type ExportProfile, type ExportResult, type SourceFile } from "../core/types";
import { runExport, selectCandidates, type ExportDeps, type PreviousManifestLike } from "../core/pipeline";
import { AnalysisCache } from "../core/state/cache";
import { createState, type ExportState } from "../core/state/manifest";
import { computeProfileStatus, type ProfileStatus } from "../core/state/status";
import { formatCount, hashString } from "../core/util";
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
	/**
	 * Skip the run entirely when no note in scope changed since the last run of
	 * that profile (used by automatic refresh).
	 */
	skipUnchanged?: boolean;
}

export interface RunOutcome {
	ok: boolean;
	cancelled?: boolean;
	error?: string;
	result?: ExportResult;
	/** True when the run was skipped because nothing in scope had changed. */
	skipped?: boolean;
}

export class ExportRunner {
	private readonly cache = new AnalysisCache();
	private readonly vaultPort: ObsidianVaultPort;
	private current: ExportProgress | null = null;
	private statusEl: HTMLElement | null = null;
	/** Last fingerprint of the files each profile selected, for auto-refresh. */
	private readonly fingerprints = new Map<string, string>();

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
		this.fingerprints.clear();
	}

	/**
	 * Cheap "did anything change?" check: path, size and modification time of
	 * every note in scope. Nothing is read, so an automatic run that finds no
	 * change costs one file listing.
	 */
	async scopeFingerprint(profile: ExportProfile): Promise<string> {
		const files: SourceFile[] = await this.vaultPort.listFiles(
			profile.targets.length > 0 ? [...profile.targets] : undefined,
		);
		let hash = 0x811c9dc5;
		for (const file of files) {
			hash = hashString(`${file.path}:${file.size}:${file.mtime}`, hash);
		}
		return `${files.length}:${(hash >>> 0).toString(16)}`;
	}

	invalidatePath(path: string, change: "modify" | "structure" = "modify"): void {
		this.cache.invalidate(path);
		this.vaultPort.invalidateFile(path, change);
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
			concurrency: settings.concurrency,
			excludePatterns: this.ignoredPatterns(),
			onProgress: progress.handle,
			signal: progress,
			clipboard: { write: (text: string) => this.writeClipboard(text) },
			now: () => Date.now(),
			pluginVersion: this.pluginVersion(),
			beforeWrite: async (paths) => {
				if (options.mode === "preview") return true;
				if (!settings.confirmOverwrite || profile.output.destination !== "vault") return true;
				const existing = paths.filter((path) => this.app.vault.getAbstractFileByPath(normalizePath(path)));
				if (existing.length === 0) return true;
				return await confirmOverwrite(this.app, existing);
			},
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
			if (options.skipUnchanged) {
			const fingerprint = await this.scopeFingerprint(requestProfile);
			if (this.fingerprints.get(requestProfile.id) === fingerprint) {
				return { ok: true, skipped: true };
			}
			this.fingerprints.set(requestProfile.id, fingerprint);
		}

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
				const removed = await this.rollback(sink);
				new Notice(
					removed > 0
						? `Export cancelled — ${removed} partially written file(s) were removed.`
						: "Export cancelled — nothing was written.",
				);
				return { ok: false, cancelled: true };
			}
			if (error instanceof ExportAbortedError) {
				new Notice(error.message);
				return { ok: false, error: error.message };
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

	/** Opens one of the files a run wrote (vault files only). */
	private async openPath(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
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

		const delta = result.delta;
		const changeLine =
			delta && (delta.added.length > 0 || delta.changed.length > 0 || delta.removed.length > 0)
				? `\n↻ vs previous export: ${delta.added.length} new, ${delta.changed.length} changed, ${delta.removed.length} gone.`
				: "";

		// When notes were left behind, the report is the most useful thing to
		// point at: it says which ones and why.
		const leftOut = Math.max(0, result.stats.discovered - result.stats.kept);
		const reportPath = result.written.find((path) => path.endsWith(".report.md"));
		const reportLine =
			options.mode !== "preview" && reportPath && leftOut > 0
				? `\n📋 ${leftOut} note(s) were left out — see ${reportPath.split("/").pop()}`
				: "";

		const problems = result.warnings.filter((w) => w.startsWith("❌") || w.startsWith("⚠️"));
		const notice = new Notice(
		problems.length > 0 ? `${head}${changeLine}${reportLine}\n⚠️ ${problems[0].replace(/^[❌⚠️]\s*/u, "")}`
				: `${head}${changeLine}${reportLine}`,
			problems.length > 0 ? 8000 : 4000,
		);
		notice.noticeEl.addClass("cve-notice");
		// The notice is the fastest way back to what was just written: clicking
		// it opens the first part in a new tab.
		const firstWritten = result.written.find((path) => path.endsWith(".md") || path.endsWith(".txt"));
		if (options.mode !== "preview" && firstWritten) {
			notice.noticeEl.addClass("cve-notice-clickable");
			notice.noticeEl.setAttribute("title", `Open ${firstWritten}`);
			notice.noticeEl.onClickEvent(() => void this.openPath(firstWritten));
		}

		if (options.mode !== "preview" && settings.openAfterExport && profile.output.openAfterExport && firstWritten) {
			await this.openPath(firstWritten);
		}
	}

	/** Clipboard for arbitrary text (used for the instructions artefact). */
	async copyText(text: string, message: string): Promise<void> {
		await this.writeClipboard(text);
		new Notice(message);
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

	/** Deletes the files a cancelled run had already written. */
	private async rollback(sink: VaultSinkPort | FileSystemSinkPort): Promise<number> {
		if (!(sink instanceof VaultSinkPort)) return 0;
		let removed = 0;
		for (const path of [...sink.written].reverse()) {
			const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
			if (!(file instanceof TFile)) continue;
			try {
				await this.app.vault.delete(file);
				removed++;
			} catch {
				// Leaving a file behind is not worth failing the cancellation.
			}
		}
		return removed;
	}

	/**
	 * Obsidian's "Excluded files" setting, turned into exclusion globs. Reading
	 * it is best-effort: the accessor is unofficial, so a failure just means
	 * "no extra exclusions".
	 */
	private ignoredPatterns(): string[] {
		try {
			const vault = this.app.vault as unknown as { getConfig?: (key: string) => unknown };
			const raw = vault.getConfig?.("userIgnoreFilters");
			if (!Array.isArray(raw)) return [];
			return raw
				.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
				.map((entry) => {
					const trimmed = entry.trim().replace(/^\/+/, "");
					// A folder in Obsidian's list means "everything below it".
					if (trimmed.endsWith("/")) return `${trimmed}**`;
					if (!trimmed.includes("*") && !trimmed.includes(".")) return `${trimmed}/**`;
					return trimmed;
				});
		} catch {
			return [];
		}
	}

	/** Lists markdown files (used by the folder picker in the modal). */
	/**
	 * Cheap scope estimate for the dialog: how much markdown a target folder
	 * holds. Uses the cached file list only — no note is read.
	 */
	async estimateScope(target: string): Promise<{ notes: number; bytes: number }> {
		const files: SourceFile[] = await this.vaultPort.listFiles(target === "" ? undefined : [target]);
		let bytes = 0;
		for (const file of files) bytes += file.size;
		return { notes: files.length, bytes };
	}

	/**
	 * What each profile last produced, and what the vault has done since.
	 * One file listing for all profiles; the rest comes from the sidecars and
	 * the plugin state, so this stays instant on a large vault.
	 */
	async collectStatus(): Promise<ProfileStatus[]> {
		const settings = this.getSettings();
		const all = await this.vaultPort.listFiles();
		const statuses: ProfileStatus[] = [];
		for (const profile of settings.profiles) {
			const selection = selectCandidates(all, profile, maxFileBytes(profile), this.ignoredPatterns());
			const manifest = await this.readManifest(profile.id).catch(() => null);
			statuses.push(
				computeProfileStatus(profile, manifest, settings.state, selection.files),
			);
		}
		return statuses;
	}

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

/** The in-scope file ceiling a profile implies (mirrors the pipeline default). */
function maxFileBytes(profile: ExportProfile): number {
	const megabytes = profile.filters.maxFileMegabytes;
	return megabytes > 0 ? megabytes * 1024 * 1024 : 8 * 1024 * 1024;
}

/** Asks the user before overwriting existing bundle parts. */
function confirmOverwrite(app: App, paths: string[]): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new OverwriteModal(app, paths, resolve);
		modal.open();
	});
}

class OverwriteModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly paths: string[],
		private readonly resolve: (value: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h2", { text: "Overwrite existing files?" });
		this.contentEl.createEl("p", {
			text: `${this.paths.length} file(s) already exist and will be replaced:`,
		});
		const list = this.contentEl.createEl("ul", { cls: "cve-summary-list" });
		for (const path of this.paths.slice(0, 8)) list.createEl("li", { text: path });
		if (this.paths.length > 8) list.createEl("li", { text: `… and ${this.paths.length - 8} more` });
		const buttons = this.contentEl.createDiv({ cls: "cve-dialog-buttons" });
		const confirm = buttons.createEl("button", { text: "Overwrite", cls: "mod-warning" });
		confirm.onclick = () => this.settle(true);
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.settle(false);
	}

	private settle(value: boolean): void {
		this.settled = true;
		this.close();
		this.resolve(value);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) this.resolve(false);
	}
}
