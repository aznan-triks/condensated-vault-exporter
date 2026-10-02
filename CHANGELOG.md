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
