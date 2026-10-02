/**
 * Settings tab.
 *
 * The philosophy: a profile is a coherent recipe, so the tab edits *one
 * profile at a time* and shows what the profile will do (a plain-language
 * summary) instead of presenting sixty unrelated toggles. Built-ins can be
 * forked; user profiles can be renamed, edited and deleted.
 */

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type {
	BundleLimits,
	ChunkMode,
	ExportFormat,
	ExportProfile,
	IncrementalMode,
	OrderBy,
	OutputDestination,
} from "../core/types";
import { BUILTIN_PROFILES, describeProfile } from "../core/profiles";
import { LIMIT_PRESETS, UNLIMITED } from "../core/pack/limits";
import { formatCount } from "../core/util";
import { duplicateProfile, type PluginSettings } from "./settings";
import type CondensatedVaultExporter from "../main";

export class ExportSettingsTab extends PluginSettingTab {
	private selectedId: string;

	constructor(
		app: App,
		private readonly plugin: CondensatedVaultExporter,
		private readonly settings: PluginSettings,
	) {
		super(app, plugin);
		this.selectedId = settings.activeProfileId;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("cve-settings");

		this.renderGeneral(containerEl);
		this.renderProfiles(containerEl);
		this.renderActiveProfile(containerEl);
		this.renderHistory(containerEl);
	}

	/* ------------------------------------------------------------------ */

	private renderGeneral(root: HTMLElement): void {
		root.createEl("h2", { text: "Plugin" });

		new Setting(root)
			.setName("Status bar")
			.setDesc("Show the export progress in the status bar while a run is in flight.")
			.addToggle((toggle) =>
				toggle.setValue(this.settings.statusBar).onChange(async (value) => {
					this.settings.statusBar = value;
					await this.plugin.applySettings();
				}),
			);

		new Setting(root)
			.setName("Notifications")
			.setDesc("How chatty the plugin should be after a run.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("verbose", "Verbose (live progress popup)")
					.addOption("normal", "Normal (result summary)")
					.addOption("quiet", "Quiet (only problems)")
					.setValue(this.settings.notifications)
					.onChange(async (value) => {
						this.settings.notifications = value as PluginSettings["notifications"];
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("Remember what was exported")
			.setDesc("Keeps a fingerprint of every exported note so incremental runs know what changed.")
			.addToggle((toggle) =>
				toggle.setValue(this.settings.rememberHistory).onChange(async (value) => {
					this.settings.rememberHistory = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Open the bundle after exporting")
			.addToggle((toggle) =>
				toggle.setValue(this.settings.openAfterExport).onChange(async (value) => {
					this.settings.openAfterExport = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Notes analysed in parallel")
			.setDesc("Higher is faster on big vaults, at the cost of memory.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 16, 1)
					.setValue(this.settings.concurrency)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.settings.concurrency = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("Ask before overwriting")
			.setDesc("A confirmation lists the existing files a run would replace.")
			.addToggle((toggle) =>
				toggle.setValue(this.settings.confirmOverwrite).onChange(async (value) => {
					this.settings.confirmOverwrite = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Keep a bundle up to date automatically")
			.setDesc(
				"After the vault has been quiet for a while, re-run the profile below. Only writes when the notes in scope actually changed.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.settings.autoRefresh.enabled).onChange(async (value) => {
					this.settings.autoRefresh.enabled = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (this.settings.autoRefresh.enabled) {
			new Setting(root)
				.setName("Profile used for automatic runs")
				.setDesc("Keep this one cheap: it runs in the background after every editing session.")
				.addDropdown((dropdown) => {
					dropdown.addOption("", `(active profile: ${this.settings.activeProfileId})`);
					for (const profile of this.settings.profiles) dropdown.addOption(profile.id, profile.name);
					dropdown.setValue(this.settings.autoRefresh.profileId).onChange(async (value) => {
						this.settings.autoRefresh.profileId = value;
						await this.plugin.saveSettings();
					});
				});

			new Setting(root)
				.setName("Quiet period (seconds)")
				.setDesc("How long the vault must be still before an automatic run starts.")
				.addSlider((slider) =>
					slider
						.setLimits(2, 120, 1)
						.setValue(this.settings.autoRefresh.debounceSeconds)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.settings.autoRefresh.debounceSeconds = value;
							await this.plugin.saveSettings();
						}),
				);

			new Setting(root)
				.setName("Skip when nothing changed")
				.setDesc("Compares paths, sizes and modification times before doing any work.")
				.addToggle((toggle) =>
					toggle.setValue(this.settings.autoRefresh.skipUnchanged).onChange(async (value) => {
						this.settings.autoRefresh.skipUnchanged = value;
						await this.plugin.saveSettings();
					}),
				);
		}

		new Setting(root)
			.setName("Analysis cache")
			.setDesc("Pass 1 of an export analyses every note. The cache makes re-runs almost instant.")
			.addButton((button) =>
				button.setButtonText("Clear cache").onClick(() => {
					this.plugin.clearCache();
					new Notice("Analysis cache cleared.");
				}),
			)
			.addButton((button) =>
				button.setButtonText("Forget export history").onClick(async () => {
					this.settings.state = { version: 1, profiles: {}, history: [] };
					await this.plugin.saveSettings();
					this.display();
					new Notice("Export history cleared.");
				}),
			);
	}

	private renderProfiles(root: HTMLElement): void {
		root.createEl("h2", { text: "Profiles" });
		root.createEl("p", {
			cls: "cve-hint",
			text: "Each profile is a complete recipe: what to read, how to condense it, and how to package it. Built-in profiles are tuned for a destination; duplicate one to make it yours.",
		});

		new Setting(root)
			.setName("Profile to edit")
			.addDropdown((dropdown) => {
				for (const profile of this.settings.profiles) {
					dropdown.addOption(profile.id, `${profile.name}${profile.builtin ? " (built-in)" : ""}`);
				}
				dropdown.setValue(this.selectedId).onChange((value) => {
					this.selectedId = value;
					this.display();
				});
			})
			.addButton((button) =>
				button.setButtonText("Duplicate").onClick(async () => {
					const source = this.profile();
					if (!source) return;
					const copy = duplicateProfile(source, this.settings.profiles);
					this.settings.profiles.push(copy);
					this.selectedId = copy.id;
					await this.plugin.saveSettings();
					this.plugin.syncProfileCommands();
					this.display();
				}),
			)
			.addExtraButton((button) =>
				button
					.setIcon("trash")
					.setTooltip("Delete this profile")
					.onClick(async () => {
						const profile = this.profile();
						if (!profile || profile.builtin) {
							new Notice("Built-in profiles cannot be deleted — duplicate it first.");
							return;
						}
						this.settings.profiles = this.settings.profiles.filter((p) => p.id !== profile.id);
						this.selectedId = this.settings.profiles[0]?.id ?? "";
						await this.plugin.saveSettings();
						this.plugin.syncProfileCommands();
						this.display();
					}),
			);

		const profile = this.profile();
		if (!profile) return;
		new Setting(root)
			.setName("Use this profile for the ribbon icon")
			.setDesc("The ribbon button and the quick-export command use the active profile.")
			.addButton((button) =>
				button
					.setButtonText(this.settings.activeProfileId === profile.id ? "Active" : "Set active")
					.setDisabled(this.settings.activeProfileId === profile.id)
					.onClick(async () => {
						this.settings.activeProfileId = profile.id;
						await this.plugin.saveSettings();
						this.display();
					}),
			);
	}

	private renderActiveProfile(root: HTMLElement): void {
		const profile = this.profile();
		if (!profile) return;
		root.createEl("h2", { text: profile.name });
		root.createEl("p", { text: profile.description });
		const summary = root.createEl("div", { cls: "cve-profile-summary" });
		for (const line of describeProfile(profile).split("\n").slice(0, 7)) {
			summary.createEl("div", { text: line.replace(/^[-•]\s*/, "") });
		}

		this.renderSources(root, profile);
		this.renderCondensation(root, profile);
		this.renderPackaging(root, profile);
		this.renderOutput(root, profile);
		this.renderLimits(root, profile);
	}

	private renderSources(root: HTMLElement, profile: ExportProfile): void {
		root.createEl("h3", { text: "Sources" });

		new Setting(root)
			.setName("Folders")
			.setDesc("One folder per line. Empty means the whole vault.")
			.addTextArea((area) => {
				area.inputEl.rows = 3;
				area.setValue(profile.targets.join("\n")).onChange(async (value) => {
					profile.targets = value
						.split("\n")
						.map((line) => line.trim())
						.filter((line) => line !== "");
					await this.plugin.saveSettings();
				});
			});

		new Setting(root)
			.setName("Recursion depth")
			.setDesc("-1 = every subfolder, 0 = only the folder itself, 1 = one level down…")
			.addText((text) =>
				text.setValue(String(profile.depth)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					profile.depth = Number.isFinite(parsed) ? parsed : -1;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Include")
			.setDesc("Glob patterns, one per line (e.g. `**/*.md`).")
			.addTextArea((area) => {
				area.inputEl.rows = 2;
				area.setValue(profile.include.join("\n")).onChange(async (value) => {
					profile.include = value
						.split("\n")
						.map((line) => line.trim())
						.filter((line) => line !== "");
					await this.plugin.saveSettings();
				});
			});

		new Setting(root)
			.setName("Exclude")
			.setDesc("Globs to skip, one per line. `!` re-includes a previously excluded pattern.")
			.addTextArea((area) => {
				area.inputEl.rows = 2;
				area.setValue(profile.exclude.join("\n")).onChange(async (value) => {
					profile.exclude = value
						.split("\n")
						.map((line) => line.trim())
						.filter((line) => line !== "");
					await this.plugin.saveSettings();
				});
			});

		new Setting(root)
			.setName("Tags")
			.setDesc("Keep only notes carrying all of these tags (comma separated).")
			.addText((text) =>
				text.setValue(profile.filters.tagsAll.join(", ")).onChange(async (value) => {
					profile.filters.tagsAll = splitList(value);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Exclude tags")
			.addText((text) =>
				text.setValue(profile.filters.tagsNone.join(", ")).onChange(async (value) => {
					profile.filters.tagsNone = splitList(value);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Changed in the last N days")
			.setDesc("0 = no date filter.")
			.addText((text) =>
				text.setValue(String(profile.filters.modifiedWithinDays ?? 0)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					profile.filters.modifiedWithinDays = parsed > 0 ? parsed : null;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Maximum notes")
			.setDesc("0 = no cap. The cap keeps the first notes of the chosen order.")
			.addText((text) =>
				text.setValue(String(profile.filters.maxNotes ?? 0)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					profile.filters.maxNotes = parsed > 0 ? parsed : null;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Focus on a topic")
			.setDesc("Free text, e.g. “retrieval evaluation”. Only the notes that match it best are exported; leave empty for everything.")
			.addText((text) =>
				text.setValue(profile.filters.focus?.query ?? "").onChange(async (value) => {
					const query = value.trim();
					profile.filters.focus = query === "" ? null : { query, maxNotes: profile.filters.focus?.maxNotes ?? 30 };
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Focus: maximum notes")
			.setDesc("How many of the best-matching notes to keep (0 = no cap).")
			.addText((text) =>
				text.setValue(String(profile.filters.focus?.maxNotes ?? 30)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (!Number.isFinite(parsed) || parsed < 0) return;
					if (profile.filters.focus) profile.filters.focus.maxNotes = parsed;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Focus on a note's neighbourhood")
			.setDesc("Vault path of a note; leave empty to export the whole selection. Also available by right-clicking a note.")
			.addText((text) =>
				text.setValue(profile.filters.neighbourhood?.root ?? "").onChange(async (value) => {
					const root = value.trim();
					profile.filters.neighbourhood = root === "" ? null : { root, hops: profile.filters.neighbourhood?.hops ?? 1 };
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Neighbourhood hops")
			.setDesc("How many link hops around that note are included (0 = the note only).")
			.addText((text) =>
				text.setValue(String(profile.filters.neighbourhood?.hops ?? 1)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (!Number.isFinite(parsed) || parsed < 0) return;
					if (profile.filters.neighbourhood) profile.filters.neighbourhood.hops = Math.min(6, parsed);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Maximum file size (MB)")
			.setDesc("Notes larger than this are skipped (0 = no limit).")
			.addText((text) =>
				text.setValue(String(profile.filters.maxFileMegabytes)).onChange(async (value) => {
					const parsed = Number.parseFloat(value);
					if (Number.isFinite(parsed) && parsed >= 0) {
						profile.filters.maxFileMegabytes = parsed;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(root)
			.setName("Skip empty notes")
			.addToggle((toggle) =>
				toggle.setValue(profile.filters.skipEmpty).onChange(async (value) => {
					profile.filters.skipEmpty = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Respect Obsidian's excluded files")
			.setDesc("Also skip the notes listed under Settings → Files & Links → Excluded files.")
			.addToggle((toggle) =>
				toggle.setValue(profile.filters.respectObsidianIgnore).onChange(async (value) => {
					profile.filters.respectObsidianIgnore = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Order")
			.addDropdown((dropdown) => {
				const options: [OrderBy, string][] = [
					["path", "Path"],
					["title", "Title"],
					["modified", "Last modified"],
					["created", "Created"],
					["words", "Length"],
					["centrality", "Most connected"],
					["frontmatter", "Frontmatter key"],
				];
				for (const [value, label] of options) dropdown.addOption(value, label);
				dropdown.setValue(profile.order.by).onChange(async (value) => {
					profile.order.by = value as OrderBy;
					await this.plugin.saveSettings();
				});
			})
			.addDropdown((dropdown) =>
				dropdown
					.addOption("asc", "Ascending")
					.addOption("desc", "Descending")
					.setValue(profile.order.direction)
					.onChange(async (value) => {
						profile.order.direction = value as "asc" | "desc";
						await this.plugin.saveSettings();
					}),
			)
			.addToggle((toggle) =>
				toggle
					.setTooltip("Group by folder")
					.setValue(profile.order.groupByFolder)
					.onChange(async (value) => {
						profile.order.groupByFolder = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	private renderCondensation(root: HTMLElement, profile: ExportProfile): void {
		root.createEl("h3", { text: "Condensation" });

		new Setting(root)
			.setName("Remove repeated boilerplate")
			.setDesc("Lines and template blocks that appear in several notes (headers, footers, templates) are removed.")
			.addToggle((toggle) =>
				toggle.setValue(profile.condensation.boilerplate.enabled).onChange(async (value) => {
					profile.condensation.boilerplate.enabled = value;
					await this.plugin.saveSettings();
				}),
			)
			.addText((text) => {
				text.inputEl.setAttribute("aria-label", "Minimum number of notes a line must appear in");
				text.inputEl.style.width = "3.5em";
				text.setValue(String(profile.condensation.boilerplate.minDocs)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (parsed >= 2) profile.condensation.boilerplate.minDocs = parsed;
					await this.plugin.saveSettings();
				});
			});

		new Setting(root)
			.setName("Duplicates")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("skip", "Drop duplicates")
					.addOption("collapse", "Drop, keep a pointer")
					.addOption("merge", "Merge unique lines into the kept note")
					.setValue(profile.condensation.dedupe.mode)
					.onChange(async (value) => {
						profile.condensation.dedupe.mode = value as "skip" | "collapse" | "merge";
						profile.condensation.dedupe.enabled = true;
						await this.plugin.saveSettings();
					}),
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.7, 0.99, 0.01)
					.setValue(profile.condensation.dedupe.threshold)
					.setDynamicTooltip()
					.onChange(async (value) => {
						profile.condensation.dedupe.threshold = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("Summarise long notes")
			.setDesc("Extractive summaries keep the most representative sentences when a note is too long for the budget.")
			.addToggle((toggle) =>
				toggle.setValue(profile.condensation.summarize.enabled).onChange(async (value) => {
					profile.condensation.summarize.enabled = value;
					await this.plugin.saveSettings();
				}),
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.1, 0.9, 0.05)
					.setValue(profile.condensation.summarize.ratio)
					.setDynamicTooltip()
					.onChange(async (value) => {
						profile.condensation.summarize.ratio = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("Drop near-empty notes")
			.setDesc("Notes with almost no prose (a link dump, a stub) add noise more than value.")
			.addToggle((toggle) =>
				toggle.setValue(profile.condensation.dropStubs.enabled).onChange(async (value) => {
					profile.condensation.dropStubs.enabled = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Inline transclusions")
			.setDesc("Replace `![[Other note]]` with the actual content of that note.")
			.addToggle((toggle) =>
				toggle
					.setValue(profile.condensation.inlineTransclusions)
					.onChange(async (value) => {
						profile.condensation.inlineTransclusions = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	private renderPackaging(root: HTMLElement, profile: ExportProfile): void {
		root.createEl("h3", { text: "Packaging" });

		new Setting(root)
			.setName("Format")
			.setDesc("Markdown for humans and most AI tools, JSON/JSONL/XML for pipelines.")
			.addDropdown((dropdown) => {
				const options: [ExportFormat, string][] = [
					["markdown", "Markdown"],
					["plain", "Plain text"],
					["json", "JSON"],
					["jsonl", "JSON Lines"],
					["xml", "XML"],
				];
				for (const [value, label] of options) dropdown.addOption(value, label);
				dropdown.setValue(profile.packaging.format).onChange(async (value) => {
					profile.packaging.format = value as ExportFormat;
					await this.plugin.saveSettings();
				});
			});

		new Setting(root)
			.setName("Split into parts")
			.setDesc("`none` keeps a single file; the other modes split to respect a limit.")
			.addDropdown((dropdown) => {
				const options: [ChunkMode, string][] = [
					["maxWords", "By words"],
					["maxTokens", "By tokens"],
					["maxChars", "By characters"],
					["single", "Single file"],
					["perNote", "One file per note"],
				];
				for (const [value, label] of options) dropdown.addOption(value, label);
				dropdown.setValue(profile.packaging.chunking.mode).onChange(async (value) => {
					profile.packaging.chunking.mode = value as ChunkMode;
					await this.plugin.saveSettings();
					this.display();
				});
			});

		const chunking = profile.packaging.chunking;
		if (chunking.mode === "maxWords") {
			new Setting(root).setName("Words per part").addText((text) =>
				text.setValue(String(chunking.maxWords)).onChange(async (value) => {
					chunking.maxWords = Math.max(100, Number.parseInt(value, 10) || chunking.maxWords);
					await this.plugin.saveSettings();
				}),
			);
		} else if (chunking.mode === "maxTokens") {
			new Setting(root).setName("Tokens per part").addText((text) =>
				text.setValue(String(chunking.maxTokens)).onChange(async (value) => {
					chunking.maxTokens = Math.max(200, Number.parseInt(value, 10) || chunking.maxTokens);
					await this.plugin.saveSettings();
				}),
			);
		} else if (chunking.mode === "maxChars") {
			new Setting(root).setName("Characters per part").addText((text) =>
				text.setValue(String(chunking.maxChars)).onChange(async (value) => {
					chunking.maxChars = Math.max(1_000, Number.parseInt(value, 10) || chunking.maxChars);
					await this.plugin.saveSettings();
				}),
			);
		}

		new Setting(root)
			.setName("Overlap")
			.setDesc("Tokens repeated at the start of the next part, so a chunk is never cut mid-idea.")
			.addText((text) =>
				text.setValue(String(chunking.overlapTokens)).onChange(async (value) => {
					chunking.overlapTokens = Math.max(0, Number.parseInt(value, 10) || 0);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Glossary")
			.setDesc("Harvest definition-style lines into a glossary at the end of the bundle.")
			.addToggle((toggle) =>
				toggle.setValue(profile.packaging.includeGlossary).onChange(async (value) => {
					profile.packaging.includeGlossary = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Manifest file")
			.setDesc("Write a `.manifest.json` next to the bundle: sources, hashes, statistics.")
			.addToggle((toggle) =>
				toggle.setValue(profile.packaging.manifestSidecar).onChange(async (value) => {
					profile.packaging.manifestSidecar = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Manifest in the bundle")
			.setDesc("Append the citation map and the statistics to the first part, for the model itself.")
			.addToggle((toggle) =>
				toggle.setValue(profile.packaging.manifestEmbedded).onChange(async (value) => {
					profile.packaging.manifestEmbedded = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Write an export report")
			.setDesc("A <bundle>.report.md next to the bundle: what was kept, left out and cleaned up, and why.")
			.addToggle((toggle) =>
				toggle.setValue(profile.packaging.reportFile).onChange(async (value) => {
					profile.packaging.reportFile = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Write custom instructions")
			.setDesc("A paste-ready prompt for the destination model: what the corpus is, how to cite it, what it can answer.")
			.addToggle((toggle) =>
				toggle.setValue(profile.packaging.instructionsFile).onChange(async (value) => {
					profile.packaging.instructionsFile = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Repeat the note header")
			.setDesc("Start every continuation part with the title of the note it continues.")
			.addToggle((toggle) =>
				toggle.setValue(profile.packaging.chunking.repeatHeader).onChange(async (value) => {
					profile.packaging.chunking.repeatHeader = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Add a missing note title")
			.setDesc("Notes without a heading get one, so a continuation part still says what it is about.")
			.addToggle((toggle) =>
				toggle.setValue(profile.transform.ensureTitle).onChange(async (value) => {
					profile.transform.ensureTitle = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Table of contents")
			.addToggle((toggle) =>
				toggle.setValue(profile.packaging.includeToc).onChange(async (value) => {
					profile.packaging.includeToc = value;
					await this.plugin.saveSettings();
				}),
			)
			.addToggle((toggle) =>
				toggle
					.setTooltip("Corpus map: themes, hubs, glossary, reading order")
					.setValue(profile.packaging.includeKnowledgeMap)
					.onChange(async (value) => {
						profile.packaging.includeKnowledgeMap = value;
						await this.plugin.saveSettings();
					}),
			)
			.addToggle((toggle) =>
				toggle
					.setTooltip("Citation ids (S01, S02…) in front of every note")
					.setValue(profile.packaging.citationIds)
					.onChange(async (value) => {
						profile.packaging.citationIds = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	private renderOutput(root: HTMLElement, profile: ExportProfile): void {
		root.createEl("h3", { text: "Output" });

		new Setting(root)
			.setName("Destination")
			.addDropdown((dropdown) => {
				const options: [OutputDestination, string][] = [
					["vault", "Vault folder"],
					["clipboard", "Clipboard"],
					["filesystem", "External folder (desktop)"],
				];
				for (const [value, label] of options) dropdown.addOption(value, label);
				dropdown.setValue(profile.output.destination).onChange(async (value) => {
					profile.output.destination = value as OutputDestination;
					await this.plugin.saveSettings();
				});
			});

		new Setting(root)
			.setName("Folder")
			.setDesc("Vault-relative, or an absolute path for the external destination.")
			.addText((text) =>
				text.setValue(profile.output.folder).onChange(async (value) => {
					profile.output.folder = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Mirror the folder structure")
			.setDesc("One note per file: recreate the vault's folders inside the export folder.")
			.addToggle((toggle) =>
				toggle.setValue(profile.output.mirrorFolders).onChange(async (value) => {
					profile.output.mirrorFolders = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("File name")
			.setDesc(
				"Variables: {{folder}}, {{profile}}, {{date:YYYY-MM-DD}}, {{part}}, {{total}} — and, for one note per file, {{note_path}}, {{note_folder}}, {{note_title}}, {{note_slug}}.",
			)
			.addText((text) =>
				text.setValue(profile.output.fileNameTemplate).onChange(async (value) => {
					profile.output.fileNameTemplate = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Incremental")
			.setDesc("Delta runs export only the notes that changed since the previous run of this profile.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("off", "Everything")
					.addOption("delta", "Only what changed")
					.setValue(profile.output.incremental)
					.onChange(async (value) => {
						profile.output.incremental = value as IncrementalMode;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("Also copy to the clipboard")
			.addToggle((toggle) =>
				toggle.setValue(profile.output.alsoCopyToClipboard).onChange(async (value) => {
					profile.output.alsoCopyToClipboard = value;
					await this.plugin.saveSettings();
				}),
			);
	}

	private renderLimits(root: HTMLElement, profile: ExportProfile): void {
		root.createEl("h3", { text: "Destination limits" });
		root.createEl("p", {
			cls: "cve-hint",
			text: "Hard caps of the tool you feed. The plugin reports a violation instead of silently producing a bundle that cannot be imported.",
		});

		new Setting(root)
			.setName("Preset")
			.addDropdown((dropdown) => {
				dropdown.addOption("unlimited", "No limits");
				for (const preset of LIMIT_PRESETS) dropdown.addOption(preset.id, preset.label);
				const current = LIMIT_PRESETS.find(
					(p) => p.limits.maxParts === profile.limits.maxParts && p.limits.maxWordsPerPart === profile.limits.maxWordsPerPart,
				);
				dropdown.setValue(current?.id ?? "unlimited").onChange(async (value) => {
					const preset = LIMIT_PRESETS.find((p) => p.id === value);
					profile.limits = value === "unlimited" || !preset ? { ...UNLIMITED } : { ...preset.limits };
					await this.plugin.saveSettings();
					this.display();
				});
			});

		const limits = profile.limits;
		if (limits.maxParts !== 0 || limits.maxWordsPerPart !== 0) {
			root.createEl("p", {
				cls: "cve-hint",
				text: `Max ${formatCount(limits.maxParts)} parts, ${formatCount(limits.maxWordsPerPart)} words per part, ${formatCount(
					limits.maxTokensPerPart,
				)} tokens per part.`,
			});
		}
		new Setting(root)
			.setName("Custom limits")
			.setDesc("0 disables a limit.")
			.addText((text) =>
				text
					.setValue(String(limits.maxParts))
					.setPlaceholder("parts")
					.onChange(async (value) => {
						limits.maxParts = Math.max(0, Number.parseInt(value, 10) || 0);
						await this.plugin.saveSettings();
					}),
			)
			.addText((text) =>
				text
					.setValue(String(limits.maxWordsPerPart))
					.setPlaceholder("words/part")
					.onChange(async (value) => {
						limits.maxWordsPerPart = Math.max(0, Number.parseInt(value, 10) || 0);
						await this.plugin.saveSettings();
					}),
			);
	}

	private renderHistory(root: HTMLElement): void {
		const history = this.settings.state.history.slice(-5).reverse();
		if (history.length === 0) return;
		root.createEl("h2", { text: "Recent exports" });
		for (const entry of history) {
			const profile = this.settings.profiles.find((p) => p.id === entry.profileId);
			root.createEl("div", {
				cls: "cve-history-line",
				text: `${new Date(entry.generatedAt).toLocaleString()} — ${profile?.name ?? entry.profileId} · ${
					entry.parts
				} part(s) · ${formatCount(entry.words)} words · ${formatCount(entry.tokens)} tokens${
					entry.durationMs > 0 ? ` · ${(entry.durationMs / 1000).toFixed(1)} s` : ""
				}`,
			});
		}
	}

	/* ------------------------------------------------------------------ */

	private profile(): ExportProfile | undefined {
		return this.settings.profiles.find((p) => p.id === this.selectedId) ?? this.settings.profiles[0];
	}
}

function splitList(value: string): string[] {
	return value
		.split(/[,\n]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

export function builtinProfileIds(): string[] {
	return BUILTIN_PROFILES.map((recipe) => recipe.id);
}

export const EMPTY_LIMITS: BundleLimits = UNLIMITED;
