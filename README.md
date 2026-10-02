# Condensated Vault Exporter

**Export whole folders of Obsidian notes into merged files that a language model can actually use** — token-budgeted parts, duplicates collapsed, boilerplate removed, summaries where they help, and provenance for every sentence.

You have 800 notes. NotebookLM accepts 50 sources and gives you no idea which note said what. A chat model accepts one file, and your folder is six times too big. `cat *.md` gives you 3 MB of frontmatter, repeated daily-note templates and five copies of the same meeting notes.

This plugin turns that folder into *the smallest bundle that still contains everything you meant* — and explains what it did.

```
Vault folder ──▶ discover ──▶ analyse ──▶ condense ──▶ budget ──▶ package ──▶ Exports/NotebookLM/…
                                             │                                    │
                       links · duplicates · boilerplate · themes            parts · map · manifest
```

## What makes it different from a concatenation

| | `cat`-style mergers | Condensated Vault Exporter |
|---|---|---|
| Size | Whatever comes out | Split to a word/token budget you choose, per destination |
| Duplicates | Kept | Detected (MinHash + containment) and skipped, collapsed or merged |
| Boilerplate | Kept | Templates that repeat across notes are removed — *only* when the digits don't carry meaning |
| Long notes | Kept whole | Extractive summaries, budget-aware trimming |
| Order | Alphabetical | Path, title, date, length, centrality or frontmatter — and the order is the priority when a cap applies |
| Navigation | None | Table of contents, corpus map, themes, hubs, glossary, suggested reading order |
| Traceability | None | Citation ids (`S01`), per-note metadata, `.manifest.json` with content hashes |
| Tuning | Settings soup | Profiles: one coherent recipe per destination |
| Safety | Silent | Live preview, warnings, destination limit checks, cancellation |

## Install

**Manual** (until the plugin is in the community list):

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Put them in `<vault>/.obsidian/plugins/condensated-vault-exporter/`.
3. Enable *Condensated Vault Exporter* in **Settings → Community plugins**.

**From source:**

```bash
git clone https://github.com/aznan-triks/condensated-vault-exporter
cd condensated-vault-exporter
npm install
npm run build          # typecheck + production bundle
cp main.js manifest.json styles.css <vault>/.obsidian/plugins/condensated-vault-exporter/
```

## Use it

- **Ribbon icon / `Ctrl-P` → “Open the export dialog”** — pick a profile, a folder and a destination, then *Preview* or *Export*.
- **`Ctrl-P` → “Export with the active profile”** — one keystroke, straight to the output folder.
- **Right-click a folder** → *Export as an AI-ready bundle…* — the folder is pre-filled.
- **`Ctrl-P` → “Copy the bundle to the clipboard”** — paste straight into a chat.

The preview shows the exact text, part by part, with the numbers behind the decisions: notes kept/dropped and why, duplicates found, boilerplate lines removed, tokens per part, and every warning the run produced.

## Profiles

A profile is a complete recipe — sources, filters, condensation, packaging, output and destination limits — not a pile of unrelated toggles. Built-ins are tunable; duplicate one to make it yours.

| Profile | For | What it does |
|---|---|---|
| **NotebookLM** | NotebookLM / Gemini Notebook | ≤450k words per part, ≤50 parts, corpus map, glossary, citation ids |
| **Chat context** | A long-context chat prompt | One file under a token budget, aggressive dedupe + summaries, copied to the clipboard |
| **RAG chunks** | Embedding pipelines | JSON Lines, ~1k-token chunks with overlap, metadata intact, no summaries |
| **Clean mirror** | A tidy export of the folder | One cleaned file per note: transclusions resolved, callouts unwrapped, dataview noise gone |
| **Full archive** | Backup / grep / hand-off | Everything, uncondensed, one file |
| **Study guide** | Learning a subject | Least-connected-but-central notes first, merged duplicates, glossary |

Everything editable in the settings tab: folders and globs, tag/date/word filters, ordering, what to strip or keep, dedupe mode and threshold, summarisation ratio, boilerplate rules, format (Markdown, plain, JSON, JSONL, XML), splitting, overlap, table of contents, corpus map, citation ids, output folder, file-name template, incremental mode, destination limits.

## How the condensation works

1. **Discover** — the vault is listed once and filtered (folders, globs, tags, dates, size, note cap, output-folder exclusion).
2. **Analyse (pass 1)** — every note is scanned once: headings, links, tags, word/token counts, a 32-slot MinHash signature over 8-word shingles, exact shingle hashes for short notes, and a bounded set of line identities.
3. **Condense** —
   - *Duplicates*: MinHash + LSH banding finds candidates; short notes are compared exactly. A note that is an **extract** of a longer one is caught by a containment estimate and an inverted index over shingle hashes, not only by similarity.
   - *Boilerplate*: a line is removed when its digit-free template repeats across at least *N* notes, or when it repeats verbatim. Lines whose digits carry meaning (`Score: 47`) survive.
   - *Stubs* and *empty notes* are dropped with a reason.
4. **Rank and budget** — the requested order is the priority; the token budget drops by value (centrality, signal, recency) and can summarise before dropping.
5. **Package** — parts are filled against the *effective* budget (part limit minus header, map and footer), splitting at headings, paragraphs, sentences or words, never inside a code fence, with optional overlap taken from whole blocks.
6. **Write** — parts, a `.manifest.json` with per-note hashes, and a `.index.md` when there are several parts. Incremental runs only include what changed.

### Volumes: when the corpus does not fit one source

NotebookLM accepts 50 sources per notebook; a 200-part RAG-style export cannot be
imported anywhere. When a destination caps the number of sources, the plugin groups
parts into **volumes** of at most that many:

```
Exports/NotebookLM/Vault - 2026-02-01 NotebookLM -v1-part-01.md … -v1-part-50.md
                      /Vault - 2026-02-01 NotebookLM -v2-part-51.md … -v2-part-73.md
                      /Vault - 2026-02-01 NotebookLM.index.md   ← import map
```

Each part says which volume it belongs to, the index lists the volumes, and the
manifest records the volume of every part.

### Performance

`npm run bench [notes]` runs the whole engine over a synthetic vault and prints
the phase breakdown. On a 5 000-note / 4 MB corpus, a full run (analysis,
deduplication, knowledge layer, rendering) takes a few seconds and peaks well
under 200 MB of heap: the analyzer never keeps note text, only bounded
structures. Two hot spots were found and fixed with the benchmark: MinHash used
to hash every shingle once per signature slot (now two hashes plus double
hashing), and unresolved links used to scan the whole vault each time (now a
`basename → path` index).

### Design constraints

- **Bounded memory**: the analysis of a note is a few hundred bytes (signature, shingle hashes, line identities) — never the text. A 20,000-note vault fits in a few tens of megabytes.
- **Two passes**: analysis is cached and reused; only the notes that make it into the bundle are read again for rendering.
- **`src/core` never imports Obsidian.** Everything is testable in plain Node; `src/obsidian` is the thin adapter (vault access, sinks, dialogs, settings).

## Architecture

```
src/
  main.ts                  plugin entry: commands, ribbon, status bar, folder menu
  core/
    pipeline.ts            the orchestrator: runExport()
    types.ts               domain model, options, profile
    profiles.ts            built-in recipes + defaults + normalisation
    tokens.ts glob.ts frontmatter.ts util.ts
    markdown/              fence-aware scanning, links, transforms (callouts, dataview, transclusions…)
    condense/              boilerplate, duplicates, extractive summaries
    intel/                 link graph, MinHash/LSH, similarity, key terms, knowledge map
    pack/                  chunking, budgets, limits, renderers
    state/                 manifest, delta computation, analysis cache
  obsidian/                vault/sink ports, settings model, runner, dialogs, settings tab
tests/                     core units, pipeline end-to-end, plugin layer
```

## Development

```bash
npm install
npm run dev        # esbuild watch → main.js
npm run typecheck  # strict TypeScript
npm run test       # vitest
npm run ci         # typecheck + tests + production build
```

The engine is covered by end-to-end tests that run the whole pipeline over a fake vault: filtering, ordering and caps; duplicate and boilerplate behaviour; chunk integrity (nothing lost, nothing repeated, limits respected); all five output formats; incremental exports; preview and cancellation; destination limit checks.

## Limitations

- Text only: images and PDFs are referenced, never inlined by default.
- Summaries are extractive (the most representative sentences), not abstractive — this keeps runs offline, deterministic and fast.
- The token estimator is a good heuristic (~4 characters per token), not a tokenizer per model.
- Cross-session persistence keeps the manifest and the delta fingerprints; the *analysis* cache lives for the session (it is rebuilt in a second or two per thousand notes).

## License

MIT — see [LICENSE](LICENSE).
