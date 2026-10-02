# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
semantic versioning.

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
