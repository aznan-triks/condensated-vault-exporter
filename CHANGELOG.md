# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
semantic versioning.

## [1.1.0] — 2026-10-02

### Added
- **Smart Query DSL & BM25F + Graph Spreading Activation (`src/core/intel/focus.ts`)**:
  - Quoted phrase matching (`"reciprocal rank fusion"`), prefix/stem matching (`rerank` ↔ `reranking`), and 2-character technical acronym support (`AI`, `ML`, `DB`, `UI`, `Go`, `TS`).
  - Inline query operators: `tag:x`, `-tag:y`, `#x`, `path:Folder/`, `-path:Archive/`, `title:Atlas`, `has:code`, `has:links`, `has:embeds`, `has:headings`, `-term` negation, and `hops:1` / `+links` graph expansion.
- **Contradiction & Temporal/Metric Drift Detector (`src/core/intel/contradictions.ts`)**:
  - Automatically detects conflicting numeric metrics (`Recall@10: 0.78` vs `0.86`, `chunk overlap = 80 tokens` vs `128 tokens`), status reversals (`enabled` vs `disabled`), and references to `deprecated`/`archived` notes across related notes, ordered chronologically (`older` → `newer`) in the Knowledge Map, AI Instructions, Export Report, and Vault Explorer.
- **Deep Graph Topology (`src/core/intel/graph.ts`, `src/core/intel/knowledgeMap.ts`)**:
  - HITS (`hubScore` and `authorityScore`) separating Maps of Content (`mocs`) from foundational authorities, folder-spanning `bridges`, **Phantom Concepts** (`phantoms`: missing notes cited across multiple notes), Note Title & Alias link resolution fallback, and Mermaid `graph LR` topology diagrams (`knowledgeMapToMermaid`).
- **Native Obsidian `.canvas` Ingestion & Offline Dataview DQL Materialization (`src/core/markdown/canvas.ts`, `src/core/markdown/dataview.ts`)**:
  - Parses `.canvas` JSON spatial boards into structured Markdown: resolves visual `group` containment, orders cards top-to-bottom/left-to-right, converts file cards into `[[wiki-links]]`, and renders directed `edges` under `## Connections`.
  - Evaluates ` ```dataview ` `LIST` and `TABLE [WITHOUT ID]` queries (`FROM`, `WHERE`, `SORT`, `LIMIT`) offline against the analysed corpus and materializes them into real Markdown lists and GFM tables before export.
- **Frontmatter Property Schema & Open Tasks/Questions Harvester (`src/core/intel/schema.ts`, `src/core/intel/tasks.ts`)**:
  - Automatically infers the YAML frontmatter property schema across bundled notes (keys, inferred types `string`/`number`/`boolean`/`date`/`list`, note counts, and top values).
  - Harvests and deduplicates unchecked/in-progress Markdown tasks (`- [ ]`, `- [/]`), `TODO`/`FIXME`/`BLOCKER`/`QUESTION` markers, and unanswered questions under `## Open questions` / `## Blockers` headings.
- **MMR Diversity-Aware Extractive Summarization (`src/core/condense/summarize.ts`)**:
  - Added Maximal Marginal Relevance (`method: "mmr"`) to balance sentence relevance against lexical/stem redundancy so summaries cover distinct facets of long notes.
- **Active Credential & PII Redaction (`src/core/intel/safety.ts`)**:
  - Expanded detection for Hugging Face tokens, Stripe keys, npm tokens, database connection URIs, and multi-line PEM private keys.
  - Added `redactSecretsInText` and `condensation.redactSecrets` (plus a **Copy redacted** button in `PreviewModal` and a toggle in `ExportDialog`) to scrub secrets in-place with `[REDACTED: …]` placeholders.
- **Interactive Self-Contained HTML Bundle (`format: "html"`) & `claude-xml` Profile**:
  - Standalone dark/light HTML reader bundle with instant client-side search across text, `#tags`, and `S01` citation IDs.
  - Built-in **Claude XML context** (`claude-xml`) profile tailored for 180k-token XML reasoning.
- **Vault Intelligence & Health Explorer (`VaultExplorerModal`) & Upgraded `PreviewModal`**:
  - New command `Explore vault intelligence, graph & health` with 4 interactive tabs (*Overview & schema*, *Graph & phantoms*, *Duplicates & boilerplate*, *Drift & open items*) and 1-click theme slice export.
  - `PreviewModal` now includes interactive view tabs (*Bundle*, *Pipeline funnel*, *Export report*, *AI instructions*).
  - Profile JSON export/import in `ExportSettingsTab`, and a headless Node CLI (`src/cli.ts`, `npm run cli`, supporting `--intel` and `--json`).

### Fixed
- Fixed exact duplicate classification bug in `src/core/condense/dedupe.ts` where `docs[member].hash` was compared against `docs[representative].file.path` instead of `.hash`, causing all exact duplicates to be labeled `"near"`.
- Fixed `orderSelection` in `src/core/pipeline.ts` where `order.by === "centrality"` sorted by word count instead of graph centrality, and `groupByFolder` only ran as a tie-breaker after `order.by`.
- Fixed phrase matching in `src/core/intel/focus.ts` where `heading.has(phrase)` checked a single-word `Set` for a multi-word space-separated string.
- Fixed `allocateBudget` in `src/core/pack/budget.ts` ignoring `maxWords` when `maxTokens` was `0`.
- Fixed cross-profile output ingestion in `selectCandidates` (`src/core/pipeline.ts`) when multiple profiles write to sibling `Exports/*` folders.
- Fixed `normalizeSettings` and `manifest.ts` throwing `TypeError` when `state.profiles` was `null` or `state.history` contained malformed entries.
- Replaced `window.prompt` in `ExportDialog` (unsupported in Electron/Obsidian desktop) with an inline numeric input and made dialog scope estimation profile-aware.

## [1.0.0] — 2026-02-01

First complete release.

### Added
- Export pipeline: discovery, analysis, condensation, budgeting, packaging, writing.
- Profiles: NotebookLM, chat context, RAG chunks, clean mirror, full archive, study guide.
- Duplicate detection with MinHash/LSH, exact comparison for short notes and
  containment detection for notes that are extracts of longer ones.
- Boilerplate removal with digit-free template matching, so `Day 1` / `Day 2`
  templates go away while `Score: 47` survives.
- Extractive summarisation, stub removal, budget-aware dropping and trimming.
- Knowledge map: corpus overview, folders, key terms, themes, hubs, orphans,
  broken links, duplicates, boilerplate report, glossary, suggested reading order.
- Formats: Markdown, plain text, JSON, JSON Lines, XML.
- Chunking modes: single, by words/tokens/characters, per note, per folder, with
  overlap and header repetition.
- Destination limit presets (NotebookLM, chat context, RAG, and more) with
  ❌/⚠️/ℹ️ violation reporting.
- Incremental (delta) exports, manifest sidecar with per-note hashes, index file
  for multi-part bundles.
- Obsidian UI: export dialog, preview modal, settings tab, ribbon icon, folder
  context menu, status bar progress, cancellation, clipboard destination.
- Honest budgets: candidates are read and transformed *before* the token
  budget is decided, so it works from the size the file will really have. The
  old model budgeted raw note sizes and charged a contents line for every
  *candidate*: on a 5 000-note vault "Chat context" reserved 151 k of overhead
  against a 150 k budget and exported a single note. It now keeps 858 notes in
  one part, 98 % of the budget used. The contents list is capped
  (`tocMaxEntries`, 300 by default) with an "…and N more notes" line, and the
  framing each note costs (heading, source line, divider, citation,
  embedded-manifest entry) is charged per included note.
- One file per note: per-note exports can be named after their note
  (`{{note_path}}`, `{{note_title}}`, `{{note_slug}}`) and mirror the vault's
  folder structure; nested output folders are created level by level, since
  Obsidian's `createFolder` is not recursive.
- "Show export status" command: one table listing every profile with its last
  export (parts, tokens, when), the notes in scope now and how many changed
  since — computed from the sidecars and the recorded state, so it costs a
  single file listing. Each row previews its profile in one click.
- Topic focus: a profile (or the export dialog) can take free text — “retrieval
  evaluation”, “kubernetes upgrades” — and export only the notes that match it
  best, ranked with the corpus TF-IDF plus title, tag, path and heading
  bonuses. The run says what it kept and warns when nothing matches.
- Credential scan: the exporter reads the parts it just assembled and warns
  (plus a redacted section at the top of the report) when they contain
  credential-shaped strings — API keys, tokens, private key blocks, JWTs — so
  a bundle is not uploaded to a cloud model with the vault's secrets in it.
- Bundles now cross-reference themselves: every note names the notes it
  links to and the notes that link back, by citation id, in Markdown, plain
  text, XML and JSON. A model reading the bundle can follow the graph instead
  of guessing. The report gained a "How the notes hang together" section
  (links, orphans, most-referenced notes).
- A token-budget cut on a large vault now names five dropped notes and counts
  the rest instead of emitting one warning per note.
- Budgets that fit the file they write: the per-note framing is measured by the
  renderer itself (heading, source line, divider, citation, JSONL keys) instead
  of a hand-maintained constant, and a summary is priced by the sentences it
  really keeps (a 28 % budget over six sentences keeps two, i.e. 33 %). On the
  5 000-note benchmark "Chat context" now fills its single 150 k-token part with
  829 notes instead of writing two parts.
- The documented example set now includes the machine-readable output:
  `npm run demo` also writes `docs/example-rag-*.jsonl` (three parts, one
  complete JSON record per line, each part with its own index and manifest).
- Machine formats survive a note bigger than a part: JSONL, JSON and XML split
  an oversized note into several *complete* records before serialising (same
  metadata, `chunk: {index, total}` / `chunk="1/6"`). Previously the chunker cut
  the rendered text, so a RAG export contained truncated JSON lines and an XML
  part opened `<document>` without closing it. JSONL units are also marked
  unsplittable, so nothing can cut a record in half again.
- Neighbourhood exports: right-click a note to export it together with
  everything it links to and everything that links back, 1 or 2 hops out. The
  link map is built before the analysis pass, so a small neighbourhood export
  stays cheap on a large vault. Also a profile setting
  (`filters.neighbourhood`).
- "Export every profile" command: one sweep over all profiles, sharing the
  analysis cache, skipping profiles whose scope has not changed, with a single
  summary notice.
- Per-note exports keep their companion files (sidecar manifest, index,
  instructions, report) at the root of the output folder, named after the
  profile, instead of borrowing the first note's path.
- Export report: every run produces a human-readable account of what it did —
  what was kept, what was left out and why, what was cleaned up, and how the
  result compares to the destination's limits. Written as `<bundle>.report.md`
  when the profile asks for it (on for NotebookLM and chat-context), always
  available from the preview dialog, and pointed at from the notice when notes
  were left behind.
- Speed: a 5 000-note vault exports ~2× faster than before this batch.
  Shingle signatures are built from word hashes instead of joined strings,
  token estimation compares code points instead of running a regex per
  character, Markdown stripping only runs the substitutions a line can match,
  and the render pass reuses the token count the budget already measured
  (analyze 1 272 ms → 796 ms on the 5 000-note profile benchmark).
- Attachment inventory: binary embeds (`![[diagram.png]]`, PDFs) are resolved
  against the vault and reported — the report ends with the files the bundle
  only points at, the instructions file tells the destination not to invent
  their content, and the sidecar records `attachments: {count, bytes}`.
- Hostile-vault hardening: a sentence shared by every note is no longer
  stripped as boilerplate when it is the note's whole body (a vault of copies
  used to export five headings and no prose), an export with nothing to write
  says so instead of finishing silently, and the report no longer prints an
  empty path for aggregate rows ("- `` — 3 notes excluded…").
- Repeated headings whose section still carries content are kept: removing
  "## Gratitude" while its `- coffee` item survived left orphaned bullets that
  read like corruption. Headings still go when everything below them was
  boilerplate too.
- Export diff: each run compares itself with the previous manifest (new,
  changed, removed, unchanged) and the preview, the notice and the sidecar
  report it. The sidecar now stores this run's hashes — it used to keep the
  previous run's, which made every later comparison look two exports old.
- Custom instructions: the NotebookLM and chat profiles emit a paste-ready
  `*.instructions.md` (corpus, citation scheme, answer rules, suggested
  questions) and a command copies it to the clipboard.
- Automatic refresh: one profile can keep its bundle up to date while you work,
  with a quiet period, a change fingerprint that skips unchanged runs, and the
  cached file metadata refreshed from Obsidian's live `stat` on every edit.
- Volumes: exports that exceed the destination's source cap are grouped into
  numbered volumes with an import map in the index file.
- Output quality: heading levels sit one level under the note title, collapsed
  duplicates are citable stubs, the glossary only keeps real definitions, the
  quality report only lists boilerplate the stripper really removed, blank lines
  survive (paragraph breaks are Markdown structure, not whitespace), and
  `npm run demo` regenerates the committed example bundle.
- Performance: `npm run bench`, a 2.5× faster analysis pass (MinHash by double
  hashing, 32-bit content hash) and link resolution by name index instead of a
  full vault scan per unresolved link.
