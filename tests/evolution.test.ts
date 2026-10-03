import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { detectDuplicates } from "../src/core/condense/dedupe";
import { summarize } from "../src/core/condense/summarize";
import { detectContradictions } from "../src/core/intel/contradictions";
import { parseFocusQuery, rankByFocus, stemWord } from "../src/core/intel/focus";
import { buildLinkGraph } from "../src/core/intel/graph";
import { buildKnowledgeMap, knowledgeMapToMarkdown, knowledgeMapToMermaid } from "../src/core/intel/knowledgeMap";
import { redactSecretsInText, scanForSecrets } from "../src/core/intel/safety";
import { buildThemes, buildRelatedIndex } from "../src/core/intel/similarity";
import { extractPropertySchema } from "../src/core/intel/schema";
import { extractOpenItems } from "../src/core/intel/tasks";
import { buildKeyTerms } from "../src/core/intel/terms";
import { analyzeDocument } from "../src/core/markdown/analyzer";
import { convertCanvasToMarkdown } from "../src/core/markdown/canvas";
import { evaluateDataviewQuery, materializeDataviewBlocks, parseDataviewQuery } from "../src/core/markdown/dataview";
import { allocateBudget } from "../src/core/pack/budget";
import { createBuiltinProfile, normalizeProfile } from "../src/core/profiles";
import { runExport } from "../src/core/pipeline";
import { runCli } from "../src/cli";
import { normalizeSettings } from "../src/obsidian/settings";
import { analyzeAll, fakeVault, makeFile, memorySink } from "./helpers";

describe("core bug fixes & architectural hardening", () => {
	it("classifies 100% identical notes as 'exact' duplicates rather than 'near'", () => {
		const body =
			"# Retrieval Architecture\n\nHybrid search combines lexical BM25 scoring with dense vector embeddings using reciprocal rank fusion across fifty passages.";
		const files = [
			makeFile("a.md", body),
			makeFile("b.md", body),
			makeFile("other.md", "# Unrelated\n\nCompletely different topic about sourdough bread fermentation times."),
		];
		const docs = analyzeAll(files);
		const outcome = detectDuplicates(docs, {
			enabled: true,
			mode: "collapse",
			threshold: 0.85,
			containmentThreshold: 0.93,
			minWords: 10,
		});
		expect(outcome.groups).toHaveLength(1);
		expect(outcome.groups[0].kind).toBe("exact");
	});

	it("orders notes by true PageRank centrality, signal density, and groups by folder first", async () => {
		const files = [
			makeFile(
				"z-folder/hub.md",
				"# Central Hub\n\nShort foundational concept note that every other note in the vault references.",
			),
			makeFile(
				"a-folder/verbose.md",
				`# Verbose Leaf\n\nSee [[Central Hub]]. ${"Lots of extra filler words in this leaf note. ".repeat(30)}`,
			),
			makeFile(
				"a-folder/caller.md",
				"# Second Caller\n\nAlso depends on [[Central Hub]] for its definitions and architecture.",
			),
		];
		const base = normalizeProfile({
			id: "test-order",
			name: "Test Order",
			order: { by: "centrality", direction: "desc", frontmatterKey: "order", groupByFolder: false, clusterSimilar: false },
			condensation: {
				dedupe: { enabled: false, mode: "skip", threshold: 0.9, containmentThreshold: 0.95, minWords: 40 },
				boilerplate: { enabled: false, minDocs: 3, minLength: 15, blocks: false, maxRemovalRatio: 0.5 },
				summarize: { enabled: false, method: "centroid", mode: "ratio", ratio: 0.4, sentences: 5, minWords: 200, keepHeadings: true },
				dropStubs: { enabled: false, maxWords: 5, linksOnly: true },
				inlineTransclusions: false,
			},
		});
		const sink = memorySink();
		const res = await runExport({ profile: base }, { vault: fakeVault(files), sink });
		const text = res.parts[0].content;
		// Central Hub has 2 incoming links and must be assigned S01 (before Verbose Leaf S02) despite having far fewer words.
		expect(text).toContain("## S01 · Central Hub");
		expect(text.indexOf("## S01 · Central Hub")).toBeLessThan(text.indexOf("Verbose Leaf\n\n> `a-folder/verbose.md`"));

		// When groupByFolder is true, a-folder notes should be grouped together before z-folder.
		const groupedProfile = normalizeProfile({
			...base,
			order: { ...base.order, groupByFolder: true },
		});
		const resGrouped = await runExport({ profile: groupedProfile }, { vault: fakeVault(files), sink: memorySink() });
		const groupedText = resGrouped.parts[0].content;
		expect(groupedText).toContain("## S01 · Verbose Leaf");
	});

	it("honours maxWords in allocateBudget even when maxTokens is 0", () => {
		const docs = [
			{ path: "a.md", tokens: 500, words: 400, sentences: 20, signal: 0.9 },
			{ path: "b.md", tokens: 500, words: 400, sentences: 20, signal: 0.8 },
			{ path: "c.md", tokens: 500, words: 400, sentences: 20, signal: 0.2 },
		];
		const plan = allocateBudget(docs, {
			maxTokens: 0,
			maxWords: 600,
			overheadTokens: 50,
			perNoteOverheadTokens: 10,
			perNoteOverheadCap: 100,
			perIncludedTokens: 20,
			minDocTokens: 60,
			summaryTokens: 150,
			summarizeRatio: 0.35,
			summarizeMinWords: 120,
			allowSummarize: true,
			allowDrop: true,
			allowTruncate: true,
		});
		// Cannot keep all 3 full notes (1200 words > 600 word cap).
		expect(plan.summarized.length + plan.dropped.length + plan.truncated.length).toBeGreaterThan(0);
	});

	it("sanitizes corrupted state.profiles and state.history in normalizeSettings", () => {
		const settings = normalizeSettings({
			version: 1,
			state: {
				version: 1,
				profiles: null,
				history: [null, { bad: true }, { profileId: "notebooklm", generatedAt: "2026-01-01T00:00:00Z", outputs: ["a.md", 123] }],
			},
		});
		expect(settings.state.profiles).toEqual({});
		expect(settings.state.history).toHaveLength(1);
		expect(settings.state.history[0].outputs).toEqual(["a.md"]);
	});
});

describe("smart query engine & BM25F + graph focus", () => {
	it("parses quoted phrases, tag/path/title/has operators, negations, 2-char terms and hops", () => {
		const parsed = parseFocusQuery(
			'"reciprocal rank fusion" AI tag:research -#draft path:Projects/ -folder:Archive title:Atlas has:code -has:tasks -pasta hops:2',
		);
		expect(parsed.phrases).toEqual(["reciprocal rank fusion"]);
		expect(parsed.terms).toContain("ai");
		expect(parsed.terms).toContain("reciprocal");
		expect(parsed.tagsAll).toEqual(["research"]);
		expect(parsed.tagsNone).toEqual(["draft"]);
		expect(parsed.pathsInclude).toEqual(["projects"]);
		expect(parsed.pathsExclude).toEqual(["archive"]);
		expect(parsed.titleInclude).toEqual(["atlas"]);
		expect(parsed.hasFlags.has("code")).toBe(true);
		expect(parsed.notHasFlags.has("tasks")).toBe(true);
		expect(parsed.excludedTerms).toEqual(["pasta"]);
		expect(parsed.hops).toBe(2);
		expect(stemWord("reranking")).toBe("rerank");
	});

	it("matches stems, phrases, structured directives, and expands graph hops", () => {
		const files = [
			makeFile(
				"Projects/reranking.md",
				"---\ntags: [research]\n---\n# Cross-Encoder Reranking\n\nWe evaluate reranking models on retrieval benchmarks.\n\n```python\nscore = model.predict(pairs)\n```\nSee [[Latency Budget]] for production constraints.",
			),
			makeFile(
				"Projects/latency.md",
				"---\ntags: [research]\n---\n# Latency Budget\n\nProduction p99 latency must stay below 45ms per query.",
			),
			makeFile(
				"Archive/draft.md",
				"---\ntags: [draft]\n---\n# Old Reranking Draft\n\nOutdated notes on reranking.",
			),
		];
		const docs = analyzeAll(files);
		const keyTerms = buildKeyTerms(docs);
		const graph = buildLinkGraph(docs);

		// Stem match (`rerank` matches `reranking`) + `-tag:draft` + `hops:1` (pulls in Latency Budget via link!)
		const outcome = rankByFocus(docs, keyTerms, "rerank -tag:draft hops:1", 5, { graph });
		expect(outcome.kept[0]).toBe("Projects/reranking.md");
		expect(outcome.kept).toContain("Projects/latency.md");
		expect(outcome.kept).not.toContain("Archive/draft.md");

		// Filter-only query (`has:code tag:research`)
		const codeOnly = rankByFocus(docs, keyTerms, "has:code tag:research", 5, { graph });
		expect(codeOnly.kept).toEqual(["Projects/reranking.md"]);
	});
});

describe("corpus intelligence: HITS, bridges, phantoms & contradiction detector", () => {
	it("computes HITS hub/authority scores, bridge notes, and phantom concepts", () => {
		const files = [
			makeFile(
				"MOC/index.md",
				"# Retrieval MOC\n\nIndex pointing to [[BM25]], [[Dense Embeddings]], [[Vector Index]], and [[Missing Spec]].",
			),
			makeFile(
				"Lexical/bm25.md",
				"# BM25\n\nFoundational lexical model. Links across to [[Dense Embeddings]] and [[Vector Index]].",
			),
			makeFile(
				"Dense/embeddings.md",
				"# Dense Embeddings\n\nBi-encoder vectors stored in [[Vector Index]].",
			),
		];
		const docs = analyzeAll(files);
		const graph = buildLinkGraph(docs);

		// MOC has highest hubScore; Dense Embeddings has highest authorityScore.
		expect(graph.mocs[0].path).toBe("MOC/index.md");
		expect(graph.nodes.get("Dense/embeddings.md")!.authorityScore).toBeGreaterThan(0);
		// Lexical/bm25.md bridges MOC, Lexical, and Dense folders.
		expect(graph.bridges.some((b) => b.path === "Lexical/bm25.md")).toBe(true);
		// [[Vector Index]] is cited by all 3 notes but does not exist!
		expect(graph.phantoms[0]).toEqual({
			target: "Vector Index",
			referencedBy: ["Dense/embeddings.md", "Lexical/bm25.md", "MOC/index.md"],
			count: 3,
		});
	});

	it("detects numeric metric drift, status reversals, and stale deprecated references", () => {
		const files = [
			makeFile(
				"Retrieval/v1-design.md",
				"---\nstatus: deprecated\n---\n# Retrieval v1\n\nRecall@10: 0.78\nchunk overlap = 80 tokens\nQuery expansion is enabled in production.",
				{ mtime: Date.parse("2026-01-10T00:00:00Z") },
			),
			makeFile(
				"Retrieval/v2-benchmark.md",
				"---\nstatus: active\n---\n# Retrieval v2\n\nSupersedes [[Retrieval v1]].\nRecall@10: 0.86\nchunk overlap = 128 tokens\nQuery expansion is disabled in production.",
				{ mtime: Date.parse("2026-03-15T00:00:00Z") },
			),
		];
		const docs = analyzeAll(files);
		const graph = buildLinkGraph(docs);
		const findings = detectContradictions(
			docs.map((d, i) => ({ analysis: d, body: files[i].content })),
			graph,
		);

		expect(findings.some((f) => f.kind === "metric-drift" && f.subject.includes("recall@10"))).toBe(true);
		expect(findings.some((f) => f.kind === "metric-drift" && f.subject.includes("overlap"))).toBe(true);
		expect(findings.some((f) => f.kind === "status-conflict" && f.subject.includes("expansion"))).toBe(true);
		expect(findings.some((f) => f.kind === "stale-reference")).toBe(true);

		// Verify knowledgeMap & Mermaid rendering include topology and drift.
		const related = buildRelatedIndex(docs, { topK: 4, minSimilarity: 0.1 });
		const map = buildKnowledgeMap({
			docs,
			graph,
			themes: buildThemes(docs, related, { minSimilarity: 0.2, minSize: 2, maxThemes: 4 }),
			keyTerms: buildKeyTerms(docs).byPath,
			duplicates: [],
			boilerplate: [],
			stats: { discovered: 2, kept: 2, words: 60, tokens: 80, charCount: 400 },
			roots: ["Retrieval"],
			generatedAt: new Date("2026-04-01T00:00:00Z"),
			profileName: "NotebookLM",
			glossary: [],
			contradictions: findings,
		});
		const md = knowledgeMapToMarkdown(map, { topologyDiagram: true });
		expect(md).toContain("### Temporal drift & conflicting figures");
		expect(md).toContain("0.78");
		expect(md).toContain("0.86");
		expect(knowledgeMapToMermaid(map)).toContain("graph LR");
	});
});

describe("Obsidian .canvas support, MMR summarization, active secret redaction & HTML/Claude bundles", () => {
	it("converts .canvas spatial boards into Markdown with groups, wiki-links and connections", async () => {
		const canvasJson = JSON.stringify({
			nodes: [
				{ id: "g1", type: "group", label: "Ingestion Pipeline", x: 0, y: 0, width: 500, height: 400 },
				{
					id: "n1",
					type: "text",
					text: "# Chunker\nSplits long markdown documents at heading boundaries while preserving code blocks and tables across parts.",
					x: 50,
					y: 50,
					width: 200,
					height: 100,
				},
				{ id: "n2", type: "file", file: "Notes/Embeddings.md", x: 600, y: 50, width: 200, height: 100 },
			],
			edges: [{ id: "e1", fromNode: "n1", toNode: "n2", label: "feeds into" }],
		});
		const md = convertCanvasToMarkdown(canvasJson, "Architecture.canvas");
		expect(md).toContain("## Ingestion Pipeline");
		expect(md).toContain("[[Notes/Embeddings.md]]");
		expect(md).toContain("feeds into");

		// Verify a vault with a .canvas file exports and resolves the canvas link!
		const files = [
			makeFile("Architecture.canvas", canvasJson),
			makeFile(
				"Notes/Embeddings.md",
				"# Embeddings\n\nDense vector representations computed by a bi-encoder model for fast approximate nearest-neighbour retrieval.",
			),
		];
		const profile = createBuiltinProfile("notebooklm")!;
		const res = await runExport({ profile }, { vault: fakeVault(files), sink: memorySink() });
		expect(res.stats.kept).toBe(2);
		expect(res.parts[0].content).toContain("Ingestion Pipeline");
	});

	it("summarizes long notes with MMR diversity selection", () => {
		const text = [
			"Reciprocal rank fusion combines rankings from multiple retrieval systems without score calibration.",
			"Reciprocal rank fusion merges ranked lists from several retrievers without needing score calibration.",
			"Cross-encoder rerankers score query-document pairs jointly using full self-attention layers.",
			"Evaluation uses nDCG@10 and Recall@100 over human-annotated relevance judgments.",
			"Production latency budgets cap reranking depth at twenty candidate passages per query.",
			"Quantization to int8 cuts memory bandwidth in half while preserving ninety-nine percent of recall.",
		].join(" ");
		const res = summarize(
			text,
			{
				enabled: true,
				method: "mmr",
				mode: "sentences",
				ratio: 0.5,
				sentences: 3,
				minWords: 20,
				keepHeadings: false,
			},
			{ headings: [], topTerms: ["fusion", "rerankers", "latency", "quantization"] },
		);
		expect(res.applied).toBe(true);
		expect(res.kept).toBe(3);
		// MMR should avoid picking both sentence 1 and sentence 2 (which are near-duplicates).
		expect(res.text).toContain("Reciprocal rank fusion combines");
		expect(res.text).not.toContain("merges ranked lists from several retrievers");
	});

	it("detects and actively redacts credentials in-place when redactSecrets is enabled", async () => {
		const secretNote = [
			"# Deployment Config",
			"",
			"OPENAI_KEY = sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
			"HF_TOKEN = hf_abcdefghijklmnopqrstuvwxyz1234567890",
			"DB_URL = postgres://admin:supersecretpass@db.internal.example.com:5432/prod",
			"-----BEGIN OPENSSH PRIVATE KEY-----",
			"b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
			"-----END OPENSSH PRIVATE KEY-----",
		].join("\n");

		const scan = scanForSecrets([{ index: 0, content: secretNote }]);
		expect(scan.findings.length).toBeGreaterThanOrEqual(4);

		const scrubbed = redactSecretsInText(secretNote);
		expect(scrubbed.redactedCount).toBeGreaterThanOrEqual(4);
		expect(scrubbed.text).not.toContain("supersecretpass");
		expect(scrubbed.text).not.toContain("b3BlbnNzaC1rZXktdjE");
		expect(scrubbed.text).toContain("[REDACTED:");

		// Full pipeline with redactSecrets: true
		const base = createBuiltinProfile("chat-context")!;
		const profile = normalizeProfile({
			...base,
			condensation: { ...base.condensation, redactSecrets: true },
		});
		const res = await runExport(
			{ profile },
			{ vault: fakeVault([makeFile("ops.md", secretNote)]), sink: memorySink() },
		);
		expect(res.parts[0].content).toContain("[REDACTED:");
		expect(res.parts[0].content).not.toContain("supersecretpass");
		expect(res.warnings.some((w) => w.includes("Redacted"))).toBe(true);
	});

	it("renders interactive standalone HTML bundles and Claude XML bundles", async () => {
		const files = [
			makeFile(
				"alpha.md",
				"# Alpha\n\nAlpha links to [[Beta]] and explains `code` blocks, token budgets, and corpus knowledge maps in detail for language models.",
			),
			makeFile(
				"beta.md",
				"# Beta\n\nBeta is referenced by Alpha and describes how reciprocal rank fusion combines lexical and dense retrieval signals.",
			),
		];
		const htmlProfile = normalizeProfile({
			...createBuiltinProfile("chat-context")!,
			packaging: {
				...createBuiltinProfile("chat-context")!.packaging,
				format: "html",
				includeToc: true,
				includeKnowledgeMap: true,
			},
		});
		const htmlSink = memorySink();
		const htmlRes = await runExport({ profile: htmlProfile }, { vault: fakeVault(files), sink: htmlSink });
		expect(htmlRes.parts[0].content).toContain("<!DOCTYPE html>");
		expect(htmlRes.parts[0].content).toContain('id="cve-search"');
		expect(htmlRes.parts[0].content).toContain('class="cve-doc"');
		expect(Array.from(htmlSink.written.keys()).some((k) => k.endsWith(".html"))).toBe(true);

		const claudeProfile = createBuiltinProfile("claude-xml")!;
		const claudeSink = memorySink();
		const claudeRes = await runExport({ profile: claudeProfile }, { vault: fakeVault(files), sink: claudeSink });
		expect(claudeRes.parts[0].content).toContain("<?xml version=\"1.0\"");
		expect(claudeRes.parts[0].content).toContain("<bundle");
		expect(Array.from(claudeSink.written.keys()).some((k) => k.startsWith("Exports/Claude/") && k.endsWith(".xml"))).toBe(
			true,
		);
	});

	it("runs the headless CLI against a filesystem directory", async () => {
		const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cve-cli-test-"));
		try {
			await fs.promises.writeFile(
				path.join(tmpDir, "note.md"),
				"# CLI Note\n\nTesting the headless command-line exporter with sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890.",
				"utf8",
			);
			const logs: string[] = [];
			const listRes = await runCli(["--list-profiles"], { log: (l) => logs.push(l), error: () => undefined });
			expect(listRes.exitCode).toBe(0);
			expect(logs.some((l) => l.includes("claude-xml"))).toBe(true);

			const exportLogs: string[] = [];
			const exportRes = await runCli([tmpDir, "--profile", "chat-context", "--redact", "--format", "html"], {
				log: (l) => exportLogs.push(l),
				error: () => undefined,
			});
			expect(exportRes.exitCode).toBe(0);
			expect(exportRes.result?.parts[0].content).toContain("<!DOCTYPE html>");
			expect(exportRes.result?.parts[0].content).toContain("[REDACTED:");

			const intelLogs: string[] = [];
			const intelRes = await runCli([tmpDir, "--intel", "--json"], {
				log: (l) => intelLogs.push(l),
				error: () => undefined,
			});
			expect(intelRes.exitCode).toBe(0);
			const parsedMap = JSON.parse(intelLogs.join("\n"));
			expect(parsedMap.overview.notes).toBe(1);
		} finally {
			await fs.promises.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("evaluates and materializes Dataview LIST and TABLE queries offline during export", async () => {
		const files = [
			makeFile(
				"projects/alpha.md",
				"---\nstatus: active\nowner: Alice\npriority: 1\ntags: [project, ml]\n---\n# Project Alpha\n\nBuilding the hybrid retrieval pipeline for production search.",
			),
			makeFile(
				"projects/beta.md",
				"---\nstatus: active\nowner: Bob\npriority: 2\ntags: [project, infra]\n---\n# Project Beta\n\nProvisioning GPU inference clusters and vector indexes.",
			),
			makeFile(
				"projects/gamma.md",
				"---\nstatus: archived\nowner: Carol\npriority: 3\ntags: [project]\n---\n# Project Gamma\n\nLegacy keyword search prototype from last year.",
			),
			makeFile(
				"index.md",
				[
					"# Engineering Dashboard",
					"",
					"Active projects across the team:",
					"",
					"```dataview",
					'TABLE status AS "Status", owner AS "Owner"',
					'FROM "projects" AND #project',
					'WHERE status = "active"',
					"SORT priority ASC",
					"```",
					"",
					"ML initiatives:",
					"",
					"```dataview",
					"LIST owner",
					"FROM #ml",
					"```",
				].join("\n"),
			),
		];

		const docs = analyzeAll(files);
		const rawQuery = 'TABLE status AS "Status", owner FROM "projects" WHERE status = "active" SORT priority ASC';
		const parsed = parseDataviewQuery(rawQuery);
		expect(parsed?.kind).toBe("table");
		const tableMd = evaluateDataviewQuery(rawQuery, docs);
		expect(tableMd).toContain("Project Alpha");
		expect(tableMd).toContain("Project Beta");
		expect(tableMd).not.toContain("Project Gamma");

		const materialized = materializeDataviewBlocks(files[3].content, docs);
		expect(materialized.materialized).toBe(2);
		expect(materialized.text).toContain("| Note | Status | Owner |");
		expect(materialized.text).toContain("Alice");
		expect(materialized.text).toContain("Bob");
		expect(materialized.text).not.toContain("Carol");

		// Full pipeline export: Dataview block is materialized instead of stripped empty!
		const profile = createBuiltinProfile("notebooklm")!;
		const res = await runExport({ profile }, { vault: fakeVault(files), sink: memorySink() });
		expect(res.parts[0].content).toContain("| Note | Status | Owner |");
		expect(res.parts[0].content).toContain("Project Alpha");
		expect(res.parts[0].content).toContain("Alice");
	});

	it("discovers the vault frontmatter property schema and harvests open tasks & questions", () => {
		const files = [
			makeFile(
				"roadmap.md",
				[
					"---",
					"status: active",
					"priority: 1",
					"due: 2026-11-15",
					"components: [retrieval, index]",
					"---",
					"# Q4 Roadmap",
					"",
					"- [ ] Implement hybrid ranker 🔥",
					"- [/] Benchmark BM25 tokenizer",
					"- [x] Initial repository setup",
					"",
					"## Open questions",
					"- Should we quantize embeddings to int8 or fp16?",
				].join("\n"),
			),
			makeFile(
				"design.md",
				[
					"---",
					"status: draft",
					"priority: 2",
					"due: 2026-12-01",
					"---",
					"# Ranker Design",
					"",
					"TODO: Validate reciprocal rank fusion k=60 constant.",
					"QUESTION: How should cold-start documents be weighted?",
				].join("\n"),
			),
		];

		const docs = analyzeAll(files);
		const schema = extractPropertySchema(docs);
		const byKey = new Map(schema.map((s) => [s.key, s]));
		expect(byKey.get("status")?.type).toBe("string");
		expect(byKey.get("status")?.notes).toBe(2);
		expect(byKey.get("priority")?.type).toBe("number");
		expect(byKey.get("due")?.type).toBe("date");
		expect(byKey.get("components")?.type).toBe("list");

		const openItems = extractOpenItems(
			files.map((f, idx) => ({ analysis: docs[idx], body: f.content })),
		);
		expect(openItems.tasks.length).toBe(3);
		expect(openItems.tasks[0].priority).toBe("high");
		expect(openItems.tasks.some((t) => t.text.includes("hybrid ranker"))).toBe(true);
		expect(openItems.tasks.some((t) => t.text.includes("reciprocal rank fusion"))).toBe(true);
		expect(openItems.questions.length).toBe(2);
		expect(openItems.questions.some((q) => q.text.includes("quantize embeddings"))).toBe(true);
	});
});
