/**
 * Plugin-layer tests.
 *
 * Obsidian itself is mocked: what matters here is that the settings model is
 * forgiving with old/partial/corrupt data, that profiles survive a round trip
 * through data.json, and that the vault adapter maps Obsidian's file objects
 * onto the core's `SourceFile` shape.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
	class TFile {
		path: string;
		extension: string;
		stat: { size: number; mtime: number; ctime: number };
		constructor(path: string, size = 10, mtime = 0, ctime = 0) {
			this.path = path;
			this.extension = path.split(".").pop() ?? "";
			this.stat = { size, mtime, ctime };
		}
	}
	class TFolder {
		path: string;
		constructor(path: string) {
			this.path = path;
		}
	}
	return { TFile, TFolder, normalizePath: (path: string) => path.replace(/^\/+/, "") };
});

import { TFile, TFolder } from "obsidian";

/** The mocked classes take constructor arguments; the real typings do not. */
type FileCtor = new (path: string, size?: number, mtime?: number, ctime?: number) => InstanceType<typeof TFile>;
type FolderCtor = new (path: string) => InstanceType<typeof TFolder>;
const FakeFile = TFile as unknown as FileCtor;
const FakeFolder = TFolder as unknown as FolderCtor;
import { ObsidianVaultPort, VaultSinkPort, splitVaultPath } from "../src/obsidian/vaultPort";
import { defaultSettings, duplicateProfile, normalizeSettings } from "../src/obsidian/settings";
import { createBuiltinProfile, describeProfile } from "../src/core/profiles";

interface FakeVault {
	getFiles(): InstanceType<typeof TFile>[];
	getAbstractFileByPath(path: string): unknown;
	adapter: {
		exists(path: string): Promise<boolean>;
		read(path: string): Promise<string>;
		write(path: string, data: string): Promise<void>;
		list(path: string): Promise<{ files: string[]; folders: string[] }>;
	};
	cachedRead(file: InstanceType<typeof TFile>): Promise<string>;
	modify(file: InstanceType<typeof TFile>, data: string): Promise<void>;
	createFolder(path: string): Promise<void>;
}

function makeApp(files: Record<string, string> = {}) {
	const store = new Map(Object.entries(files));
	const folders = new Set<string>();
	const vault: FakeVault = {
		getFiles: () =>
			Array.from(store.keys())
				.filter((path) => !path.endsWith("/"))
				.map((path) => new FakeFile(path)),
		getAbstractFileByPath: (path) => (store.has(path) && !path.endsWith("/") ? new FakeFile(path) : null),
		adapter: {
			exists: async (path) => store.has(path) || folders.has(path),
			read: async (path) => store.get(path) ?? "",
			write: async (path, data) => {
				store.set(path, data);
			},
			list: async (path) => ({
				files: Array.from(store.keys()).filter((key) => key.startsWith(`${path}/`)),
				folders: [],
			}),
		},
		cachedRead: async (file) => store.get(file.path) ?? "",
		modify: async (file, data) => {
			store.set(file.path, data);
		},
		createFolder: async (path) => {
			folders.add(path);
		},
	};
	return { app: { vault } as unknown as ConstructorParameters<typeof ObsidianVaultPort>[0], store, vault, folders };
}

describe("plugin settings", () => {
	it("starts from the built-in profiles", () => {
		const settings = defaultSettings();
		expect(settings.profiles.length).toBeGreaterThanOrEqual(5);
		expect(settings.profiles.every((profile) => profile.builtin)).toBe(true);
		expect(settings.profiles.some((profile) => profile.id === "notebooklm")).toBe(true);
		expect(defaultSettings().activeProfileId).toBe(settings.profiles[0].id);
	});

	it("survives corrupt stored data", () => {
		for (const garbage of [null, 42, "nope", {}, { profiles: "x" }, { profiles: [null, 3] }]) {
			const settings = normalizeSettings(garbage);
			expect(settings.profiles.length).toBeGreaterThan(0);
			expect(settings.activeProfileId).not.toBe("");
		}
	});

	it("keeps the shipped definition of a built-in profile but applies user edits", () => {
		const stored = {
			version: 1,
			profiles: [
				{
					id: "notebooklm",
					name: "My NotebookLM",
					builtin: true,
					packaging: { includeToc: false },
					filters: { tagsAll: ["research"] },
				},
			],
			activeProfileId: "notebooklm",
		};
		const settings = normalizeSettings(stored);
		const profile = settings.profiles.find((p) => p.id === "notebooklm")!;
		expect(profile.packaging.includeToc).toBe(false);
		expect(profile.filters.tagsAll).toEqual(["research"]);
		// The rest of the recipe still comes from the plugin, not from the file.
		expect(profile.packaging.includeKnowledgeMap).toBe(true);
		expect(profile.limits.maxParts).toBeGreaterThan(0);
	});

	it("adds profiles that appeared in a newer plugin version", () => {
		const settings = normalizeSettings({ version: 1, profiles: [], activeProfileId: "" });
		expect(settings.profiles.map((p) => p.id)).toContain("rag-chunks");
		expect(settings.activeProfileId).toBe("notebooklm");
	});

	it("duplicates a profile with a unique id and name", () => {
		const base = createBuiltinProfile("notebooklm")!;
		const settings = defaultSettings();
		const copy = duplicateProfile(base, settings.profiles);
		expect(copy.builtin).toBeFalsy();
		expect(copy.id).not.toBe(base.id);
		expect(settings.profiles.map((p) => p.id)).not.toContain(copy.id);
		// Deep copy: editing the copy must not touch the original.
		copy.packaging.format = "jsonl";
		expect(base.packaging.format).toBe("markdown");
		expect(copy.name).toContain("copy");
	});

	it("describes a profile in plain language", () => {
		const profile = createBuiltinProfile("rag-chunks")!;
		const description = describeProfile(profile);
		expect(description).toContain("JSON Lines");
		expect(description.length).toBeGreaterThan(40);
	});
});

describe("vault adapter", () => {
	it("splits vault paths", () => {
		expect(splitVaultPath("a/b/c.md")).toEqual({ folder: "a/b", name: "c.md", ext: "md" });
		expect(splitVaultPath("note.md")).toEqual({ folder: "", name: "note.md", ext: "md" });
		expect(splitVaultPath("folder/no-extension")).toEqual({ folder: "folder", name: "no-extension", ext: "" });
		expect(splitVaultPath(".hidden")).toEqual({ folder: "", name: ".hidden", ext: "" });
	});

	it("lists only text notes and honours roots", async () => {
		const { app } = makeApp({
			"notes/a.md": "# A",
			"notes/b.md": "# B",
			"other/c.md": "# C",
			"assets/image.png": "x",
			"notes/data.json": "{}",
		});
		const port = new ObsidianVaultPort(app);
		const all = await port.listFiles();
		expect(all.map((file) => file.path)).toEqual(["notes/a.md", "notes/b.md", "other/c.md"]);

		const scoped = await port.listFiles(["notes"]);
		expect(scoped.map((file) => file.path)).toEqual(["notes/a.md", "notes/b.md"]);

		const root = await port.listFiles([""]);
		expect(root.length).toBe(3);
	});

	it("reads through the cache and falls back to the adapter", async () => {
		const { app } = makeApp({ "a.md": "hello", "raw.txt": "raw" });
		const port = new ObsidianVaultPort(app);
		expect(await port.read("a.md")).toBe("hello");
		expect(await port.read("raw.txt")).toBe("raw");
		expect(await port.exists("a.md")).toBe(true);
		await expect(port.read("missing.md")).rejects.toThrow(/not found/i);
	});

	it("creates folders when writing a bundle and reports written paths", async () => {
		const { app, store, vault } = makeApp({});
		const sink = new VaultSinkPort(app);
		const written = await sink.write("Exports/NotebookLM/part-1.md", "content");
		expect(written).toBe("Exports/NotebookLM/part-1.md");
		expect(store.get("Exports/NotebookLM/part-1.md")).toBe("content");
		expect(sink.written).toEqual(["Exports/NotebookLM/part-1.md"]);

		// A second write replaces the content instead of duplicating the file.
		await sink.write("Exports/NotebookLM/part-1.md", "updated");
		expect(store.get("Exports/NotebookLM/part-1.md")).toBe("updated");
		expect(vault.getFiles().length).toBe(1);
	});

	it("is tolerant when a folder already exists", async () => {
		const { app, folders, store } = makeApp({});
		folders.add("Exports");
		const sink = new VaultSinkPort(app);
		await sink.write("Exports/bundle.md", "data");
		expect(store.get("Exports/bundle.md")).toBe("data");
	});

	it("keeps folder objects out of the note list", async () => {
		const { app } = makeApp({ "a.md": "a" });
		expect(new FakeFolder("folder")).toBeInstanceOf(TFolder);
		const port = new ObsidianVaultPort(app);
		const files = await port.listFiles();
		expect(files.every((file) => !(file instanceof TFolder))).toBe(true);
	});
});
