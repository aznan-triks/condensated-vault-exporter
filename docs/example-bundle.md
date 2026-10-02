# Vault bundle

> **NotebookLM** · 13 notes · 649 words · ~885 tokens · generated 2026-01-20 12:00:00
> Source: (vault root)

## Contents

**Daily/** (3)

- `S01` 2026-01-15 — *45 words*
- `S02` 2026-01-16 — *47 words*
- `S03` 2026-01-17 — *29 words*

**Meetings/** (2)

- `S04` Standup 12 January — *40 words*
- `S13` 2026-01-19 standup — *0 words*

**MOCs/** (1)

- `S05` Retrieval MOC — *27 words*

**Notes/** (2)

- `S06` Embeddings cheat sheet — *48 words*
- `S07` Retrieval log — *58 words*

**Projects/** (3)

- `S08` Atlas evaluation — *57 words*
- `S09` Atlas ranking — *74 words*
- `S10` Atlas retrieval — *102 words*

**Reference/** (2)

- `S11` BM25 — *65 words*
- `S12` Reciprocal rank fusion — *57 words*

## Corpus overview

- **13** notes selected (out of 13 discovered) across 6 folders
- **697 words** ≈ **999 tokens** ≈ 3 min of reading
- Content last modified on **2026-01-20**
- Most used tags: `#project` (3), `#retrieval` (2), `#evaluation` (1)

### Where the content lives

- `Projects` — 3 notes, 239 words
- `Daily` — 3 notes, 143 words
- `Reference` — 2 notes, 126 words
- `Notes` — 2 notes, 111 words

### Key terms

**atlas** (5) · **bm25** (3) · **answers** (2) · **retrieval** (2) · **embeddings** (3) · **afternoon** (1) · **lists** (1) · **mrr** (1) · **quality** (1) · **questions** (1) · **coffee** (2) · **boundary** (2) · **content** (2) · **cases** (2) · **always** (1) · **atlas-pipeline** (1) · **batch** (1) · **controls** (1) · **annotated** (1) · **chunking** (1) · **rank** (1) · **recall** (1) · **answered** (1) · **back** (1) · **blockers** (1)

### Central notes (most referenced)

- Atlas ranking — `Projects/Atlas ranking.md` (2 incoming links)
- Atlas retrieval — `Projects/Atlas retrieval.md` (2 incoming links)
- Retrieval log — `Notes/Retrieval log.md` (1 incoming links)
- Embeddings cheat sheet — `Notes/Embeddings cheat sheet.md` (1 incoming links)
- Atlas evaluation — `Projects/Atlas evaluation.md` (1 incoming links)
- BM25 — `Reference/BM25.md` (1 incoming links)
- Reciprocal rank fusion — `Reference/Reciprocal rank fusion.md` (1 incoming links)

### Glossary

- **Atlas ranking** — Ranking is the part of Atlas that decides which passages the assistant actually sees.  `(Projects/Atlas ranking.md)`
- **Atlas retrieval** — Atlas is the retrieval layer of the second brain: it indexes every note, embeds paragraphs and serves the closest passages to the assistant.  `(Projects/Atlas retrieval.md)`
- **BM25** — BM25 is a bag-of-words ranking function.  `(Reference/BM25.md)`
- **Reciprocal rank fusion** — Reciprocal rank fusion combines several ranked lists without any score calibration: each document scores the sum of 1 / (k + rank) over the lists it appears in, with k typically 60.  `(Reference/Reciprocal rank fusion.md)`

### Suggested reading order

1. Atlas ranking — `Projects/Atlas ranking.md` (hub — linked from 2 notes)
2. Atlas retrieval — `Projects/Atlas retrieval.md` (hub — linked from 2 notes)
3. Retrieval log — `Notes/Retrieval log.md` (linked from another note)
4. Embeddings cheat sheet — `Notes/Embeddings cheat sheet.md` (linked from another note)
5. Atlas evaluation — `Projects/Atlas evaluation.md` (linked from another note)
6. BM25 — `Reference/BM25.md` (linked from another note)
7. Reciprocal rank fusion — `Reference/Reciprocal rank fusion.md` (high information density)
8. 2026-01-17 — `Daily/2026-01-17.md` (high information density)
9. Standup 12 January — `Meetings/2026-01-12 standup.md` (high information density)
10. 2026-01-16 — `Daily/2026-01-16.md` (high information density)
11. 2026-01-15 — `Daily/2026-01-15.md` (high information density)
12. Retrieval MOC — `MOCs/Retrieval MOC.md` (high information density)

### Quality report

- **1 duplicate group(s)** were collapsed to a single copy:
  - kept `Meetings/2026-01-12 standup.md` (subset, similarity 0.916) — removed 1 copy(ies)
- **4 unlinked notes** (no in/out links inside the selection)
- **Repeated lines** were removed as boilerplate, e.g. “- the quiet morning” (in 3 notes), “- \[ \] review the evaluation questions” (in 3 notes)

---

## S01 · 2026-01-15

> `Daily/2026-01-15.md` · 45 words · updated 2026-01-20

### Gratitude
- coffee

### Tasks
- [x] write the chunking test

### Log
Spent the morning on boundary cases: a chunk that ends mid-sentence loses the predicate, so the splitter now walks back to the last sentence end. In the afternoon I annotated twenty more questions for the suite.

---

## S02 · 2026-01-16

> `Daily/2026-01-16.md` · 47 words · updated 2026-01-20

### Gratitude
- coffee

### Tasks
- [x] write the chunking test

### Log
Read the retrieval literature on late interaction and sketched how a ColBERT-style scorer would fit into Atlas. It would mean storing token embeddings, which multiplies the index size by twenty: probably not worth it for a personal vault.

---

## S03 · 2026-01-17

> `Daily/2026-01-17.md` · 29 words · updated 2026-01-20

### Gratitude
- coffee

### Tasks

### Log
Tuned the fusion cut from ten to eight passages after noticing the ninth and tenth answers were noise. Recall unchanged, precision of the context up.

---

## S04 · Standup 12 January

> `Meetings/2026-01-12 standup.md` · 40 words · updated 2026-01-20

### Updates
- Atlas retrieval: the incremental index landed, full rebuild takes two minutes.
- Atlas ranking: fusion weights frozen at the current values.
- Atlas evaluation: the suite runs on fridays now.

### Blockers
The embedding service rate limits batch sizes above 64 paragraphs.

---

## S05 · Retrieval MOC

> `MOCs/Retrieval MOC.md` · 27 words · updated 2026-01-20 · 0 in / 6 out links · links: S10 Atlas retrieval, S09 Atlas ranking, S08 Atlas evaluation, S11 BM25, S12 Reciprocal rank fusion, S06 Embeddings cheat sheet

- Atlas retrieval
- Atlas ranking
- Atlas evaluation
- BM25
- Reciprocal rank fusion
- Embeddings cheat sheet

The map of content for everything retrieval: the project, the methods and the log.

---

## S06 · Embeddings cheat sheet

> `Notes/Embeddings cheat sheet.md` · 48 words · updated 2026-01-20 · 1 in / 0 out links · linked from: S05 Retrieval MOC

Norm is not similarity: always normalise before taking a dot product.

Dimension is a cost, not a quality knob: 768 is plenty for note-sized paragraphs.

Cache by content hash, never by path: renames are free, edits are not.

Negative samples matter more than the encoder for ranking quality.

---

## S07 · Retrieval log

> `Notes/Retrieval log.md` · 58 words · updated 2026-01-20 · 1 in / 0 out links · linked from: S08 Atlas evaluation

### 2026-01-09
Recall@10 0.82, MRR 0.61. Reranking with the logistic model added two points of MRR and nothing on recall.

### 2026-01-16
Recall@10 0.83, MRR 0.63. Chunk overlap raised from 80 to 120 tokens; the boundary cases improved.

### 2026-01-23
Recall@10 0.83, MRR 0.63. Nothing moved. Suspect the evaluation set is too small to show the next improvement.

---

## S08 · Atlas evaluation

> `Projects/Atlas evaluation.md` · 57 words · #evaluation #project · updated 2026-01-20 · 1 in / 1 out links · links: S07 Retrieval log · linked from: S05 Retrieval MOC

Evaluation is what keeps the retrieval work honest.

### Dataset
120 questions written against 60 notes, each with the passage that answers it.

### Metrics
Recall@10, mean reciprocal rank and the number of questions answered from the wrong note.

### Cadence
Every friday, a script runs the suite against the current index and appends the numbers to Retrieval log.

---

## S09 · Atlas ranking

> `Projects/Atlas ranking.md` · 74 words · #project #retrieval · updated 2026-01-20 · 2 in / 1 out links · links: S10 Atlas retrieval · linked from: S05 Retrieval MOC, S10 Atlas retrieval

Ranking is the part of Atlas that decides which passages the assistant actually sees.

### Lexical
BM25 over the tokenised paragraph. Cheap, robust, and it handles rare words well.

### Semantic
Cosine similarity over the cached embeddings. Handles paraphrases that BM25 misses.

### Fusion
Reciprocal rank fusion of the two lists, then a cut at ten passages. The fusion is deliberately simple: every attempt to learn weights has overfit on the small evaluation set. See Atlas retrieval.

---

## S10 · Atlas retrieval

> `Projects/Atlas retrieval.md` · 102 words · #project #retrieval · updated 2026-01-20 · 2 in / 1 out links · links: S09 Atlas ranking · linked from: S05 Retrieval MOC, S09 Atlas ranking

Atlas is the retrieval layer of the second brain: it indexes every note, embeds paragraphs and serves the closest passages to the assistant.

### Goals
- [x] index the vault incrementally
- [ ] add reranking on top of embeddings
- [ ] measure recall on the annotated set

### Design notes
Chunking happens on heading boundaries, 800 tokens with 120 tokens of overlap. Embeddings are cached by content hash so a rename never re-embeds a note. Ranking combines BM25 with cosine similarity; see Atlas ranking for the details.

### Architecture
![atlas-pipeline.png](Assets/atlas-pipeline.png)

### Open questions
Does the reranker need a cross-encoder, or is a small logistic model over lexical features enough?

---

## S11 · BM25

> `Reference/BM25.md` · 65 words · updated 2026-01-20 · 1 in / 0 out links · linked from: S05 Retrieval MOC

BM25 is a bag-of-words ranking function. It scores a document for a query by summing, over the query terms, the term frequency saturated by document length.

k1 controls term frequency saturation; b controls the length normalisation. Typical values are k1 = 1.2 and b = 0.75.

The saturation is what makes BM25 well behaved on short notes, where a word appearing twice is not twice as important.

---

## S12 · Reciprocal rank fusion

> `Reference/Reciprocal rank fusion.md` · 57 words · updated 2026-01-20 · 1 in / 0 out links · linked from: S05 Retrieval MOC

Reciprocal rank fusion combines several ranked lists without any score calibration: each document scores the sum of 1 / (k + rank) over the lists it appears in, with k typically 60.

It is the reason the lexical and the semantic rankings of Atlas can be combined without normalising their scores, which are not comparable in the first place.

---

## S13 · 2026-01-19 standup

> `Meetings/2026-01-19 standup.md` · 0 words · *duplicate of S04*

*Duplicate of S04 (S13) — content omitted (similarity 92 %).*

*Generated by Condensated Vault Exporter — 13 notes, 649 words, ~885 tokens.*