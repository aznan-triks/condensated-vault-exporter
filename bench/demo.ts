/**
 * Documentation example generator: `npm run demo`.
 *
 * A small but realistic second-brain vault (projects, notes, meetings, dailies,
 * reference notes) run through the real engine, so the committed example is
 * always exactly what the plugin would produce.
 */
import { runExport } from "/home/user/condensated-vault-exporter/src/core/pipeline.ts";
import { createDefaultProfiles } from "/home/user/condensated-vault-exporter/src/core/profiles.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const N = (name, content) => ({ path: name, content });
const notes = [
	N("Projects/Atlas retrieval.md", `---
tags: [project, retrieval]
status: active
---
# Atlas retrieval

Atlas is the retrieval layer of the second brain: it indexes every note, embeds paragraphs and serves the closest passages to the assistant.

## Goals
- [x] index the vault incrementally
- [ ] add reranking on top of embeddings
- [ ] measure recall on the annotated set

## Design notes
Chunking happens on heading boundaries, 800 tokens with 120 tokens of overlap. Embeddings are cached by content hash so a rename never re-embeds a note. Ranking combines BM25 with cosine similarity; see [[Projects/Atlas ranking]] for the details.

## Open questions
Does the reranker need a cross-encoder, or is a small logistic model over lexical features enough?`),
	N("Projects/Atlas ranking.md", `---
tags: [project, retrieval]
---
# Atlas ranking

Ranking is the part of Atlas that decides which passages the assistant actually sees.

## Lexical
BM25 over the tokenised paragraph. Cheap, robust, and it handles rare words well.

## Semantic
Cosine similarity over the cached embeddings. Handles paraphrases that BM25 misses.

## Fusion
Reciprocal rank fusion of the two lists, then a cut at ten passages. The fusion is deliberately simple: every attempt to learn weights has overfit on the small evaluation set. See [[Projects/Atlas retrieval]].`),
	N("Projects/Atlas evaluation.md", `---
tags: [project, evaluation]
---
# Atlas evaluation

Evaluation is what keeps the retrieval work honest.

## Dataset
120 questions written against 60 notes, each with the passage that answers it.

## Metrics
Recall@10, mean reciprocal rank and the number of questions answered from the wrong note.

## Cadence
Every friday, a script runs the suite against the current index and appends the numbers to [[Notes/Retrieval log]].`),
	N("Notes/Retrieval log.md", `# Retrieval log

## 2026-01-09
Recall@10 0.82, MRR 0.61. Reranking with the logistic model added two points of MRR and nothing on recall.

## 2026-01-16
Recall@10 0.83, MRR 0.63. Chunk overlap raised from 80 to 120 tokens; the boundary cases improved.

## 2026-01-23
Recall@10 0.83, MRR 0.63. Nothing moved. Suspect the evaluation set is too small to show the next improvement.`),
	N("Notes/Embeddings cheat sheet.md", `# Embeddings cheat sheet

Norm is not similarity: always normalise before taking a dot product.

Dimension is a cost, not a quality knob: 768 is plenty for note-sized paragraphs.

Cache by content hash, never by path: renames are free, edits are not.

Negative samples matter more than the encoder for ranking quality.`),
	N("Meetings/2026-01-12 standup.md", `# Standup 12 January

## Updates
- Atlas retrieval: the incremental index landed, full rebuild takes two minutes.
- Atlas ranking: fusion weights frozen at the current values.
- Atlas evaluation: the suite runs on fridays now.

## Blockers
The embedding service rate limits batch sizes above 64 paragraphs.`),
	N("Meetings/2026-01-19 standup.md", `# Standup 19 January

## Updates
- Atlas retrieval: the incremental index landed, full rebuild takes two minutes.
- Atlas ranking: fusion weights frozen at the current values.
- Atlas evaluation: the suite runs on fridays now.

## Blockers
The embedding service rate limits batch sizes above 64 paragraphs.`),
	N("Daily/2026-01-15.md", `# 2026-01-15

## Gratitude
- coffee
- the quiet morning

## Tasks
- [x] write the chunking test
- [ ] review the evaluation questions

## Log
Spent the morning on boundary cases: a chunk that ends mid-sentence loses the predicate, so the splitter now walks back to the last sentence end. In the afternoon I annotated twenty more questions for the suite.`),
	N("Daily/2026-01-16.md", `# 2026-01-16

## Gratitude
- coffee
- the quiet morning

## Tasks
- [x] write the chunking test
- [ ] review the evaluation questions

## Log
Read the retrieval literature on late interaction and sketched how a ColBERT-style scorer would fit into Atlas. It would mean storing token embeddings, which multiplies the index size by twenty: probably not worth it for a personal vault.`),
	N("Daily/2026-01-17.md", `# 2026-01-17

## Gratitude
- coffee
- the quiet morning

## Tasks
- [ ] review the evaluation questions

## Log
Tuned the fusion cut from ten to eight passages after noticing the ninth and tenth answers were noise. Recall unchanged, precision of the context up.`),
	N("Reference/BM25.md", `# BM25

BM25 is a bag-of-words ranking function. It scores a document for a query by summing, over the query terms, the term frequency saturated by document length.

k1 controls term frequency saturation; b controls the length normalisation. Typical values are k1 = 1.2 and b = 0.75.

The saturation is what makes BM25 well behaved on short notes, where a word appearing twice is not twice as important.`),
	N("Reference/Reciprocal rank fusion.md", `# Reciprocal rank fusion

Reciprocal rank fusion combines several ranked lists without any score calibration: each document scores the sum of 1 / (k + rank) over the lists it appears in, with k typically 60.

It is the reason the lexical and the semantic rankings of Atlas can be combined without normalising their scores, which are not comparable in the first place.`),
	N("MOCs/Retrieval MOC.md", `# Retrieval MOC

- [[Projects/Atlas retrieval]]
- [[Projects/Atlas ranking]]
- [[Projects/Atlas evaluation]]
- [[Reference/BM25]]
- [[Reference/Reciprocal rank fusion]]
- [[Notes/Embeddings cheat sheet]]

The map of content for everything retrieval: the project, the methods and the log.`),
];
const files = new Map(notes.map(n => [n.path, n.content]));
const vault = {
	async listFiles() { return notes.map(n => ({ path: n.path, name: n.path, folder: n.path.split("/").slice(0,-1).join("/"), ext: "md", size: n.content.length, mtime: Date.parse("2026-01-20T10:00:00Z"), ctime: Date.parse("2026-01-01T10:00:00Z") })); },
	async read(p) { const c = files.get(p); if (c === undefined) throw new Error("missing " + p); return c; },
};
/**
 * Writes the documentation example: the NotebookLM bundle of a small demo
 * vault, so the README can show what the plugin actually produces.
 */
const targets: Record<string, string> = {
	notebooklm: "docs/example-bundle.md",
	"chat-context": "docs/example-chat-context.md",
};
mkdirSync("docs", { recursive: true });
for (const id of Object.keys(targets)) {
	const profile = createDefaultProfiles().find((p) => p.id === id)!;
	const result = await runExport(
		{ profile },
		{
			vault,
			now: () => Date.parse("2026-01-20T12:00:00Z"),
			sink: {
				async write(path, content) {
					// The sidecar manifest goes next to the bundle, not into it.
					const file = path.endsWith(".instructions.md")
						? targets[id].replace(/\.md$/, ".instructions.md")
						: path.endsWith(".manifest.json")
						? targets[id].replace(/\.md$/, ".manifest.json")
						: targets[id];
					mkdirSync(dirname(file), { recursive: true });
					writeFileSync(file, content);
					return path;
				},
			},
		},
	);
	console.log(`${targets[id]}: ${result.stats.kept} notes, ${result.parts.length} part(s)`);
	if (result.warnings.length > 0) console.log("  warnings:", result.warnings.join(" · "));
}
