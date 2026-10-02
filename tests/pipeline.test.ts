import { describe, expect, it } from "vitest";
import { runExport } from "../src/core/pipeline";
import { createState, computeDelta, diffManifests, type ManifestFile } from "../src/core/state/manifest";
import { buildKnowledgeMap } from "../src/core/intel/knowledgeMap";
import { buildLinkGraph } from "../src/core/intel/graph";
import { buildRelatedIndex, buildThemes } from "../src/core/intel/similarity";
import { buildKeyTerms, extractGlossary } from "../src/core/intel/terms";
import { detectDuplicates } from "../src/core/condense/dedupe";
import { BoilerplateAccumulator, stripBoilerplate, normalizeLine } from "../src/core/condense/boilerplate";
import { summarize } from "../src/core/condense/summarize";
import { chunkUnits, type PackUnit } from "../src/core/pack/chunk";
import { allocateBudget } from "../src/core/pack/budget";
import { checkLimits } from "../src/core/pack/limits";
import { analyzeAll, fakeVault, makeFile, memorySink, testProfile, toSourceFile } from "./helpers";
import { analyzeDocument } from "../src/core/markdown/analyzer";
import { transformDocument, extractSection, extractBlock, normalizeForCompare, shapeOf } from "../src/core/markdown/transforms";
import { DEFAULT_TRANSFORM } from "../src/core/profiles";

function note(title: string, body: string, extra: string[] = []): string {
	return [`# ${title}`, "", body, ...extra].join("\n");
}

// A small but *realistic* vault: notes long enough for similarity,
// duplicate detection and boilerplate removal to be meaningful.
const longProse = (topic: string, extra: string) =>
	[
		`${topic} matters because retrieval quality decides whether an assistant answers from the right source.`,
		`A pipeline that ingests ${extra} should normalise the text before indexing it.`,
		`Chunking strategy, overlap and metadata all influence the final answer quality.`,
		`We measured recall and precision on a set of representative questions.`,
		`The experiment showed that small chunks with generous overlap performed best.`,
		`Follow-up work should look at reranking and at query expansion.`,
	].join(" ");

function buildFixtureVault() {
	const files = [
		makeFile(
			"projects/alpha.md",
			[
				"---",
				"tags: [project, alpha]",
				"---",
				"# Alpha project",
				"",
				"Alpha is about building a retrieval system. It uses [[projects/beta]] for storage.",
				"",
				longProse("Alpha", "documents and embeddings"),
				"",
				"## Goals",
				"- [x] define the scope",
				"- [ ] implement ingestion",
				"",
				"## Notes",
				"Boiling water is unrelated but this sentence adds length to the note for the token budget test.",
			].join("\n"),
		),
		makeFile(
			"projects/beta.md",
			"---\ntags: [project, beta]\n---\n# Beta project\n\nBeta stores documents and serves them back quickly. Related to [[projects/alpha]].\n\n" +
				longProse("Beta", "storage layers and backups") +
				"\n",
		),
		makeFile(
			"daily/2026-01-01.md",
			"# 2026-01-01\n\n## Gratitude\n\n- coffee\n\n## Tasks\n\n- [ ] ship\n\nReal content for the day: reviewed the alpha retrieval design and wrote notes.\n" +
				longProse("Monday", "the morning review") +
				"\n",
		),
		makeFile(
			"daily/2026-01-02.md",
			"# 2026-01-02\n\n## Gratitude\n\n- tea\n\n## Tasks\n\n- [x] ship\n\nReal content for the day: implemented the beta storage layer and tested it.\n" +
				longProse("Tuesday", "the storage layer") +
				"\n",
		),
		makeFile(
			"daily/2026-01-03.md",
			"# 2026-01-03\n\n## Gratitude\n\n- water\n\n## Tasks\n\n- [ ] rest\n\nReal content: wrote documentation about the ingestion pipeline today.\n" +
				longProse("Wednesday", "the ingestion pipeline") +
				"\n",
		),
		// A note that only exists as a copy of the first half of Alpha.
		makeFile(
			"archive/old-copy.md",
			"# Alpha project\n\nAlpha is about building a retrieval system. It uses [[projects/beta]] for storage.\n\n" +
				longProse("Alpha", "documents and embeddings") +
				"\n",
		),
		makeFile(".obsidian/workspace.json", "{}"),
		makeFile("empty.md", "# Empty\n"),
	];
	return fakeVault(files);
};

describe("transform pipeline", () => {
	it("rewrites wikilinks, unwraps callouts, cleans tasks and strips comments", async () => {
		const text = [
			"---",
			"tags: [x]",
			"---",
			"# Title",
			"",
			"See [[Other note|the other note]] and [[Folder/Deep]] plus ![[Image.png]].",
			"",
			"> [!warning] Careful",
			"> the quoted body stays",
			"",
			"- [ ] todo item",
			"- [x] done item",
			"",
			"<div>html block</div>",
			"<!-- hidden -->",
			"%%obsidian comment%%",
			"```dataview",
			"TABLE x FROM y",
			"```",
			"",
			"#tag one",
		].join("\n");
		const result = await transformDocument(
			text,
			{
				...DEFAULT_TRANSFORM,
				wikilinks: "label",
				embeds: "reference",
				taskHandling: "clear",
				tags: "hoist",
			},
			{ format: "markdown", path: "notes/a.md" },
		);
		expect(result.text).toContain("the other note");
		// Embeds in `reference` mode survive as links; wikilinks are labelled.
		expect(result.text).not.toContain("[[Other note");
		expect(result.text).not.toContain("[[Folder/Deep");
		expect(result.text).toContain("[[Image.png]]");
		expect(result.text).toContain("**Careful**");
		expect(result.text).toContain("- todo item");
		expect(result.text).not.toContain("[x]");
		expect(result.text).not.toContain("hidden");
		expect(result.text).not.toContain("obsidian comment");
		expect(result.text).not.toContain("TABLE x FROM y");
		expect(result.text).not.toContain("#tag");
		expect(result.inlineTags).toContain("tag");
		expect(result.stats.tasksRemoved).toBe(0);
	});

	it("keeps code fences intact and can collapse long blocks", async () => {
		const long = ["```ts", ...Array.from({ length: 80 }, (_, i) => `const v${i} = ${i};`), "```"].join("\n");
		const text = `# Title\n\n${long}\n\nafter`;
		const collapsed = await transformDocument(text, { ...DEFAULT_TRANSFORM, codeBlocks: "collapse" }, { format: "markdown", path: "a.md" });
		expect(collapsed.text).toContain("lines of code elided");
		expect(collapsed.text).toContain("after");

		const removed = await transformDocument(text, { ...DEFAULT_TRANSFORM, codeBlocks: "remove" }, { format: "markdown", path: "a.md" });
		expect(removed.text).not.toContain("```");
		expect(removed.text).not.toContain("const v0");
	});

	it("never rewrites links inside code fences", async () => {
		const text = "# T\n\n```\n[[NotALink]] #nottag\n```\n\n[[Real]]";
		const result = await transformDocument(text, { ...DEFAULT_TRANSFORM, wikilinks: "label" }, { format: "markdown", path: "a.md" });
		expect(result.text).toContain("[[NotALink]]");
		expect(result.text).toContain("Real");
	});

	it("inlines transcluded notes with depth limits", async () => {
		const files = [
			makeFile("a.md", "# A\n\n![[b]]\n"),
			makeFile("b.md", "# B\n\nB content here\n\n![[c]]\n"),
			makeFile("c.md", "# C\n\nC content here\n"),
		];
		const vault = fakeVault(files);
		const { createResolver } = await import("../src/core/pipeline");
		const resolver = createResolver({ vault, sink: memorySink() }, new Map(files.map((f) => [f.path, f.path])), files.map(toSourceFile));
		const result = await transformDocument(
			files[0].content,
			{ ...DEFAULT_TRANSFORM, embeds: "transclude" },
			{ format: "markdown", path: "a.md", resolver, transclusion: { depth: 2, maxChars: 5000 } },
		);
		expect(result.text).toContain("B content here");
		expect(result.text).toContain("C content here");
		expect(result.stats.transclusions).toBe(2);
		expect(result.text).toContain("transcluded from");
	});

	it("strips boilerplate lines and template blocks", async () => {
		const accumulator = new BoilerplateAccumulator({ enabled: true, minDocs: 2, minLength: 8, blocks: true, maxRemovalRatio: 1 });
		const files = Array.from({ length: 4 }, (_, i) =>
			makeFile(`d${i}.md`, `# Day ${i}\n\n## Gratitude\n\n## Tasks\n\nUnique content for day ${i} with enough words to count.\n`),
		);
		for (const file of files) {
			const analysis = analyzeDocument(toSourceFile(file), file.content);
			accumulator.addDocument(analysis);
		}
		const boiler = accumulator.finish();
		expect(boiler.hashes.size).toBeGreaterThan(0);
		const stripped = stripBoilerplate(files[0].content, boiler.hashes, { enabled: true, minDocs: 2, minLength: 8, blocks: true, maxRemovalRatio: 1 });
		expect(stripped.text).not.toContain("## Gratitude");
		expect(stripped.text).toContain("Unique content for day 0");
		expect(stripped.removedLines).toBeGreaterThan(0);
	});
});

describe("condensation", () => {
	it("finds exact and near duplicates and keeps the richest copy", () => {
		const shared = Array.from(
			{ length: 25 },
			(_, i) => `Paragraph ${i} explains how the retrieval pipeline stores documents, ranks candidates and returns passages.`,
		).join(" ");
		const files = [
			makeFile("v1.md", `# Note\n\n${shared}`),
			makeFile("v2.md", `# Note\n\n${shared}`),
			makeFile("near.md", `# Note\n\n${shared} An extra closing sentence that only this copy carries.`),
			makeFile("other.md", "# Other\n\nCompletely different content about cooking pasta and boiling water with salt and basil leaves."),
		];
		const docs = analyzeAll(files);
		const outcome = detectDuplicates(docs, { enabled: true, mode: "skip", threshold: 0.8, containmentThreshold: 0.95, minWords: 10 });
		expect(outcome.groups.length).toBe(1);
		// One member is only near-identical, so the group is reported as such.
		expect(outcome.groups[0].kind).toBe("near");
		expect(outcome.groups[0].duplicates.length).toBe(2);
		expect(outcome.duplicateOf.size).toBe(2);
		// The longest copy is kept as the representative.
		expect(outcome.groups[0].representative).toBe("near.md");
	});

	it("summarizes extractively while keeping the first sentence", () => {
		const text = [
			"The system architecture consists of three layers. The first layer stores raw documents in object storage.",
			"The second layer builds an index from those documents and keeps it in sync. The third layer answers queries",
			"by retrieving candidate passages and reranking them with a cross encoder. Cost is dominated by the reranker.",
			"Latency budget is two hundred milliseconds for the retrieval stage. Caching helps a lot in practice.",
		].join(" ");
		const result = summarize(
			text,
			{ enabled: true, method: "centroid", mode: "ratio", ratio: 0.4, sentences: 3, minWords: 10, keepHeadings: false },
			{ headings: [], topTerms: ["architecture", "layer", "index", "reranker"] },
		);
		expect(result.applied).toBe(true);
		expect(result.kept).toBeLessThan(result.total);
		expect(result.text.startsWith("The system architecture")).toBe(true);
	});

	it("builds related notes, themes and key terms", () => {
		const ml = Array.from({ length: 5 }, (_, i) =>
			makeFile(
				`ml/${i}.md`,
				`# Model ${i}\n\nGradient descent optimises the loss landscape of a neural network by following the slope of the error function. Backpropagation computes those gradients efficiently through the layers of the network. Momentum and adaptive learning rates make the optimisation converge faster in practice, and regularisation keeps the weights from growing without bound. ${"Extra prose ".repeat(20)}`,
			),
		);
		const cooking = Array.from({ length: 5 }, (_, i) =>
			makeFile(
				`cook/${i}.md`,
				`# Recipe ${i}\n\nBoiling salted water cooks pasta evenly, while basil and tomato finish the sauce with a fresh aroma. Olive oil and garlic form the base of many Mediterranean dishes, and parmesan adds depth to the final plate. ${"Extra prose ".repeat(20)}`,
			),
		);
		const docs = analyzeAll([...ml, ...cooking]);
		const related = buildRelatedIndex(docs, { topK: 3, minSimilarity: 0.3 });
		const neighbours = related.byPath.get("ml/0.md") ?? [];
		expect(neighbours.length).toBeGreaterThan(0);
		expect(neighbours.every((n) => n.path.startsWith("ml/"))).toBe(true);

		const themes = buildThemes(docs, related, { minSimilarity: 0.3, minSize: 3, maxThemes: 5 });
		expect(themes.length).toBeGreaterThanOrEqual(1);

		const terms = buildKeyTerms(docs);
		expect(terms.topTerms.length).toBeGreaterThan(0);
		expect(terms.byPath.get("cook/1.md")?.length).toBeGreaterThan(0);
	});
});

describe("packaging", () => {
	const unit = (id: string, words: number, origin = "a.md"): PackUnit => {
		const content = `${id} ${"word ".repeat(words)}`;
		return { origin, id, title: id, content, chars: content.length, tokens: words * 1.35, splittable: true };
	};

	it("packs units up to the token limit without splitting when avoidable", () => {
		const units = [unit("S1", 100), unit("S2", 100), unit("S3", 100)];
		const result = chunkUnits(units, { mode: "maxTokens", maxTokens: 250, maxChars: 0, maxWords: 0, overlapTokens: 0, splitAtLevel: 2, repeatHeader: true });
		expect(result.parts.length).toBeGreaterThan(1);
		for (const part of result.parts) expect(part.tokens).toBeLessThanOrEqual(350);
	});

	it("splits oversized units at headings and repeats headers", () => {
		const body = ["## Section A", "a ".repeat(400), "## Section B", "b ".repeat(400), "## Section C", "c ".repeat(400)].join("\n");
		const big: PackUnit = {
			origin: "big.md",
			id: "S1",
			title: "Big",
			content: body,
			chars: body.length,
			tokens: 1620,
			header: "# Big\n\n> header",
			splittable: true,
		};
		const result = chunkUnits([big], { mode: "maxTokens", maxTokens: 300, maxChars: 0, maxWords: 0, overlapTokens: 0, splitAtLevel: 2, repeatHeader: true });
		expect(result.parts.length).toBeGreaterThan(1);
		const all = result.parts.flatMap((p) => p.units.map((u) => u.content));
		expect(all.join("\n")).toContain("Section A");
		expect(all.join("\n")).toContain("Section C");
		expect(all.filter((c) => c.includes("# Big")).length).toBeGreaterThan(1);
	});

	it("respects per-note and per-folder modes", () => {
		const units = [unit("S1", 10, "f/a.md"), unit("S2", 10, "f/b.md"), unit("S3", 10, "g/c.md")];
		const perNote = chunkUnits(units, { mode: "perNote", maxTokens: 0, maxChars: 0, maxWords: 0, overlapTokens: 0, splitAtLevel: 2, repeatHeader: false });
		expect(perNote.parts).toHaveLength(3);
		const perFolder = chunkUnits(units, { mode: "perFolder", maxTokens: 0, maxChars: 0, maxWords: 0, overlapTokens: 0, splitAtLevel: 2, repeatHeader: false });
		expect(perFolder.parts).toHaveLength(2);
	});

	it("checks destination limits", () => {
		const violations = checkLimits(
			{ parts: 60, totalWords: 100, totalTokens: 130, maxPartWords: 10, maxPartTokens: 13, maxPartBytes: 100 },
			{ label: "Test tool", maxParts: 50, maxWordsPerPart: 0, maxTokensPerPart: 0, maxTotalWords: 0, maxTotalTokens: 0, maxMegabytesPerPart: 0 },
		);
		expect(violations.some((v) => v.severity === "error")).toBe(true);
	});

	it("allocates a budget by summarizing then dropping", () => {
		const files = Array.from({ length: 10 }, (_, i) =>
			makeFile(`n${i}.md`, `# Note ${i}\n\n${("content ".repeat(200))}${i}`),
		);
		const docs = analyzeAll(files);
		const total = docs.reduce((acc, d) => acc + d.stats.tokens, 0);
		const tight = allocateBudget(docs, {
			maxTokens: Math.round(total * 0.3),
			maxWords: 0,
			overheadTokens: 0,
			minDocTokens: 100,
			summaryTokens: 0,
			allowSummarize: true,
			allowDrop: true,
			allowTruncate: true,
		});
		expect(tight.totalTokens).toBeLessThanOrEqual(total * 0.35);
		expect(tight.dropped.length + tight.summarized.length).toBeGreaterThan(0);

		const impossible = allocateBudget(docs, {
			maxTokens: 200,
			maxWords: 0,
			overheadTokens: 0,
			minDocTokens: 20,
			summaryTokens: 0,
			allowSummarize: false,
			allowDrop: true,
			allowTruncate: true,
		});
		expect(impossible.decisions.size).toBeGreaterThan(0);
		const kept = Array.from(impossible.decisions.values()).filter((d) => d.action !== "drop");
		expect(kept.length).toBeGreaterThanOrEqual(1);
	});
});

describe("knowledge map", () => {
	it("summarises the corpus", () => {
		const files = [
			makeFile("index.md", "# Index\n\nSee [[Alpha]] and [[Beta]] for context. This index links everything together."),
			makeFile("alpha.md", "# Alpha\n\nAlpha is a concept defined as the first thing. It relates to [[Beta]]."),
			makeFile("beta.md", "# Beta\n\nBeta means the second thing, used together with alpha in many notes."),
			makeFile("orphan.md", "# Orphan\n\nNothing links here and it links nowhere; a lonely note about pasta."),
		];
		const docs = analyzeAll(files);
		const graph = buildLinkGraph(docs);
		const related = buildRelatedIndex(docs, { topK: 2, minSimilarity: 0.1 });
		const map = buildKnowledgeMap({
			docs,
			graph,
			themes: buildThemes(docs, related, { minSimilarity: 0.3, minSize: 2, maxThemes: 5 }),
			keyTerms: buildKeyTerms(docs).byPath,
			duplicates: [],
			boilerplate: [],
			stats: { discovered: 4, kept: 4, words: 100, tokens: 140, charCount: 600 },
			roots: [""],
			generatedAt: new Date("2026-02-01T00:00:00Z"),
			profileName: "Test",
			glossary: extractGlossary(docs.map((d) => ({ analysis: d, body: files.find((f) => f.path === d.file.path)!.content }))),
		});
		expect(map.overview.notes).toBe(4);
		expect(map.hubs.length).toBeGreaterThan(0);
		expect(graph.orphans.map((o) => o.path)).toContain("orphan.md");
		expect(map.glossary.length).toBeGreaterThan(0);
		expect(map.readingOrder.length).toBeGreaterThan(0);
	});
});

describe("manifest & delta", () => {
	it("computes what changed between runs", () => {
		const files = [makeFile("a.md", "# A\n\ncontent"), makeFile("b.md", "# B\n\ncontent")];
		const docs = analyzeAll(files);
		const state = createState();
		const delta1 = computeDelta(state, "p", docs);
		expect(delta1.changed).toHaveLength(2);
		const previous: ManifestFile = {
			version: 1,
			plugin: { id: "x", version: "1" },
			generatedAt: "",
			profile: { id: "p", name: "p" },
			roots: [],
			totals: { notes: 2, words: 0, tokens: 0, chars: 0, parts: 1, durationMs: 0 },
			hashes: { "a.md": docs[0].hash, "b.md": "different" },
			parts: [],
			options: { format: "markdown", chunking: "single", dedupe: false, boilerplate: false, summarize: false, limits: "" },
			notes_log: [],
		};
		const current: ManifestFile = { ...previous, hashes: { "a.md": docs[0].hash, "b.md": docs[1].hash, "c.md": "new" } };
		const delta = diffManifests(previous, current);
		expect(delta.changed).toEqual(["b.md"]);
		expect(delta.added).toEqual(["c.md"]);
	});
});

describe("end-to-end export", () => {


	it("produces a coherent bundle and writes the expected files", async () => {
		const vault = buildFixtureVault();
		const sink = memorySink();
		const state = createState();
		const profile = testProfile({
			targets: [],
			packaging: { ...testProfile().packaging, includeKnowledgeMap: true, includeToc: true, chunking: { ...testProfile().packaging.chunking, mode: "single", maxWords: 0 } } as never,
		});
		const result = await runExport(
			{ profile },
			{ vault, sink, state, now: () => Date.parse("2026-02-01T12:00:00Z"), pluginVersion: "test" },
		);

		expect(result.parts.length).toBe(1);
		const content = result.parts[0].content;
		expect(content).toContain("Alpha project");
		expect(content).toContain("Corpus overview");
		expect(content).toContain("Alpha is about building a retrieval system");
		// boilerplate shared by the three daily notes is removed
		expect(content).not.toContain("Gratitude");
		// the duplicate is not repeated: only a short provenance stub points to it
		const stubIndex = content.indexOf("`archive/old-copy.md`");
		expect(stubIndex).toBeGreaterThan(-1);
		expect(content.slice(stubIndex, stubIndex + 400)).toContain("Duplicate of S");
		// the kept note carries the body
		expect(content).toContain("Alpha is about building a retrieval system");
		// empty note dropped
		expect(result.stats.kept).toBeGreaterThanOrEqual(4);
		expect(result.stats.kept).toBeLessThanOrEqual(6);
		// files written: bundle + manifest
		expect(sink.written.size).toBeGreaterThanOrEqual(2);
		expect(Array.from(sink.written.keys()).some((k) => k.endsWith(".manifest.json"))).toBe(true);
		// state recorded
		expect(state.history.length).toBe(1);
		expect(Object.keys(state.profiles[profile.id]).length).toBeGreaterThan(0);
	});

	it("splits into parts that respect the configured limit", async () => {
		const vault = buildFixtureVault();
		const sink = memorySink();
		const profile = testProfile({
			packaging: {
				...testProfile().packaging,
				chunking: { mode: "maxTokens", maxTokens: 400, maxChars: 0, maxWords: 0, overlapTokens: 40, splitAtLevel: 2, repeatHeader: true },
			} as never,
		});
		const result = await runExport({ profile }, { vault, sink, now: () => Date.parse("2026-02-01T12:00:00Z") });
		expect(result.parts.length).toBeGreaterThan(1);
		for (const part of result.parts) {
			// The chunker measures the assembly overhead, so parts stay under the
			// configured limit even when the preamble is large.
			expect(part.tokens).toBeLessThan(400 * 1.35);
			expect(part.content).toContain("Part");
		}
		expect(result.written.length).toBeGreaterThan(1);
	});

	it("warns when the part size cannot hold the bundle overhead", async () => {
		const profile = testProfile({
			packaging: {
				...testProfile().packaging,
				chunking: { mode: "maxTokens", maxTokens: 60, maxChars: 0, maxWords: 0, overlapTokens: 0, splitAtLevel: 2, repeatHeader: true },
			} as never,
		});
		const result = await runExport({ profile }, { vault: buildFixtureVault(), sink: memorySink() });
		expect(result.warnings.some((w) => w.includes("smaller than what the bundle header"))).toBe(true);
	});

	it("writes JSONL with one document per line", async () => {
		const vault = buildFixtureVault();
		const sink = memorySink();
		const profile = testProfile({
			packaging: { ...testProfile().packaging, format: "jsonl", chunking: { mode: "single", maxChars: 0, maxTokens: 0, maxWords: 0, overlapTokens: 0, splitAtLevel: 2, repeatHeader: false }, includeToc: false, includeKnowledgeMap: false } as never,
		});
		const result = await runExport({ profile }, { vault, sink });
		const lines = result.parts[0].content.split("\n");
		expect(lines.length).toBeGreaterThan(3);
		const parsed = lines.map((line) => JSON.parse(line));
		expect(parsed[0].type).toBe("bundle");
		expect(parsed.some((entry) => entry.type === "document" || entry.content)).toBe(true);
	});

	it("supports incremental (delta) exports", async () => {
		const vault = buildFixtureVault();
		const profiles = testProfile({ output: { ...testProfile().output, incremental: "delta" } });
		const state = createState();
		const first = await runExport({ profile: profiles }, { vault, sink: memorySink(), state });
		expect(first.stats.kept).toBeGreaterThan(0);

		const second = await runExport({ profile: profiles }, { vault, sink: memorySink(), state });
		// Nothing changed: no note bodies are exported on the second run.
		expect(second.stats.kept).toBe(0);
	});

	it("honours filters, ordering and note caps", async () => {
		const vault = buildFixtureVault();
		const profile = testProfile({
			filters: { ...testProfile().filters, tagsAny: ["project"], maxNotes: 1 } as never,
			order: { ...testProfile().order, by: "title", direction: "desc" } as never,
			packaging: { ...testProfile().packaging, includeKnowledgeMap: false, includeToc: false } as never,
		});
		const result = await runExport({ profile }, { vault, sink: memorySink() });
		expect(result.stats.kept).toBe(1);
		expect(result.parts[0].content).toContain("Beta project");
		expect(result.parts[0].content).not.toContain("Alpha project");
	});

	it("can preview without writing anything", async () => {
		const vault = buildFixtureVault();
		const sink = memorySink();
		const result = await runExport({ profile: testProfile(), mode: "preview" }, { vault, sink });
		expect(result.parts.length).toBeGreaterThan(0);
		expect(sink.written.size).toBe(0);
	});

	it("supports cancellation", async () => {
		const vault = buildFixtureVault();
		const signal = {
			cancelled: false,
			throwIfCancelled() {
				if (this.cancelled) throw new Error("cancelled");
			},
			onCancel() {},
		};
		let ticks = 0;
		await expect(
			runExport(
				{ profile: testProfile() },
				{
					vault,
					sink: memorySink(),
					signal: signal as never,
					onProgress: () => {
						ticks++;
						if (ticks > 1) signal.cancelled = true;
					},
				},
			),
		).rejects.toThrow("cancelled");
	});
});

describe("transclusion helpers", () => {
	it("extracts sections and blocks", () => {
		const text = ["# Top", "intro", "## Section", "content here", "### Nested", "deeper", "## Next", "other"].join("\n");
		expect(extractSection(text, "Section")).toContain("content here");
		expect(extractSection(text, "Section")).toContain("deeper");
		expect(extractSection(text, "Next")).toBe("## Next\nother");
		expect(extractSection(text, "Missing")).toBeNull();
		expect(extractBlock("para one\nstill one ^abc\n\nnext para", "abc")).toContain("para one");
		expect(normalizeForCompare("Hello, World!")).toBe("hello world");
		expect(shapeOf("## H\n- item\n```\ncode\n```").codeLines).toBeGreaterThan(0);
	});

	it("normalizes lines consistently with the boilerplate hasher", () => {
		expect(normalizeLine("  ## Tasks  2026 ")).toBe(normalizeLine("## Tasks 2026"));
	});
});

/* -------------------------------------------------------------------------- */
/*  Packaging integrity                                                        */
/* -------------------------------------------------------------------------- */

describe("packaging integrity", () => {
	it("never loses or duplicates content when splitting into parts", async () => {
		const vault = buildFixtureVault();
		const profile = testProfile({
			packaging: {
				...testProfile().packaging,
				includeKnowledgeMap: false,
				includeToc: false,
				chunking: { mode: "maxTokens", maxTokens: 160, maxChars: 0, maxWords: 0, overlapTokens: 0, splitAtLevel: 2, repeatHeader: true },
			} as never,
		});
		const result = await runExport({ profile }, { vault, sink: memorySink() });
		expect(result.parts.length).toBeGreaterThan(1);
		const joined = result.parts.map((p) => p.content).join("\n");
		// Every note body must appear exactly once across the bundle.
		for (const needle of [
			"Alpha is about building a retrieval system",
			"Beta stores documents and serves them back quickly",
			"reviewed the alpha retrieval design",
		]) {
			expect(joined.split(needle).length - 1, needle).toBe(1);
		}
		// Every part stays inside the requested budget (with the documented slack).
		for (const part of result.parts) expect(part.tokens).toBeLessThanOrEqual(160 * 1.35);
	});

	it("reports the space the part structure occupies", async () => {
		const profile = testProfile({
			packaging: {
				...testProfile().packaging,
				chunking: { mode: "maxTokens", maxTokens: 500, maxChars: 0, maxWords: 0, overlapTokens: 40, splitAtLevel: 2, repeatHeader: true },
			} as never,
		});
		const result = await runExport({ profile }, { vault: buildFixtureVault(), sink: memorySink() });
		expect(result.chunking.partLimitTokens).toBe(500);
		expect(result.chunking.overheadTokens).toBeGreaterThan(0);
		expect(result.chunking.packLimitTokens).toBe(500 - result.chunking.overheadTokens);
		expect(result.chunking.units).toBeGreaterThan(1);
	});

	it("keeps notes whose digits carry meaning and strips real templates", async () => {
		const files = [
			makeFile("a.md", "# Day 1\n\n## Template\n\n- fixed line\n\nScore: 12 points today\n\nUnique alpha sentence about retrieval.\n"),
			makeFile("b.md", "# Day 2\n\n## Template\n\n- fixed line\n\nScore: 47 points today\n\nUnique beta sentence about storage.\n"),
			makeFile("c.md", "# Day 3\n\n## Template\n\n- fixed line\n\nScore: 91 points today\n\nUnique gamma sentence about indexing.\n"),
		];
		const profile = testProfile({
			packaging: { ...testProfile().packaging, includeKnowledgeMap: false, includeToc: false } as never,
		});
		const result = await runExport({ profile }, { vault: fakeVault(files), sink: memorySink() });
		const content = result.parts.map((p) => p.content).join("\n");
		expect(content).not.toContain("## Template");
		expect(content).not.toContain("- fixed line");
		// The varying numbers are content: all three scores survive.
		expect(content).toContain("Score: 12 points today");
		expect(content).toContain("Score: 47 points today");
		expect(content).toContain("Score: 91 points today");
	});

	it("detects a note that is an extract of a longer one", async () => {
		const long = [
			"Retrieval augmented generation combines a search index with a language model.",
			"The index returns candidate passages, the model writes an answer grounded in them.",
			"Chunk size, overlap and metadata decide how well the grounding works in practice.",
			"Evaluation should measure both answer quality and citation accuracy.",
		].join(" ");
		const files = [
			makeFile("guide.md", `# Guide\n\n${long}\n\n## Appendix\n\nExtra material that only exists in the full guide and nowhere else at all.\n`),
			makeFile("excerpt.md", `# Guide\n\n${long}\n`),
		];
		const profile = testProfile({ packaging: { ...testProfile().packaging, includeKnowledgeMap: false, includeToc: false } as never });
		const result = await runExport({ profile }, { vault: fakeVault(files), sink: memorySink() });
		expect(result.stats.droppedAsDuplicate).toBe(1);
		const content = result.parts.map((p) => p.content).join("\n");
		// The duplicate is represented by a short pointer, not by its body.
		expect(content.split("> `excerpt.md`").length - 1).toBe(1);
		expect(content).toContain("Duplicate of S");
		expect(content.split("Extra material that only exists in the full guide").length - 1).toBe(1);
	});
});
