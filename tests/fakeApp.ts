/**
 * A FakeApp: an in-memory vault that behaves like Obsidian's, plus the event
 * bus, workspace and status-bar API the plugin uses.
 */

import type { App, Command, TFile } from "./types";
import { createElement, Component, Notice, PluginSettingTab, type El } from "./obsidianMock";

export interface FakeVaultFile {
	path: string;
	content: string;
	mtime: number;
	ctime: number;
}

type EventHandler = (...args: never[]) => void;

export class FakeVault {
	files = new Map<string, FakeVaultFile>();
	folders = new Set<string>();
	private handlers = new Map<string, EventHandler[]>();

	constructor(initial: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(initial)) this.seed(path, content);
	}

	seed(path: string, content: string, mtime = Date.now()): TFile {
		this.files.set(path, { path, content, mtime, ctime: mtime });
		const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (folder !== "") this.folders.add(folder);
		return this.getAbstractFileByPath(path) as TFile;
	}

	getFiles(): TFile[] {
		return Array.from(this.files.keys())
			.sort()
			.map((path) => this.getAbstractFileByPath(path) as TFile);
	}

	getAbstractFileByPath(path: string): TFile | null {
		if (this.files.has(path)) {
			const file = this.files.get(path)!;
			return {
				path,
				name: path.split("/").pop() ?? path,
				basename: (path.split("/").pop() ?? path).replace(/\.[^.]+$/, ""),
				extension: path.split(".").pop() ?? "",
				stat: { size: file.content.length, mtime: file.mtime, ctime: file.ctime },
				vault: this,
			} as unknown as TFile;
		}
		return null;
	}

	async cachedRead(file: TFile): Promise<string> {
		const entry = this.files.get(file.path);
		if (!entry) throw new Error(`missing ${file.path}`);
		return entry.content;
	}

	async read(file: TFile): Promise<string> {
		return await this.cachedRead(file);
	}

	async modify(file: TFile, content: string): Promise<void> {
		this.seed(file.path, content);
		this.emit("modify", file);
	}

	async create(path: string, content: string): Promise<TFile> {
		const file = this.seed(path, content);
		this.emit("create", file);
		return file;
	}

	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}

	async delete(file: TFile): Promise<void> {
		this.files.delete(file.path);
		this.emit("delete", file);
	}

	async rename(file: TFile, newPath: string): Promise<void> {
		const entry = this.files.get(file.path);
		if (!entry) throw new Error(`missing ${file.path}`);
		this.files.delete(file.path);
		this.files.set(newPath, { ...entry, path: newPath });
		this.emit("rename", file, file.path);
	}

	adapter = {
		exists: async (path: string) => this.files.has(path) || this.folders.has(path),
		read: async (path: string) => {
			const entry = this.files.get(path);
			if (!entry) throw new Error(`missing ${path}`);
			return entry.content;
		},
		write: async (path: string, content: string) => {
			this.seed(path, content);
		},
		readBinary: async () => new ArrayBuffer(0),
		list: async (path: string) => ({
			files: Array.from(this.files.keys()).filter((key) => key.startsWith(`${path}/`)),
			folders: Array.from(this.folders).filter((key) => key.startsWith(`${path}/`) && key !== path),
		}),
	};

	on(type: string, handler: EventHandler): { type: string; handler: EventHandler } {
		const list = this.handlers.get(type) ?? [];
		list.push(handler);
		this.handlers.set(type, list);
		return { type, handler };
	}

	emit(type: string, ...args: unknown[]): void {
		for (const handler of this.handlers.get(type) ?? []) handler(...(args as never[]));
	}

	config: Record<string, unknown> = {};

	getConfig(key: string): unknown {
		return this.config[key];
	}
}

export function createFakeApp(initial: Record<string, string> = {}) {
	const vault = new FakeVault(initial);
	const workspaceHandlers = new Map<string, EventHandler[]>();
	const openedFiles: string[] = [];
	const statusBar: HTMLElement[] = [];
	const leaves: { openFile: (file: TFile) => Promise<void> }[] = [
		{ openFile: async (file: TFile) => void openedFiles.push(file.path) },
	];

	const app = {
		vault: vault as unknown,
		workspace: {
			on: (type: string, handler: EventHandler) => {
				const list = workspaceHandlers.get(type) ?? [];
				list.push(handler);
				workspaceHandlers.set(type, list);
				return { type, handler };
			},
			emit: (type: string, ...args: unknown[]) => {
				for (const handler of workspaceHandlers.get(type) ?? []) handler(...(args as never[]));
			},
			onLayoutReady: (callback: () => void) => {
				layoutReadyCallbacks.push(callback);
			},
			getLeaf: () => leaves[0],
		},
		plugins: { manifests: { "condensated-vault-exporter": { version: "1.0.0" } } },
	};

	const layoutReadyCallbacks: (() => void)[] = [];

	return {
		app: app as unknown as App,
		vault,
		openedFiles,
		statusBar,
		/** Fires the queued `onLayoutReady` callbacks (Obsidian does this once the UI exists). */
		ready: () => {
			for (const callback of layoutReadyCallbacks) callback();
		},
		emitFileMenu: (file: unknown, menu: { items: { title: string; click: () => unknown }[] }) => {
			const handlers = workspaceHandlers.get("file-menu") ?? [];
			const api = {
				addItem: (build: (item: unknown) => unknown) => {
					const item = {
						title: "",
						setTitle(title: string) {
							this.title = title;
							return this;
						},
						setIcon() {
							return this;
						},
						onClick(click: () => unknown) {
							menu.items.push({ title: this.title, click });
							return this;
						},
					};
					build(item);
					return api;
				},
			};
			for (const handler of handlers) handler(api as never, file as never);
			return menu;
		},
	};
}

export { Component, Notice, PluginSettingTab, createElement };
export type { El, Command };
