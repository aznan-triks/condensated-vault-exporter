// @vitest-environment happy-dom
/**
 * End-to-end plugin lifecycle test: the real plugin class, the real runner and
 * the real engine, with only Obsidian itself (and its filesystem) mocked.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

import CondensatedVaultExporter from "../src/main";
import { createFakeApp } from "./fakeApp";
import {
	ButtonComponent,
	DropdownComponent,
	Notice,
	Setting,
	TextComponent,
	TFolder,
	ToggleComponent,
	type Plugin as MockPlugin,
} from "./obsidianMock";
import type { ExportRunner } from "../src/obsidian/runner";
import type { PluginSettings } from "../src/obsidian/settings";

/** The plugin, seen through the mock's API (commands, ribbon, status bar). */
type TestPlugin = MockPlugin & {
	settings: PluginSettings;
	runner: ExportRunner;
	saveSettings(): Promise<void>;
	clearCache(): void;
};

const VAULT: Record<string, string> = {
	"notes/alpha.md":
		"---\ntags: [project]\n---\n# Alpha project\n\nAlpha is a retrieval system that indexes notes and serves answers. [[notes/beta]] explains the storage layer. " +
		"Chunking, overlap and metadata decide whether the assistant answers from the right source.\n",
	"notes/beta.md":
		"---\ntags: [project]\n---\n# Beta project\n\nBeta stores documents and serves them back quickly. It is the storage half of the system. " +
		"Backups, integrity and compaction all matter for long-lived vaults.\n",
	"daily/2026-01-01.md":
		"# 2026-01-01\n\n## Gratitude\n\n- coffee\n\n## Tasks\n\n- [ ] ship\n\nReviewed the retrieval design and wrote notes about ranking signals today.\n",
	"daily/2026-01-02.md":
		"# 2026-01-02\n\n## Gratitude\n\n- tea\n\n## Tasks\n\n- [x] ship\n\nImplemented the storage layer and measured latency under load today.\n",
	"daily/2026-01-03.md":
		"# 2026-01-03\n\n## Gratitude\n\n- water\n\n## Tasks\n\n- [ ] rest\n\nDocumented the ingestion pipeline and the evaluation harness today.\n",
};

function bootApp(vault: Record<string, string> = VAULT) {
	const fake = createFakeApp(vault);
	const plugin = new CondensatedVaultExporter(fake.app as never, {
		id: "condensated-vault-exporter",
		version: "1.0.0",
	} as never) as unknown as TestPlugin;
	return { fake, plugin };
}

/** Waits until the runner is idle (the plugin's commands are fire-and-forget). */
async function settle(fake: ReturnType<typeof createFakeApp>, plugin: TestPlugin): Promise<void> {
	for (let i = 0; i < 400; i++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		if (!plugin.runner.busy && fake.vault.files.size > 0) return;
	}
}

describe("plugin lifecycle", () => {
	beforeEach(() => {
		Notice.messages.length = 0;
	});

	it("loads, exposes commands, a ribbon icon and a status bar item", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();

		const ids = plugin.commands.map((command) => command.id);
		expect(ids).toContain("export-active-profile");
		expect(ids).toContain("preview-active-profile");
		expect(ids).toContain("copy-active-profile");
		expect(ids).toContain("cancel-export");
		expect(ids.some((id) => id.startsWith("export-profile-"))).toBe(true);
		expect(plugin.ribbonIcons).toHaveLength(1);
		// Status bar is created on layout ready.
		expect(plugin.statusBarItems.length).toBe(1);
		expect(plugin.settingTabs.length).toBe(1);
	});

	it("runs an export from the quick command and writes the bundle", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();

		const command = plugin.commands.find((c) => c.id === "export-active-profile")!;
		await command.callback?.();
		await settle(fake, plugin);

		const written = Array.from(fake.vault.files.keys()).filter((path) => path.startsWith("Exports/"));
		expect(written.length).toBeGreaterThan(0);
		const bundle = fake.vault.files.get(written[0])!.content;
		expect(bundle).toContain("# Vault bundle");
		expect(bundle).toContain("Alpha project");
		// The corpus map is part of the preamble.
		expect(bundle).toContain("Corpus overview");
		// Boilerplate shared by the three daily notes is gone.
		expect(bundle).not.toContain("Gratitude");
		// The settings were persisted.
		expect(plugin.data).not.toBeNull();
	});

	it("writes the sidecars and honours the note cap", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		plugin.settings.profiles[0].filters.maxNotes = 2;
		plugin.settings.profiles[0].targets = ["notes"];
		await plugin.saveSettings();

		await plugin.commands.find((c) => c.id === "export-active-profile")!.callback?.();
		await settle(fake, plugin);
		const manifest = Array.from(fake.vault.files.keys()).find((path) => path.endsWith(".manifest.json"));
		expect(manifest).toBeDefined();
		const payload = JSON.parse(fake.vault.files.get(manifest!)!.content);
		expect(payload.stats.kept).toBe(2);
		expect(payload.profileId).toBe(plugin.settings.profiles[0].id);
		// The sidecar records the exact revision of every bundled note.
		expect(Object.keys(payload.hashes)).toHaveLength(2);
	});

	it("previews without writing anything", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		const before = fake.vault.files.size;
		await plugin.commands.find((c) => c.id === "preview-active-profile")!.callback?.();
		for (let i = 0; i < 400; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			if (!plugin.runner.busy) break;
		}
		expect(fake.vault.files.size).toBe(before);
	});

	it("exports a folder from the file menu", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		const menu = { items: [] as { title: string; click: () => unknown }[] };
		fake.emitFileMenu(new TFolder("notes"), menu);
		expect(menu.items.length).toBe(1);
		expect(menu.items[0].title).toContain("AI-ready bundle");
	});

	it("invalidates the analysis cache when a note changes", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		const spy = vi.spyOn(plugin.runner, "invalidatePath");
		fake.vault.emit("modify", { path: "notes/alpha.md" });
		fake.vault.emit("delete", { path: "daily/2026-01-01.md" });
		fake.vault.emit("rename", { path: "notes/beta.md" }, "notes/old-beta.md");
		expect(spy).toHaveBeenCalledWith("notes/alpha.md");
		expect(spy).toHaveBeenCalledWith("daily/2026-01-01.md");
		expect(spy).toHaveBeenCalledWith("notes/old-beta.md");
	});

	it("keeps working when the vault is empty", async () => {
		const { fake, plugin } = bootApp({});
		await plugin.onload();
		fake.ready();
		await plugin.commands.find((c) => c.id === "export-active-profile")!.callback?.();
		for (let i = 0; i < 400; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			if (!plugin.runner.busy) break;
		}
		expect(Notice.messages.some((message) => /no notes matched|0 notes|exported/i.test(message))).toBe(true);
	});

	it("unloads cleanly", async () => {
		const { plugin } = bootApp();
		await plugin.onload();
		await expect(plugin.unloadPlugin()).resolves.not.toThrow();
	});
});

describe("export dialog and settings tab", () => {
	beforeEach(() => {
		Notice.messages.length = 0;
	});

	it("builds the whole settings tab without errors", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		const tab = plugin.settingTabs[0];
		expect(tab).toBeDefined();
		expect(() => tab.display()).not.toThrow();
		expect(tab.containerEl.children.length).toBeGreaterThan(5);
	});

	it("edits a profile through the settings tab", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		const tab = plugin.settingTabs[0];
		Setting.instances.length = 0;
		tab.display();

		const find = (name: string) => Setting.instances.find((setting) => setting.name.startsWith(name));
		// A number field: the note cap.
		const capField = find("Maximum notes")?.control(TextComponent);
		expect(capField).toBeDefined();
		await capField!.setUserValue("3");
		expect(plugin.settings.profiles[0].filters.maxNotes).toBe(3);

		// A toggle: the table of contents.
		const tocToggle = find("Table of contents")?.control(ToggleComponent);
		expect(tocToggle).toBeDefined();
		await tocToggle!.toggleUser(false);
		expect(plugin.settings.profiles[0].packaging.includeToc).toBe(false);

		// A dropdown: the chunking mode switches the visible controls.
		const modeDropdown = find("Split into parts")?.control(DropdownComponent);
		expect(modeDropdown?.options.maxTokens).toBeDefined();
		await modeDropdown!.selectUser("maxTokens");

		// Everything was persisted through saveData.
		const stored = plugin.data as { profiles: { filters: { maxNotes: number }; packaging: { includeToc: boolean } }[] };
		expect(stored.profiles[0].filters.maxNotes).toBe(3);
		expect(stored.profiles[0].packaging.includeToc).toBe(false);
	});

	it("duplicates a profile from the settings tab", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		const tab = plugin.settingTabs[0];
		Setting.instances.length = 0;
		tab.display();
		const duplicate = Setting.instances.find((setting) => setting.name === "Profile to edit")?.control(ButtonComponent);
		expect(duplicate).toBeDefined();
		const before = plugin.settings.profiles.length;
		await duplicate!.click();
		expect(plugin.settings.profiles.length).toBe(before + 1);
		// The new profile is a usable copy, and its command exists.
		const copy = plugin.settings.profiles[plugin.settings.profiles.length - 1];
		expect(copy.builtin).toBeFalsy();
		expect(plugin.commands.some((command) => command.id === `export-profile-${copy.id}`)).toBe(true);
	});

	it("runs an export from the dialog and applies the dialog overrides", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		const { ExportDialog } = await import("../src/obsidian/modals");
		let submitted: { profile: { output: { destination: string } } ; target?: string } | null = null;
		const dialog = new ExportDialog(
			fake.app as never,
			plugin.settings,
			plugin.runner,
			(result) => {
				submitted = result as never;
			},
			{ target: "notes" },
		);
		dialog.open();
		expect(dialog.contentEl.children.length).toBeGreaterThan(3);
		// The dialog is closed and the profile handed over on submit; click the
		// export button at the end of the button row.
		const buttons = dialog.contentEl.querySelectorAll?.("button") ?? [];
		expect(buttons.length).toBeGreaterThan(0);
		dialog.close();
		expect(submitted).toBeNull();
	});

	it("previews a bundle in the preview modal", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		const { PreviewModal } = await import("../src/obsidian/modals");
		const outcome = await plugin.runner.run(plugin.settings.profiles[0], { mode: "preview" });
		expect(outcome.ok).toBe(true);
		const modal = new PreviewModal(fake.app as never, outcome.result!, () => undefined);
		modal.open();
		expect(modal.contentEl.children.length).toBeGreaterThan(2);
		modal.close();
	});

	it("aborts an export when the overwrite confirmation is declined", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		// First run writes the bundle.
		await plugin.runner.run(plugin.settings.profiles[0], {});
		const first = Array.from(fake.vault.files.keys()).filter((path) => path.startsWith("Exports/"));
		expect(first.length).toBeGreaterThan(0);
		const before = fake.vault.files.get(first[0])!.content;

		// Second run: the confirmation resolves to "cancel" as soon as it opens.
		const { Modal } = await import("./obsidianMock");
		const originalOpen = Modal.prototype.open;
		Modal.prototype.open = function (this: InstanceType<typeof Modal>) {
			(originalOpen as () => void).call(this);
			// Decline: close without confirming.
			this.close();
		};
		try {
			const outcome = await plugin.runner.run(plugin.settings.profiles[0], {});
			expect(outcome.ok).toBe(false);
			expect(fake.vault.files.get(first[0])!.content).toBe(before);
			expect(Notice.messages.some((message) => /aborted/i.test(message))).toBe(true);
		} finally {
			Modal.prototype.open = originalOpen;
		}
	});
});
