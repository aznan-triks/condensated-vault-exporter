/**
 * Obsidian ⇄ core bridge: a `VaultPort` over the Obsidian vault, and a
 * `SinkPort` that can write back into the vault or to an external folder.
 *
 * Everything the core engine needs from Obsidian lives here, so `src/core`
 * stays testable in plain Node and the plugin layer owns every platform
 * difference (desktop vs mobile, vault vs filesystem).
 */

import { App, normalizePath, TFile } from "obsidian";
import type { SinkPort, SourceFile, VaultPort } from "../core/types";

/** Splits a vault path into `[folder, name, ext]`. */
export function splitVaultPath(path: string): { folder: string; name: string; ext: string } {
	const slash = path.lastIndexOf("/");
	const folder = slash === -1 ? "" : path.slice(0, slash);
	const name = slash === -1 ? path : path.slice(slash + 1);
	const dot = name.lastIndexOf(".");
	return {
		folder,
		name,
		ext: dot <= 0 ? "" : name.slice(dot + 1).toLowerCase(),
	};
}

function toSourceFile(path: string, size: number, mtime: number, ctime: number): SourceFile {
	const { folder, name, ext } = splitVaultPath(path);
	return { path, name, folder, ext, size, mtime, ctime };
}

/**
 * Vault access backed by Obsidian's `Vault`. Only markdown (and optionally
 * plain text) files are listed: the engine never needs the binary assets,
 * which keeps the file list — and therefore the memory — small on big vaults.
 */
export class ObsidianVaultPort implements VaultPort {
	private readonly app: App;
	private listCache: SourceFile[] | null = null;
	/** Same objects as `listCache`, for O(1) metadata refreshes. */
	private byPath: Map<string, SourceFile> | null = null;

	constructor(app: App) {
		this.app = app;
	}

	/** Drops the cached file list; call after the vault changed structurally. */
	invalidate(): void {
		this.listCache = null;
		this.byPath = null;
	}

	/**
	 * Refreshes the cached metadata of a single file.
	 *
	 * Obsidian updates `TFile.stat` in place, but the port hands the pipeline
	 * plain snapshots (`SourceFile`), so an edited note would keep its old size
	 * and modification time in the cached list — and anything that compares
	 * those values (the automatic refresh, the delta export) would conclude
	 * that nothing changed. Structural changes still drop the whole list.
	 */
	invalidateFile(path: string, change: "modify" | "structure" = "modify"): void {
		if (change === "structure" || !this.listCache || !this.byPath) {
			this.invalidate();
			return;
		}
		const normalized = normalizePath(path);
		const entry = this.byPath.get(normalized);
		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (!(file instanceof TFile)) {
			this.invalidate();
			return;
		}
		if (!entry) {
			// A file that appeared since the list was built: rebuild it.
			this.invalidate();
			return;
		}
		entry.size = file.stat.size;
		entry.mtime = file.stat.mtime;
		entry.ctime = file.stat.ctime;
	}

	async listFiles(roots?: string[]): Promise<SourceFile[]> {
		if (!this.listCache) {
			const files = this.app.vault.getFiles();
			const list: SourceFile[] = [];
			for (const file of files) {
				if (file.extension !== "md" && file.extension !== "txt" && file.extension !== "mdx") continue;
				list.push(toSourceFile(file.path, file.stat.size, file.stat.mtime, file.stat.ctime));
			}
			list.sort((a, b) => a.path.localeCompare(b.path));
			this.listCache = list;
			this.byPath = new Map(list.map((file) => [file.path, file]));
		}
		if (!roots || roots.length === 0) return this.listCache;
		const normalized = roots.map((root) => root.replace(/^\/+|\/+$/g, "").toLowerCase());
		return this.listCache.filter((file) => {
			const path = file.path.toLowerCase();
			return normalized.some((root) => root === "" || path === root || path.startsWith(`${root}/`));
		});
	}

	async read(path: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (file instanceof TFile) {
			// `cachedRead` avoids touching the disk when Obsidian already has the
			// content in memory — a large win when re-exporting a big folder.
			return await this.app.vault.cachedRead(file);
		}
		const adapter = this.app.vault.adapter;
		if (await adapter.exists(normalizePath(path))) return await adapter.read(normalizePath(path));
		throw new Error(`File not found: ${path}`);
	}

	async readBinary(path: string): Promise<string> {
		const adapter = this.app.vault.adapter;
		const data = await adapter.readBinary(normalizePath(path));
		let binary = "";
		const bytes = new Uint8Array(data);
		const chunk = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk) {
			binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
		}
		return btoa(binary);
	}

	async exists(path: string): Promise<boolean> {
		if (this.app.vault.getAbstractFileByPath(normalizePath(path))) return true;
		return await this.app.vault.adapter.exists(normalizePath(path));
	}
}

/**
 * Writes bundle parts into the vault. Parent folders are created on demand,
 * which is what makes "Exports/NotebookLM/…" work on a fresh vault.
 */
export class VaultSinkPort implements SinkPort {
	private readonly app: App;
	/** Paths this run created, so a cancelled run can be rolled back. */
	readonly written: string[] = [];

	constructor(app: App) {
		this.app = app;
	}

	async write(path: string, content: string): Promise<string> {
		const target = normalizePath(path);
		await this.ensureFolder(target);
		const existing = this.app.vault.getAbstractFileByPath(target);
		if (existing instanceof TFile) await this.app.vault.modify(existing, content);
		else await this.app.vault.adapter.write(target, content);
		this.written.push(target);
		return target;
	}

	private async ensureFolder(target: string): Promise<void> {
		const folder = target.slice(0, target.lastIndexOf("/"));
		if (folder === "" || folder === target) return;
		// `createFolder` only makes the last segment, and a mirror export can
		// nest several levels deep (`Exports/Mirror/Daily/2026/x.md`), so every
		// ancestor is created in order.
		const segments = folder.split("/");
		let current = "";
		for (const segment of segments) {
			current = current === "" ? segment : `${current}/${segment}`;
			if (await this.app.vault.adapter.exists(current)) continue;
			await this.app.vault.createFolder(current).catch(async () => {
				// Another part of the run may have created it first: ignore then.
				if (!(await this.app.vault.adapter.exists(current))) throw new Error(`Could not create folder ${current}`);
			});
		}
	}
}

/**
 * Writes outside the vault, used by the "external folder" destination.
 * Obsidian's adapter is rooted in the vault, so this needs Node's `fs`; it is
 * therefore desktop-only and falls back gracefully on mobile.
 */
export class FileSystemSinkPort implements SinkPort {
	readonly written: string[] = [];
	private readonly fs: typeof import("fs") | null;
	private readonly pathModule: typeof import("path") | null;

	constructor() {
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			this.fs = require("fs") as typeof import("fs");
			this.pathModule = require("path") as typeof import("path");
		} catch {
			this.fs = null;
			this.pathModule = null;
		}
	}

	get available(): boolean {
		return this.fs !== null && this.pathModule !== null;
	}

	async write(path: string, content: string): Promise<string> {
		if (!this.fs || !this.pathModule) throw new Error("Writing outside the vault requires the desktop app.");
		const dir = this.pathModule.dirname(path);
		await this.fs.promises.mkdir(dir, { recursive: true });
		await this.fs.promises.writeFile(path, content, "utf8");
		this.written.push(path);
		return path;
	}
}
