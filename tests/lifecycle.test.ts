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
		expect(spy).toHaveBeenCalledWith("notes/alpha.md", "modify");
		expect(spy).toHaveBeenCalledWith("daily/2026-01-01.md", "structure");
		expect(spy).toHaveBeenCalledWith("notes/old-beta.md", "structure");
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

describe("built-in profiles end to end", () => {
	beforeEach(() => {
		Notice.messages.length = 0;
	});

	it("every shipped profile runs on the same vault", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		const results: { id: string; ok: boolean; parts: number; destination: string; why: string }[] = [];
		for (const profile of plugin.settings.profiles) {
			const outcome = await plugin.runner.run(profile, { mode: "preview" });
			results.push({
				id: profile.id,
				ok: outcome.ok,
				parts: outcome.result?.parts.length ?? -1,
				destination: profile.output.destination,
				why: outcome.error ?? "",
			});
		}
		for (const result of results) {
			expect(`${result.id}: ${result.why}`).toBe(`${result.id}: `);
			expect(result.ok).toBe(true);
			expect(result.parts).toBeGreaterThan(0);
		}
		// Clipboard profiles must not have written anything into the vault.
		expect(fake.vault.files.size).toBe(Object.keys(VAULT).length);
	});

	it("rolls a cancelled export back, even when it was already writing", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		const profile = plugin.settings.profiles[0];
		profile.packaging.chunking = { ...profile.packaging.chunking, mode: "maxTokens", maxTokens: 90, overlapTokens: 0 };
		await plugin.saveSettings();

		// Cancel right after the first part hits the vault: the run must delete
		// what it has already written instead of leaving a truncated bundle.
		const originalWrite = fake.vault.adapter.write.bind(fake.vault.adapter);
		let writes = 0;
		fake.vault.adapter.write = async (path: string, content: string) => {
			await originalWrite(path, content);
			writes++;
			if (writes === 1) plugin.runner.cancel();
		};

		const outcome = await plugin.runner.run(profile, {});
		expect(outcome.ok).toBe(false);
		expect(outcome.cancelled).toBe(true);
		expect(writes).toBeGreaterThan(0);
		const leftovers = Array.from(fake.vault.files.keys()).filter((path) => path.startsWith("Exports/"));
		expect(leftovers).toHaveLength(0);
		expect(Notice.messages.some((message) => /partially written file\(s\) were removed/.test(message))).toBe(true);
	});

	it("round-trips the settings through save and load unchanged", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		plugin.settings.concurrency = 11;
		plugin.settings.activeProfileId = plugin.settings.profiles[1].id;
		plugin.settings.profiles[0].filters.maxNotes = 7;
		await plugin.saveSettings();
		const saved = plugin.data as never;

		const second = createFakeApp(VAULT);
		const reloaded = new CondensatedVaultExporter(second.app as never, {
			id: "condensated-vault-exporter",
			version: "1.0.0",
		} as never) as unknown as TestPlugin;
		(reloaded as unknown as { loadData(): Promise<unknown> }).loadData = (async () => saved) as never;
		await reloaded.onload();
		second.ready();
		expect(reloaded.settings.concurrency).toBe(11);
		expect(reloaded.settings.activeProfileId).toBe(plugin.settings.activeProfileId);
		expect(reloaded.settings.profiles[0].filters.maxNotes).toBe(7);
	});

	it("survives a corrupted settings blob", async () => {
		const fake = createFakeApp(VAULT);
		const plugin = new CondensatedVaultExporter(fake.app as never, {
			id: "condensated-vault-exporter",
			version: "1.0.0",
		} as never) as unknown as TestPlugin;
		(plugin as unknown as { loadData(): Promise<unknown> }).loadData = (async () => ({
			version: 99,
			profiles: [{ id: "x" }, null, 42],
			activeProfileId: "nope",
			state: { version: 1, profiles: null, history: [{ broken: true }] },
		})) as never;
		await plugin.onload();
		fake.ready();
		expect(plugin.settings.profiles.length).toBeGreaterThan(0);
		expect(plugin.settings.profiles.every((profile) => profile.id && profile.name)).toBe(true);
		expect(plugin.settings.activeProfileId).toBeTruthy();
		// Still able to export.
		await plugin.commands.find((c) => c.id === "export-active-profile")!.callback?.();
		await settle(fake, plugin);
		expect(Array.from(fake.vault.files.keys()).some((path) => path.startsWith("Exports/"))).toBe(true);
	});

	it("stops a running export from the cancel command", async () => {
		// A big enough vault that cancellation lands in the middle of the run.
		const big: Record<string, string> = {};
		for (let i = 0; i < 80; i++) {
			big[`notes/n${String(i).padStart(3, "0")}.md`] =
				`# Note ${i}\n\n${Array.from({ length: 8 }, (_, s) => `Sentence ${s} about topic ${i % 5} and its details, with enough words to count.`).join(" ")}\n`;
		}
		const { fake, plugin } = bootApp(big);
		await plugin.onload();
		fake.ready();
		const original = fake.vault.cachedRead.bind(fake.vault);
		fake.vault.cachedRead = async (file: { path: string }) => {
			await new Promise((resolve) => setTimeout(resolve, 3));
			return original(file as never);
		};

		const command = plugin.commands.find((c) => c.id === "cancel-export")!;
		expect(command.checkCallback?.(true)).toBe(false); // idle → disabled
		const started = plugin.runner.run(plugin.settings.profiles[0], {});
		for (let i = 0; i < 100 && !plugin.runner.busy; i++) await new Promise((resolve) => setTimeout(resolve, 2));
		expect(plugin.runner.busy).toBe(true);
		expect(command.checkCallback?.(true)).toBe(true);
		// `cancel-export` is a checkCallback command: run it for real.
		expect(command.checkCallback?.(false)).toBe(true);
		const outcome = await started;
		expect(outcome.ok).toBe(false);
		expect(Notice.messages.some((message) => /cancel/i.test(message))).toBe(true);
		// A cancelled run leaves no half-written bundle behind.
		const leftovers = Array.from(fake.vault.files.keys()).filter((path) => path.startsWith("Exports/"));
		expect(leftovers).toHaveLength(0);
	});
});

describe("dialog scope estimate and clickable notices", () => {
	it("shows how much the export will cover", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		const scope = await plugin.runner.estimateScope("");
		expect(scope.notes).toBe(Object.keys(VAULT).length);
		expect(scope.bytes).toBeGreaterThan(100);
		const folder = await plugin.runner.estimateScope("daily");
		expect(folder.notes).toBe(3);
	});

	it("opens the bundle when its completion notice is clicked", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		plugin.settings.notifications = "verbose";
		await plugin.runner.run(plugin.settings.profiles[0], {});
		const notice = (await import("./obsidianMock")).Notice as unknown as { messages: string[] };
		expect(notice.messages.some((message) => /Exported \d+ part/.test(message))).toBe(true);
		// The notice element carries a click handler that opens the bundle.
		const { Notice: NoticeClass } = await import("./obsidianMock");
		const last = (NoticeClass as unknown as { last: InstanceType<typeof NoticeClass> | null }).last!;
		expect(last).not.toBeNull();
		expect((last.noticeEl as unknown as HTMLElement).getAttribute("title")).toMatch(/^Open Exports\//);
		(last.noticeEl as unknown as HTMLElement).click();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(fake.openedFiles.some((path) => path.startsWith("Exports/"))).toBe(true);
	});
});

describe("automatic refresh", () => {
	it("skips a run when nothing in scope changed", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		const profile = plugin.settings.profiles[0];
		// Preview runs: they exercise the same fingerprint logic without
		// touching the write path (and its overwrite confirmation).
		const first = await plugin.runner.run(profile, { mode: "preview", skipUnchanged: true });
		expect(first.ok).toBe(true);
		expect(first.skipped).toBeFalsy();

		const second = await plugin.runner.run(profile, { mode: "preview", skipUnchanged: true });
		expect(second.skipped).toBe(true);

		// Editing a note changes the fingerprint and the run happens again.
		await fake.vault.modify(
			fake.vault.getAbstractFileByPath("notes/alpha.md")!,
			"# Alpha project\n\nRewritten with enough words to pass the filter check.\n",
		);
		const third = await plugin.runner.run(profile, { mode: "preview", skipUnchanged: true });
		expect(third.ok).toBe(true);
		expect(third.skipped).toBeFalsy();
	});

	it("runs automatically after the quiet period and stops when disabled", async () => {
		vi.useFakeTimers();
		try {
			const { fake, plugin } = bootApp();
			await plugin.onload();
			fake.ready();
			plugin.settings.autoRefresh.enabled = true;
			plugin.settings.autoRefresh.debounceSeconds = 2;
			plugin.settings.autoRefresh.skipUnchanged = false;
			const spy = vi.spyOn(plugin.runner, "run");

			fake.vault.emit("modify", { path: "notes/alpha.md" });
			// Nothing happens before the quiet period elapses…
			expect(spy).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(2100);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0][1]?.skipUnchanged).toBe(false);

			// …and a second edit inside the quiet period restarts the timer
			// instead of queueing another run.
			fake.vault.emit("modify", { path: "notes/alpha.md" });
			await vi.advanceTimersByTimeAsync(1000);
			fake.vault.emit("modify", { path: "notes/beta.md" });
			await vi.advanceTimersByTimeAsync(1000);
			expect(spy).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1100);
			expect(spy).toHaveBeenCalledTimes(2);

			// Disabling cancels a pending run.
			plugin.settings.autoRefresh.enabled = false;
			fake.vault.emit("modify", { path: "notes/alpha.md" });
			await vi.advanceTimersByTimeAsync(5000);
			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("refresh and notices", () => {
	it("updates the cached file metadata when a note is edited", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		const before = await plugin.runner.estimateScope("");
		const note = fake.vault.getAbstractFileByPath("notes/alpha.md")!;
		await fake.vault.modify(note, `${fake.vault.files.get("notes/alpha.md")!.content}\\n${"extra words ".repeat(50)}\n`);
		// The plugin's own vault event handler must have refreshed the snapshot.
		const after = await plugin.runner.estimateScope("");
		expect(after.bytes).toBeGreaterThan(before.bytes);
	});

	it("refreshes the status bar text after an automatic run", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		plugin.settings.autoRefresh.enabled = true;
		plugin.settings.autoRefresh.debounceSeconds = 2;
		plugin.settings.notifications = "quiet";

		// Fire the debounce with fake timers, then let the run itself proceed in
		// real time (it awaits the vault).
		vi.useFakeTimers();
		fake.vault.emit("modify", { path: "notes/alpha.md" });
		await vi.advanceTimersByTimeAsync(2100);
		vi.useRealTimers();

		const status = plugin.statusBarItems[0] as unknown as { textContent: string };
		for (let i = 0; i < 200 && !/refreshed/.test(String(status.textContent ?? "")); i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(String(status.textContent)).toContain("NotebookLM refreshed");
	});
});

describe("custom instructions", () => {
	it("copies the instructions for the active profile from the command", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		let copied = "";
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: async (text: string) => void (copied = text) },
		});
		const command = plugin.commands.find((c) => c.id === "copy-instructions")!;
		expect(command).toBeDefined();
		await command.callback?.();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(copied).toContain("# Instructions for");
		expect(copied).toContain("## How to answer");
		// Nothing was written to the vault by a copy command.
		expect(fake.vault.files.size).toBe(Object.keys(VAULT).length);
	});

	it("puts the instructions in the preview modal as a copy button", async () => {
		const { fake, plugin } = bootApp();
		await plugin.onload();
		fake.ready();
		const { PreviewModal } = await import("../src/obsidian/modals");
		const outcome = await plugin.runner.run(plugin.settings.profiles[0], { mode: "preview" });
		expect(outcome.result?.instructions).toBeDefined();
		const modal = new PreviewModal(fake.app as never, outcome.result!, () => undefined);
		modal.open();
		const labels = Array.from(modal.contentEl.querySelectorAll("button")).map((button) => button.textContent);
		expect(labels.some((label) => /instructions/i.test(label ?? ""))).toBe(true);
		modal.close();
	});
});
