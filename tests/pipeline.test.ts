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
import { renderBundle } from "../src/core/pack/render";
import { normalizeProfile } from "../src/core/profiles";
import { allocateBudget, budgetItemsFromDocs } from "../src/core/pack/budget";
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
		const tight = allocateBudget(budgetItemsFromDocs(docs), {
			maxTokens: Math.round(total * 0.3),
			maxWords: 0,
			overheadTokens: 0,
			perNoteOverheadTokens: 0,
			perNoteOverheadCap: 0,
			perIncludedTokens: 0,
			summarizeRatio: 0.35,
			summarizeMinWords: 0,
			minDocTokens: 100,
			summaryTokens: 0,
			allowSummarize: true,
			allowDrop: true,
			allowTruncate: true,
		});
		expect(tight.totalTokens).toBeLessThanOrEqual(total * 0.35);
		expect(tight.dropped.length + tight.summarized.length).toBeGreaterThan(0);

		const impossible = allocateBudget(budgetItemsFromDocs(docs), {
			maxTokens: 200,
			maxWords: 0,
			overheadTokens: 0,
			perNoteOverheadTokens: 0,
			perNoteOverheadCap: 0,
			perIncludedTokens: 0,
			summarizeRatio: 0.35,
			summarizeMinWords: 0,
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
		// Repeated boilerplate lines go, but the repeated "## Gratitude" heading
		// stays: the item under it differs per note, and a bare "- coffee" with
		// nothing above it reads like a bug in the source.
		expect(content).toContain("## Gratitude");
		expect(content).toContain("- coffee");
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

describe("run hooks", () => {
	it("can abort before writing anything", async () => {
		const sink = memorySink();
		const result = runExport(
			{ profile: testProfile() },
			{ vault: buildFixtureVault(), sink, beforeWrite: () => false },
		);
		await expect(result).rejects.toThrow(/aborted/i);
		expect(sink.written.size).toBe(0);
	});

	it("skips the vault's own excluded files", async () => {
		const profile = testProfile({ packaging: { ...testProfile().packaging, includeKnowledgeMap: false, includeToc: false } as never });
		const withPattern = await runExport(
			{ profile },
			{ vault: buildFixtureVault(), sink: memorySink(), excludePatterns: ["daily/**"] },
		);
		expect(withPattern.stats.kept).toBeLessThan(5);
		const content = withPattern.parts.map((p) => p.content).join("\n");
		expect(content).not.toContain("Real content for the day");
	});

	it("passes the analysis concurrency through", async () => {
		let inFlight = 0;
		let peak = 0;
		const files = Array.from({ length: 12 }, (_, index) =>
			makeFile(`notes/n${index}.md`, `# Note ${index}\n\n${"word ".repeat(30)}\n`),
		);
		const vault = fakeVault(files);
		const original = vault.read.bind(vault);
		let reads = 0;
		vault.read = async (path: string) => {
			reads++;
			const analysisPass = reads <= files.length;
			inFlight++;
			if (analysisPass) peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			const text = await original(path);
			inFlight--;
			return text;
		};
		await runExport({ profile: testProfile() }, { vault, sink: memorySink(), concurrency: 2 });
		// The analysis pass honours the requested concurrency (rendering runs
		// afterwards with its own, smaller, budget).
		expect(peak).toBeLessThanOrEqual(2);
		expect(reads).toBeGreaterThan(files.length);
	});
});

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

	it("keeps lines whose digits carry meaning and strips repeated template lines", async () => {
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
		// The repeated "- fixed line" goes; the heading stays because the score
		// line and the sentence under it are unique to each note.
		expect(content).not.toContain("- fixed line");
		expect(content).toContain("## Template");
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

describe("volumes", () => {
	it("groups parts into source-sized volumes when the destination caps sources", async () => {
		const files = Array.from({ length: 12 }, (_, index) =>
			makeFile(
				`notes/n${String(index).padStart(2, "0")}.md`,
				`# Note ${index}\n\n${Array.from({ length: 12 }, (_, s) => `Paragraph ${s} of note ${index} about topic ${index % 3}.`).join(" ")}\n`,
			),
		);
		const profile = testProfile({
			limits: { ...testProfile().limits, maxParts: 3 },
			packaging: {
				...testProfile().packaging,
				includeKnowledgeMap: false,
				includeToc: false,
				chunking: { mode: "maxTokens", maxTokens: 120, maxChars: 0, maxWords: 0, overlapTokens: 0, splitAtLevel: 2, repeatHeader: true },
			} as never,
		});
		const sink = memorySink();
		const result = await runExport({ profile }, { vault: fakeVault(files), sink });
		expect(result.parts.length).toBeGreaterThan(3);
		expect(result.parts[0].volumeTotal).toBeGreaterThan(1);
		// Every volume respects the source cap.
		const perVolume = new Map<number, number>();
		for (const part of result.parts) perVolume.set(part.volume, (perVolume.get(part.volume) ?? 0) + 1);
		for (const [, count] of perVolume) expect(count).toBeLessThanOrEqual(3);
		// Files are named per volume and the notice says which volume it is.
		const paths = Array.from(sink.written.keys()).filter((path) => path.endsWith(".md"));
		expect(paths.some((path) => /-v2/.test(path))).toBe(true);
		expect(result.parts[3].content).toContain("volume 2 of");
		// The index explains how to import the volumes.
		const index = Array.from(sink.written.keys()).find((path) => path.endsWith(".index.md"));
		expect(index).toBeDefined();
		expect(sink.written.get(index!)).toContain("import one volume at a time");
		// And the run says what it did.
		expect(result.warnings.some((w) => /grouped into \d+ volumes/.test(w))).toBe(true);
		// The manifest records the volume of each part.
		expect(result.manifest.parts.some((part) => (part as { volume?: number }).volume === 2)).toBe(true);
	});

	it("keeps a single volume when there is no source cap", async () => {
		const result = await runExport(
			{ profile: testProfile() },
			{ vault: buildFixtureVault(), sink: memorySink() },
		);
		expect(result.parts.every((part) => part.volume === 1 && part.volumeTotal === 1)).toBe(true);
		expect(result.parts[0].content).not.toContain("volume 1 of 1");
	});
});

describe("options that used to be cosmetic", () => {
	it("repeats the note header when asked, and not when disabled", async () => {
		const long = `# Repeating note\n\n${Array.from({ length: 40 }, (_, i) => `Paragraph ${i} with enough words to matter for the splitter.`).join(" ")}\n`;
		const vault = fakeVault([makeFile("notes/long.md", long)]);
		const base = testProfile();
		const chunking = {
			...base.packaging.chunking,
			mode: "maxTokens" as const,
			maxTokens: 150,
			overlapTokens: 0,
			splitAtLevel: 1,
		};
		const withRepeat = await runExport(
			{ profile: testProfile({ packaging: { ...base.packaging, chunking, includeKnowledgeMap: false, includeToc: false } as never }) },
			{ vault, sink: memorySink() },
		);
		expect(withRepeat.parts.length).toBeGreaterThan(1);
		// Every continuation part is labelled with the note it belongs to.
		expect(withRepeat.parts[1].content).toContain("Repeating note");
		expect(withRepeat.parts[5].content).toContain("Repeating note");

		const withoutRepeat = await runExport(
			{
				profile: testProfile({
					packaging: {
						...base.packaging,
						chunking: { ...chunking, repeatHeader: false },
						includeKnowledgeMap: false,
						includeToc: false,
					} as never,
				}),
			},
			{ vault, sink: memorySink() },
		);
		expect(withoutRepeat.parts[1].content).not.toContain("Repeating note");
	});

	it("embeds the citation manifest in the first part when requested", async () => {
		const profile = testProfile({
			packaging: { ...testProfile().packaging, manifestEmbedded: true } as never,
		});
		const result = await runExport({ profile }, { vault: buildFixtureVault(), sink: memorySink() });
		expect(result.parts[0].content).toContain("<!-- bundle manifest -->");
		const json = result.parts[0].content.split("```json")[1].split("```")[0];
		const payload = JSON.parse(json);
		expect(payload.stats.kept).toBeGreaterThan(0);
		expect(Object.keys(payload.citation.sources).length).toBeGreaterThan(0);
		// The numbers in the part stay honest after the append.
		expect(result.parts[0].chars).toBe(result.parts[0].content.length);
	});

	it("keeps the note title between parts when the note has no heading", async () => {
		const files = [
			makeFile("notes/no-heading.md", "Body text only, with several sentences about the topic at hand.\n"),
		];
		const profile = testProfile({
			transform: { ...testProfile().transform, ensureTitle: true } as never,
			packaging: { ...testProfile().packaging, includeKnowledgeMap: false, includeToc: false } as never,
		});
		const result = await runExport({ profile }, { vault: fakeVault(files), sink: memorySink() });
		expect(result.parts[0].content).toContain("# no-heading");

		const off = await runExport(
			{
				profile: testProfile({
					transform: { ...testProfile().transform, ensureTitle: false } as never,
					packaging: { ...testProfile().packaging, includeKnowledgeMap: false, includeToc: false } as never,
				}),
			},
			{ vault: fakeVault(files), sink: memorySink() },
		);
		expect(off.parts[0].content).not.toContain("# no-heading");
	});

	it("can reference a transclusion instead of inlining it", async () => {
		const files = [
			makeFile(
				"notes/host.md",
				"# Host\n\nThe host note explains the retrieval design in enough words to pass the filter.\n\n![[notes/included]]\n\nContext after the embed with a few more words to be safe.\n",
			),
			makeFile(
				"notes/included.md",
				"# Included\n\nSecret body text that is long enough to survive the minimum word filter.\n",
			),
		];
		const inlined = await runExport(
			{
				profile: testProfile({
					packaging: { ...testProfile().packaging, includeKnowledgeMap: false, includeToc: false } as never,
				}),
			},
			{ vault: fakeVault(files), sink: memorySink() },
		);
		expect(inlined.parts[0].content).toContain("Secret body text");

		const referenced = await runExport(
			{
				profile: testProfile({
					condensation: { ...testProfile().condensation, inlineTransclusions: false } as never,
					packaging: { ...testProfile().packaging, includeKnowledgeMap: false, includeToc: false } as never,
				}),
			},
			{ vault: fakeVault(files), sink: memorySink() },
		);
		expect(referenced.parts[0].content).toContain("[[notes/included]]");
	});
});

describe("custom instructions", () => {
	it("writes a paste-ready instructions file next to the bundle", async () => {
		const profile = testProfile({
			packaging: { ...testProfile().packaging, instructionsFile: true } as never,
		});
		const sink = memorySink();
		void profile;
		const result = await runExport({ profile }, { vault: buildFixtureVault(), sink });
		const path = Array.from(sink.written.keys()).find((key) => key.endsWith(".instructions.md"));
		expect(path).toBeDefined();
		const text = sink.written.get(path!)!;
		expect(text).toContain("# Instructions for");
		expect(text).toContain("## How the bundle is organised");
		expect(text).toContain("## How to answer");
		expect(text).toContain("Cite the ids");
		expect(text).toContain("Useful questions to start with");
		// The instructions are part of the run's outputs.
		expect(result.written).toContain(path);
		// They stay inside the destination's field limit.
		expect(text.length).toBeLessThanOrEqual(10_000);
	});

	it("does not write instructions unless asked", async () => {
		const sink = memorySink();
		// The NotebookLM preset ships them on; every other profile defaults off.
		const profile = testProfile({
			packaging: { ...testProfile().packaging, instructionsFile: false } as never,
		});
		await runExport({ profile }, { vault: buildFixtureVault(), sink });
		expect(Array.from(sink.written.keys()).some((key) => key.endsWith(".instructions.md"))).toBe(false);
	});
});

describe("delta against the previous export", () => {
	it("compares the bundled notes with the previous manifest", async () => {
		const vault = buildFixtureVault();
		const previous = {
			hashes: {
				"projects/alpha.md": "stale-hash",
				"projects/beta.md": "stale-hash",
				"dropped/old.md": "stale-hash",
			},
		};
		const result = await runExport(
			{ profile: testProfile() },
			{ vault, sink: memorySink(), readPreviousManifest: async () => previous },
		);
		expect(result.delta?.known).toBe(true);
		// alpha and beta were both re-hashed, so both read as changed.
		expect(result.delta?.changed).toContain("projects/alpha.md");
		expect(result.delta?.changed).toContain("projects/beta.md");
		// A note the previous export knew and this one does not.
		expect(result.delta?.removed).toContain("dropped/old.md");
		expect(result.delta?.unchanged).toBe(0);
	});

	it("writes the diff into the manifest, with this run's hashes", async () => {
		const vault = buildFixtureVault();
		const sink = memorySink();
		await runExport(
			{ profile: testProfile() },
			{
				vault,
				sink,
				readPreviousManifest: async () => ({ hashes: { "projects/alpha.md": "stale-hash" } }),
			},
		);
		const manifestPath = Array.from(sink.written.keys()).find((path) => path.endsWith(".manifest.json"))!;
		const payload = JSON.parse(sink.written.get(manifestPath)!);
		expect(payload.previous.changed).toBeGreaterThan(0);
		expect(payload.previous.paths.changed).toContain("projects/alpha.md");
		// The hashes describe this run, not the previous one.
		expect(payload.hashes["projects/alpha.md"]).not.toBe("stale-hash");
		expect(payload.hashes["projects/alpha.md"]).toMatch(/^[0-9a-f]{32}$/);
	});

	it("reports nothing when there is no previous manifest", async () => {
		const result = await runExport({ profile: testProfile() }, { vault: buildFixtureVault(), sink: memorySink() });
		expect(result.delta).toBeUndefined();
	});
});

describe("per-note naming", () => {
	it("names each file after its note and keeps the vault folders", async () => {
		const profile = testProfile({
			output: {
				...testProfile().output,
				fileNameTemplate: "{{note_path}}",
				mirrorFolders: true,
			} as never,
			packaging: { ...testProfile().packaging, chunking: { ...testProfile().packaging.chunking, mode: "perNote" as const } } as never,
		});
		const sink = memorySink();
		const result = await runExport({ profile }, { vault: buildFixtureVault(), sink });
		const paths = result.parts.map((part) => part.path);
		expect(paths.some((path) => path.startsWith("Exports/") && path.includes("/"))).toBe(true);
		expect(paths.every((path) => path.startsWith("Exports/"))).toBe(true);
		// The note titles are the file names, with the source folder kept.
		expect(paths.some((path) => path.endsWith("daily/2026-01-01.md") || path.endsWith("2026-01-01.md"))).toBe(true);
	});

	it("falls back to the note title when only a title template is used", async () => {
		const profile = testProfile({
			output: { ...testProfile().output, fileNameTemplate: "{{note_title}}" } as never,
			packaging: { ...testProfile().packaging, chunking: { ...testProfile().packaging.chunking, mode: "perNote" as const } } as never,
		});
		const sink = memorySink();
		const result = await runExport({ profile }, { vault: buildFixtureVault(), sink });
		expect(result.parts.every((part) => part.path.startsWith("Exports/"))).toBe(true);
		expect(result.parts.every((part) => !part.path.includes("{{"))).toBe(true);
	});

	it("sanitizes a template that tries to escape the output folder", async () => {
		const profile = testProfile({
			output: { ...testProfile().output, fileNameTemplate: "../../{{note_title}}" } as never,
			packaging: { ...testProfile().packaging, chunking: { ...testProfile().packaging.chunking, mode: "perNote" as const } } as never,
		});
		const sink = memorySink();
		const result = await runExport({ profile }, { vault: buildFixtureVault(), sink });
		expect(result.parts.every((part) => !part.path.includes(".."))).toBe(true);
		expect(result.parts.every((part) => part.path.startsWith("Exports/"))).toBe(true);
	});
});

describe("budget vs. preamble overhead", () => {
	it("keeps a large corpus instead of budgeting itself out of existence", () => {
		// 1 500 notes of ~60 tokens: the corpus is well above a 150 k budget,
		// but the overhead charged per note must not scale with the *candidate*
		// count, or every note but one gets dropped.
		const docs = analyzeAll(
			Array.from({ length: 1500 }, (_, i) =>
				makeFile(`notes/n${i}.md`, `# Note ${i}\n\n${"lorem ipsum dolor sit amet consectetur ".repeat(6)}${i}`),
			),
		);
		const outcome = allocateBudget(budgetItemsFromDocs(docs), {
			maxTokens: 150_000,
			maxWords: 0,
			overheadTokens: 1_300,
			perNoteOverheadTokens: 18,
			perNoteOverheadCap: 300,
			perIncludedTokens: 20,
			summarizeRatio: 0.35,
			summarizeMinWords: 0,
			minDocTokens: 300,
			summaryTokens: 0,
			allowSummarize: false,
			allowDrop: true,
			allowTruncate: true,
		});
		const kept = Array.from(outcome.decisions.values()).filter((d) => d.action !== "drop");
		expect(kept.length).toBe(1500);
	});

	it("charges a contents line per kept note when the budget is tight", () => {
		const docs = analyzeAll(
			Array.from({ length: 40 }, (_, i) => makeFile(`n${i}.md`, `# Note ${i}\n\n${"content words here ".repeat(50)}`)),
		);
		const perNote = 30;
		const outcome = allocateBudget(budgetItemsFromDocs(docs), {
			maxTokens: 6_000,
			maxWords: 0,
			overheadTokens: 500,
			perNoteOverheadTokens: perNote,
			perNoteOverheadCap: 0,
			perIncludedTokens: 0,
			summarizeRatio: 0.35,
			summarizeMinWords: 0,
			minDocTokens: 200,
			summaryTokens: 0,
			allowSummarize: false,
			allowDrop: true,
			allowTruncate: false,
		});
		const kept = Array.from(outcome.decisions.values()).filter((d) => d.action !== "drop");
		const noteTokens = kept.reduce((acc, d) => acc + d.allowance, 0);
		expect(noteTokens + perNote * kept.length + 500).toBeLessThanOrEqual(6_000);
		expect(kept.length).toBeGreaterThan(0);
		expect(kept.length).toBeLessThan(docs.length);
	});
});

describe("contents list cap", () => {
	it("lists the corpus and counts the rest when the cap is hit", () => {
		const notes = Array.from({ length: 12 }, (_, i) => ({
			id: `S${String(i + 1).padStart(2, "0")}`,
			path: `f/n${i}.md`,
			title: `Note ${i}`,
			body: `## Note ${i}\n\nBody.`,
			tags: [],
			aliases: [],
			frontmatter: {},
			words: 40,
			tokens: 6,
			chars: 20,
			modified: Date.parse("2026-01-15T10:00:00Z"),
			created: Date.parse("2026-01-15T10:00:00Z"),
			related: [],
			inbound: 0,
			outbound: 0,
			summaryApplied: false,
		}));
		const bundle = renderBundle(notes, {
			format: "markdown",
			profileName: "Test",
			bundleTitle: "Test",
			includeToc: true,
			tocMaxDepth: 3,
			tocMaxEntries: 5,
			includeKnowledgeMap: false,
			citationIds: true,
			headerTemplate: "",
			footerTemplate: "",
			divider: "",
			noteHeadingLevel: 2,
			includeManifest: false,
			repeatHeaders: true,
			generatedAt: new Date(Date.parse("2026-01-20T12:00:00Z")),
			roots: [],
			stats: {
				discovered: 12,
				kept: 12,
				droppedByFilter: 0,
				droppedAsDuplicate: 0,
				droppedAsStub: 0,
				droppedAsUnreadable: 0,
				words: 1,
				tokens: 1,
				chars: 1,
				boilerplateLines: 0,
				summarized: 0,
			},
		});
		const toc = bundle.units.find((unit) => unit.role === "preamble")?.content ?? "";
		expect(toc).toContain("Note 0");
		expect(toc).not.toContain("Note 11");
		expect(toc).toContain("7 more notes");
	});

	it("caps the contents list in a real export", async () => {
		const files = Array.from({ length: 40 }, (_, i) => makeFile(`n${i}.md`, `# Note ${i}\n\n${"body text ".repeat(30)}`));
		const profile = testProfile({ packaging: { tocMaxEntries: 10, includeToc: true } });
		const sink = memorySink();
		const result = await runExport({ profile }, { vault: fakeVault(files), sink });
		const first = result.parts[0].content;
		const contents = first.slice(first.indexOf("## Contents"), first.indexOf("## Contents") + 4_000);
		expect(contents).toContain("more notes");
		expect(contents).not.toContain("Note 39");
	});
});

describe("realized-size budgeting", () => {
	it("fills the budget of a single-part profile instead of dropping most notes", async () => {
		const files = Array.from({ length: 1200 }, (_, i) =>
			makeFile(
				`${i % 4 === 0 ? "daily" : "notes"}/n${i}.md`,
				`---\ntags: [t${i % 3}]\n---\n# Note ${i}\n\n${"A sentence about retrieval and ranking with numbers like 42. ".repeat(12)}`,
			),
		);
		const profile = normalizeProfile({ id: "chat-context" });
		const sink = memorySink();
		const result = await runExport({ profile }, { vault: fakeVault(files), sink });
		expect(result.stats.kept).toBeGreaterThan(300); // the old model kept ~15 of 1200
		expect(result.parts.length).toBe(1);
		const limit = profile.limits.maxTokensPerPart;
		expect(result.parts[0].tokens).toBeLessThanOrEqual(limit);
		// And not far below it either: a budget that leaves half the room empty
		// is a budget that threw content away for nothing.
		expect(result.parts[0].tokens).toBeGreaterThan(limit * 0.6);
	});
});

describe("boilerplate headings", () => {
	it("keeps a repeated heading when its section still has content", async () => {
		const accumulator = new BoilerplateAccumulator({ enabled: true, minDocs: 3, minLength: 8, blocks: true, maxRemovalRatio: 1 });
		const files = [
			makeFile("d0.md", "# Day 0\n\n## Gratitude\n- coffee\n- the quiet morning\n\nUnique content for day 0 with enough words.\n"),
			makeFile("d1.md", "# Day 1\n\n## Gratitude\n- tea\n- the quiet morning\n\nUnique content for day 1 with enough words.\n"),
			makeFile("d2.md", "# Day 2\n\n## Gratitude\n- water\n- the quiet morning\n\nUnique content for day 2 with enough words.\n"),
			makeFile("d3.md", "# Day 3\n\n## Gratitude\n- water\n- the quiet morning\n\nUnique content for day 3 with enough words.\n"),
			makeFile("d4.md", "# Day 4\n\n## Gratitude\n- the quiet morning\n\n## Log\nUnique content for day 4 with enough words.\n"),
		];
		for (const file of files) accumulator.addDocument(analyzeDocument(toSourceFile(file), file.content));
		const boiler = accumulator.finish();
		const options = { enabled: true, minDocs: 3, minLength: 8, blocks: true, maxRemovalRatio: 1 };
		const stripped = stripBoilerplate(files[0].content, boiler.hashes, options as never);
		// "the quiet morning" repeats in every note and goes; "## Gratitude" is
		// repeated too, but it must stay to introduce the surviving "- coffee".
		expect(stripped.text).not.toContain("the quiet morning");
		expect(stripped.text).toContain("## Gratitude");
		expect(stripped.text).toContain("- coffee");

		// When everything under the heading repeats, the heading goes with it.
		const emptied = stripBoilerplate(files[4].content, boiler.hashes, options as never);
		expect(emptied.text).not.toContain("## Gratitude");
	});
});

describe("export report", () => {
	it("always reports what happened, and says why notes were left out", async () => {
		const files = [
			...Array.from({ length: 6 }, (_, i) =>
				makeFile(
					`d${i}.md`,
					`# Day ${i}\n\n## Gratitude\n- coffee\n- the quiet morning\n\n## Log\nUnique content for day ${i} that is long enough to survive the filters.\n`,
				),
			),
		];
		const profile = testProfile({
			filters: { ...testProfile().filters, maxNotes: 4 },
		} as never);
		const result = await runExport({ profile }, { vault: fakeVault(files), sink: memorySink() });
		const report = result.report ?? "";
		expect(report).toContain("# Export report");
		expect(report).toContain("## What was exported");
		expect(report).toContain("## What was left out");
		expect(report).toContain("excluded by the profile's filters or note cap");
		expect(report).toContain("## What was cleaned up");
		expect(report).toContain("boilerplate");
		expect(report).toContain("## Destination checks");
	});

	it("writes the report next to the bundle when the profile asks for it", async () => {
		const files = Array.from({ length: 3 }, (_, i) => makeFile(`n${i}.md`, `# Note ${i}\n\n${"Body text ".repeat(20)}`));
		const profile = testProfile({ packaging: { reportFile: true } });
		const sink = memorySink();
		const result = await runExport({ profile }, { vault: fakeVault(files), sink });
		const reportPath = [...sink.written.keys()].find((path) => path.endsWith(".report.md"));
		expect(reportPath).toBeDefined();
		expect(sink.written.get(reportPath!)).toContain("# Export report");
		expect(result.written).toContain(reportPath);
	});

	it("names the duplicate groups it skipped", async () => {
		const shared = Array.from(
			{ length: 30 },
			(_, i) => `Paragraph ${i} explains how the retrieval pipeline stores documents, ranks candidates and returns passages.`,
		).join(" ");
		const files = [makeFile("copy-a.md", `# Copy A\n\n${shared}`), makeFile("copy-b.md", `# Copy B\n\n${shared}`)];
		const result = await runExport({ profile: testProfile() }, { vault: fakeVault(files), sink: memorySink() });
		const report = result.report ?? "";
		expect(report).toContain("Duplicate of");
		expect(report).toContain("copy-b.md");
	});
});
