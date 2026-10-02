/**
 * The export pipeline: the single place where discovery, analysis,
 * condensation, packaging and persistence are orchestrated.
 *
 * Everything here works through the small ports declared in `types.ts`
 * (`VaultPort`, `SinkPort`), so the whole engine runs headless in tests and
 * could be reused by a CLI or a server without Obsidian.
 */

import {
	ExportCancelledError,
	type CancelSignal,
	type DocAnalysis,
	type ExportDelta,
	type ExportManifest,
	ExportProfile,
	ExportResult,
	FrontmatterValue,
	PlanStats,
	ProgressReporter,
	type SourceFile,
	type VaultPort,
	type SinkPort,
} from "./types";
import { ExportAbortedError } from "./types";
import { hash32 } from "./util";
import {
	applyTemplate,
	basename,
	formatCount,
	joinPath,
	mapLimit,
	naturalCompare,
	normalizeVaultPath,
	parentFolder,
	sanitizeFileName,
	slugify,
	stripExtension,
	unique,
} from "./util";
import { estimateTokens } from "./tokens";
import { hasPositivePattern, matchAny } from "./glob";
import { analyzeDocument } from "./markdown/analyzer";
import { buildNameIndex, resolveLinkTarget } from "./markdown/links";
import { countWords } from "./markdown/syntax";
import {
	transformDocument,
	type ContentResolver,
	type TransformStats,
} from "./markdown/transforms";
import { BoilerplateAccumulator, lineHasDigits, normalizeLine, stripBoilerplate } from "./condense/boilerplate";
import { detectDuplicates, type DedupeOutcome } from "./condense/dedupe";
import { summarize } from "./condense/summarize";
import { buildRelatedIndex, buildThemes, type RelatedIndex } from "./intel/similarity";
import { buildLinkGraph, type LinkGraph } from "./intel/graph";
import { buildKnowledgeMap, type KnowledgeMap } from "./intel/knowledgeMap";
import { buildInstructions } from "./pack/instructions";
import { buildExportReport, type ReportEntry } from "./pack/report";
import { buildKeyTerms, collectTerms, extractGlossary, rankTerms } from "./intel/terms";
import { allocateBudget, scoreDocuments, type BudgetDecision } from "./pack/budget";
import { chunkUnits, type PackUnit } from "./pack/chunk";
import { renderBundle, assemblePart, type RenderOptions, type RenderedNote } from "./pack/render";
import { checkLimits, type LimitViolation } from "./pack/limits";
import { computeDelta, recordExport, type ExportState } from "./state/manifest";
import type { AnalysisCache } from "./state/cache";

export interface PreviousManifestLike {
	hashes: Record<string, string>;
}

export interface ExportDeps {
	vault: VaultPort;
	sink: SinkPort;
	onProgress?: ProgressReporter;
	signal?: CancelSignal;
	/** In-memory analysis cache (optional, big speed-up on re-runs). */
	cache?: AnalysisCache;
	/** Persisted state, mutated by the run. */
	state?: ExportState;
	/** Downloads / clipboard targets cannot be written twice. */
	clipboard?: { write(text: string): Promise<void> };
	/** Reads the manifest produced by the previous run (for delta exports). */
	readPreviousManifest?: (profileId: string) => Promise<PreviousManifestLike | null>;
	/** Reads a note by path for transclusion. */
	readNote?: (path: string) => Promise<string | null>;
	readBinary?: (path: string) => Promise<string | null>;
	now?: () => number;
	pluginVersion?: string;
	/** Continue on unreadable files instead of failing. */
	maxFileBytes?: number;
	/** Extra exclusion globs (e.g. Obsidian's own "excluded files" setting). */
	excludePatterns?: string[];
	/** Notes analysed in parallel. Defaults to 6. */
	concurrency?: number;
	/**
	 * Called with the files about to be written; returning false aborts the
	 * run before anything touches the disk.
	 */
	beforeWrite?: (paths: string[]) => Promise<boolean> | boolean;
}

export interface ExportRequest {
	profile: ExportProfile;
	/** `preview` runs everything but writes nothing. */
	mode?: "export" | "preview";
	/** Overrides the profile's output settings (used by "Send to…" commands). */
	outputOverride?: Partial<ExportProfile["output"]>;
	/** Optional extra message shown in the UI (e.g. "from the file menu"). */
	reason?: string;
}

export interface PreviewResult extends ExportResult {
	/** Number of notes that survived each stage, for the preview table. */
	stages: { label: string; count: number; detail: string }[];
}

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

export async function runExport(request: ExportRequest, deps: ExportDeps): Promise<ExportResult> {
	const started = deps.now?.() ?? Date.now();
	// Wall clock, for the report: `deps.now` is a fixed clock in tests and demos.
	const wallStarted = Date.now();
	const profile = request.profile;
	const warnings: string[] = [];
	const progress = deps.onProgress ?? (() => {});
	const signal = deps.signal;
	const check = () => {
		if (signal) signal.throwIfCancelled();
	};

	// ---------------------------------------------------------------- discover
	progress({ phase: "discover", progress: 0, message: "Listing vault files…" });
	check();
	const allFiles = await deps.vault.listFiles();
	const pathIndex = new Map<string, string>();
	for (const file of allFiles) pathIndex.set(file.path.toLowerCase(), file.path);
	// Built once: resolving a link by name must not scan the whole vault.
	const nameIndex = buildNameIndex(pathIndex.values());

	const selection = selectCandidates(
		allFiles,
		profile,
		deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
		profile.filters.respectObsidianIgnore ? (deps.excludePatterns ?? []) : [],
	);
	warnings.push(...selection.warnings);
	const discovered = selection.files.length;

	// ---------------------------------------------------------------- analyze
	const boilerplateAccumulator = new BoilerplateAccumulator(profile.condensation.boilerplate);
	const analyses: DocAnalysis[] = [];
	const droppedByFilter: string[] = [];
	let analyzed = 0;
	const concurrency = Math.max(1, Math.min(16, deps.concurrency ?? 6));

	await mapLimit(selection.files, concurrency, async (file) => {
		check();
		const cacheKey = deps.cache ? scoreCacheKey(file) : "";
		let analysis = deps.cache?.get(cacheKey);
		if (analysis && cacheKey === scoreCacheKey({ ...analysis.file, size: file.size, mtime: file.mtime } as SourceFile)) {
			boilerplateAccumulator.addDocument(analysis);
		} else {
			let text: string;
			try {
				text = await deps.vault.read(file.path);
			} catch (error) {
				warnings.push(`Could not read ${file.path}: ${describeError(error)}`);
				analyzed++;
				return;
			}
			check();
			analysis = analyzeDocument(file, text, { lineSink: boilerplateAccumulator });
			deps.cache?.set(cacheKey, analysis);
		}
		analyzed++;
		if (analyzed % 50 === 0 || analyzed === selection.files.length) {
			progress({
				phase: "analyze",
				progress: selection.files.length === 0 ? 1 : analyzed / selection.files.length,
				message: `Analysing notes… ${analyzed}/${selection.files.length}`,
				current: analyzed,
				total: selection.files.length,
			});
		}
		const filterResult = applyFilters(analysis, profile, deps.now?.() ?? Date.now());
		if (filterResult.keep) analyses.push(analysis);
		else droppedByFilter.push(...filterResult.reasons.map((reason) => `${file.path}: ${reason}`));
	});

	check();
	progress({ phase: "analyze", progress: 1, message: `Analysed ${analyses.length} notes.`, current: analyses.length, total: selection.files.length });

	// ---------------------------------------------------------------- intel
	progress({ phase: "condense", progress: 0.05, message: "Building the link graph…" });
	const graph = buildLinkGraph(analyses);
	const related = buildRelatedIndex(analyses, { topK: 6, minSimilarity: 0.35 });
	const dedupe = detectDuplicates(analyses, {
		enabled: profile.condensation.dedupe.enabled,
		mode: profile.condensation.dedupe.mode,
		threshold: profile.condensation.dedupe.threshold,
		containmentThreshold: profile.condensation.dedupe.containmentThreshold,
		minWords: profile.condensation.dedupe.minWords,
	});
	const boilerplate = boilerplateAccumulator.finish();
	if (boilerplateAccumulator.saturated) {
		warnings.push("The boilerplate line table saturated (very large corpus) — detection may be partial.");
	}

	// ---------------------------------------------------------------- selection
	let selected = analyses.filter((doc) => !dedupe.duplicateOf.has(doc.file.path));
	const removedAsDuplicate = analyses.length - selected.length;

	// Stub removal (notes that are essentially an empty shell).
	const stubs: string[] = [];
	if (profile.condensation.dropStubs.enabled) {
		const before = selected.length;
		selected = selected.filter((doc) => {
			const isStub = isStubDocument(doc, profile);
			if (isStub) stubs.push(doc.file.path);
			return !isStub;
		});
		warnings.push(...(() => {
			const count = before - selected.length;
			return count > 0 ? [`${count} near-empty note(s) were dropped as stubs.`] : [];
		})());
	}

	// Incremental delta: only export what changed since the last run.
	let deltaNote: string | undefined;
	if (profile.output.incremental === "delta" && deps.state) {
		const delta = computeDelta(deps.state, profile.id, selected);
		const changedSet = new Set(delta.changed);
		selected = selected.filter((doc) => changedSet.has(doc.file.path));
		deltaNote =
			delta.changed.length === 0
				? "Nothing changed since the last export — the bundle contains only the corpus map."
				: `${delta.unchanged.length} unchanged note(s) skipped (incremental mode); ${delta.changed.length} changed or new note(s) exported.`;
	}

	// ---------------------------------------------------------------- ordering
	const ordered = orderSelection(selected, profile, graph, related);

	// ---------------------------------------------------------------- prepare
	// Candidates are read and transformed *before* the budget is decided, so
	// that it works from the sizes that will really be written. Transformations
	// move those sizes a lot (Chat context strips boilerplate and merges
	// duplicates; transclusion inlining grows notes), and budgeting on raw note
	// sizes both wasted half the budget and could overshoot a destination.
	const resolver = createResolver(deps, pathIndex, allFiles);
	const kbContext = {
		hashes: boilerplate.hashes,
		exactHashes: boilerplate.exactHashes,
		options: profile.condensation.boilerplate,
	};
	const transformStats: TransformStats[] = [];
	let done = 0;
	let unreadable = 0;

	const prepared = await mapLimit(ordered, 4, async (entry): Promise<PreparedNote | null> => {
		check();
		const doc = entry.doc;
		let raw: string;
		try {
			raw = await deps.vault.read(doc.file.path);
		} catch (error) {
			warnings.push(`Could not read ${doc.file.path} for rendering: ${describeError(error)}`);
			unreadable++;
			done++;
			return null;
		}
		const transformed = await transformDocument(raw, profile.transform, {
			format: profile.packaging.format,
			path: doc.file.path,
			title: doc.title,
			resolver,
			transclusion: {
				depth: profile.transform.transcludeDepth,
				maxChars: profile.transform.transcludeMaxChars,
				inline: profile.condensation.inlineTransclusions,
			},
			boilerplate: kbContext,
		});
		transformStats.push(transformed.stats);
		warnings.push(...transformed.warnings.slice(0, 5));

		let body = transformed.text;
		// Merge duplicate content when the profile asks for it (the duplicates
		// are not part of `ordered`, so we append their unique lines here).
		if (profile.condensation.dedupe.enabled && profile.condensation.dedupe.mode === "merge") {
			const group = dedupe.groups.find((g) => g.representative === doc.file.path);
			if (group) {
				const merged = await mergeDuplicates(body, group.duplicates, deps);
				if (merged.addedLines > 0) {
					body = `${body}\n\n<!-- merged from duplicates -->\n${merged.text}`;
					warnings.push(
						`Merged ${merged.addedLines} unique line(s) from ${group.duplicates.length} duplicate note(s) into ${doc.file.path}.`,
					);
				}
			}
		}

		done++;
		progress({
			phase: "condense",
			progress: 0.1 + 0.7 * (done / Math.max(1, ordered.length)),
			message: `Condensing notes… ${done}/${ordered.length}`,
			current: done,
			total: ordered.length,
		});
		return { entry, body, transformed, tokens: estimateTokens(body).tokens, words: countWords(body) };
	});
	const condenseable = prepared.filter((note): note is PreparedNote => note !== null);
	const preparedByPath = new Map(condenseable.map((note) => [note.entry.doc.file.path, note]));

	// ---------------------------------------------------------------- budget
	const overhead = estimateOverhead(
		profile,
		condenseable.map((note) => note.entry.doc),
	);
	const budget = allocateBudget(
		condenseable.map((note) => ({
			path: note.entry.doc.file.path,
			tokens: note.tokens,
			words: note.words,
			signal: note.entry.doc.signal,
		})),
		{
			maxTokens: budgetTokensFromProfile(profile),
			maxWords: profile.limits.maxTotalWords,
			overheadTokens: overhead.base,
			perNoteOverheadTokens: overhead.perNote,
			perNoteOverheadCap: profile.packaging.tocMaxEntries,
			perIncludedTokens: overhead.perIncluded,
			minDocTokens: 60,
			summaryTokens: 0,
			summarizeRatio: profile.condensation.summarize.ratio,
			summarizeMinWords: profile.condensation.summarize.minWords,
			allowSummarize: profile.condensation.summarize.enabled,
			allowDrop: true,
			allowTruncate: true,
		},
	);
	for (const path of budget.dropped) warnings.push(`Dropped ${path} — the token budget could not fit it.`);
	if (budget.dropped.length > 0) {
		warnings.push(`${budget.dropped.length} note(s) were dropped to respect the token budget.`);
	}

	// Citation ids are assigned to the notes that actually make it in.
	const included: OrderedEntry[] = [];
	const cappedByFilter: string[] = [];
	for (const entry of ordered) {
		// A note already dropped while ordering (e.g. by the note cap) never
		// comes back — the budget decision must not override it.
		if (entry.decision.action === "drop") {
			cappedByFilter.push(entry.doc.file.path);
			continue;
		}
		if (!preparedByPath.has(entry.doc.file.path)) continue; // unreadable
		const decision = budget.decisions.get(entry.doc.file.path) ?? entry.decision;
		if (decision.action === "drop") continue;
		included.push({ ...entry, decision });
	}
	if (cappedByFilter.length > 0) {
		warnings.push(`${cappedByFilter.length} note(s) were left out because the profile caps the export at ${profile.filters.maxNotes} notes.`);
	}
	if (included.length === 0 && discovered > 0) {
		warnings.push(
			"No notes matched the current filters — the bundle contains only the corpus map. Check the folder, tag and date filters.",
		);
	}
	included.forEach((entry, index) => {
		entry.citationId = `S${String(index + 1).padStart(2, "0")}`;
	});

	const citationByPath = new Map<string, string>(included.map((e) => [e.doc.file.path, e.citationId]));
	const analysisByPath = new Map<string, DocAnalysis>(analyses.map((doc) => [doc.file.path, doc]));

	// ---------------------------------------------------------------- render
	const rendered: RenderedNote[] = [];
	for (const entry of included) {
		check();
		const preparedNote = preparedByPath.get(entry.doc.file.path);
		if (!preparedNote) continue;
		const doc = entry.doc;
		let body = preparedNote.body;
		let summaryApplied = false;
		let truncated = false;

		const decision = entry.decision;
		if (decision.action === "summarize" && profile.condensation.summarize.enabled) {
			const result = summarize(body, profile.condensation.summarize, {
				headings: doc.headings,
				topTerms: doc.topTerms,
			});
			if (result.applied) {
				body = result.text;
				summaryApplied = true;
			}
		} else if (decision.action === "truncate") {
			const truncatedBody = truncateToTokens(body, decision.allowance);
			if (truncatedBody.truncated) {
				body = truncatedBody.text;
				truncated = true;
			}
		}

		// The prepare phase already measured this body; re-measuring it would
		// only repeat the most expensive call of the run unchanged.
		const tokenCount = summaryApplied || truncated ? estimateTokens(body).tokens : preparedNote.tokens;
		const node = graph.nodes.get(doc.file.path);
		const relatedNotes = (related.byPath.get(doc.file.path) ?? [])
			.map((r) => ({
				id: citationByPath.get(r.path) ?? "",
				title: analyses.find((d) => d.file.path === r.path)?.title ?? stripExtension(basename(r.path)),
				similarity: r.similarity,
			}))
			.filter((r) => r.id !== "");

		rendered.push({
			id: entry.citationId,
			path: doc.file.path,
			title: doc.title,
			body,
			tags: profile.transform.tags === "strip" ? doc.tags : unique([...doc.tags, ...preparedNote.transformed.inlineTags]),
			aliases: doc.aliases,
			frontmatter: selectFrontmatter(doc, profile),
			words: countWords(body),
			tokens: tokenCount,
			chars: body.length,
			modified: doc.file.mtime,
			created: doc.file.ctime,
			related: relatedNotes,
			inbound: node?.inDegree ?? 0,
			outbound: node?.outDegree ?? 0,
			summaryApplied,
			duplicateOf: undefined,
			truncated,
			boilerplateLines: preparedNote.transformed.stats.boilerplateLines,
			transclusions: preparedNote.transformed.stats.transclusions,
		});
	}

	// Collapsed duplicates become tiny provenance stubs.
	if (profile.condensation.dedupe.enabled && profile.condensation.dedupe.mode === "collapse") {
		// The stubs take the next citation ids so that a duplicate is still a
		// citable source ("see S13, a copy of S04") instead of a nameless entry.
		let nextStubId = included.length + 1;
		for (const group of dedupe.groups) {
			const representativeId = citationByPath.get(group.representative);
			if (!representativeId) continue;
			for (const duplicate of group.duplicates) {
				const stubId = profile.packaging.citationIds
					? `S${String(nextStubId++).padStart(2, "0")}`
					: "";
				rendered.push({
					id: stubId,
					path: duplicate,
					title: stripExtension(basename(duplicate)),
					body: `*Duplicate of ${representativeId}${stubId ? ` (${stubId})` : ""} — content omitted (similarity ${(group.similarity * 100).toFixed(0)} %).*`,
					tags: [],
					aliases: [],
					frontmatter: {},
					words: 0,
					tokens: 0,
					chars: 0,
					modified: 0,
					created: 0,
					related: [],
					inbound: 0,
					outbound: 0,
					summaryApplied: false,
					duplicateOf: representativeId,
				});
			}
		}
		rendered.sort((a, b) => (citationIndex(a.id) - citationIndex(b.id)) || a.path.localeCompare(b.path));
	}

	// ---------------------------------------------------------------- package
	check();
	progress({ phase: "render", progress: 0.85, message: "Rendering the bundle…" });

	const stats: PlanStats = {
		discovered,
		kept: rendered.length,
		droppedByFilter: droppedByFilter.length + cappedByFilter.length,
		droppedAsDuplicate: removedAsDuplicate,
		droppedAsStub: stubs.length,
		droppedAsUnreadable: unreadable,
		words: rendered.reduce((acc, n) => acc + n.words, 0),
		tokens: rendered.reduce((acc, n) => acc + n.tokens, 0),
		chars: rendered.reduce((acc, n) => acc + n.chars, 0),
		boilerplateLines: transformStats.reduce((acc, s) => acc + s.boilerplateLines, 0),
		summarized: rendered.filter((n) => n.summaryApplied).length,
	};

	// The knowledge layer describes what the bundle *contains*, so it is built
	// from the notes that survived filtering, deduplication and budgeting — and
	// from their cleaned bodies, so boilerplate no longer pollutes key terms.
	const includedDocs = analyses.filter((doc) => citationByPath.has(doc.file.path));
	const cleanedDocs = includedDocs.map((doc) => {
		const note = rendered.find((n) => n.path === doc.file.path);
		if (!note) return doc;
		const frequencies = new Map<string, number>();
		collectTerms(note.body, frequencies);
		return { ...doc, topTerms: rankTerms(frequencies, 14) };
	});

	const glossary = profile.packaging.includeGlossary
		? extractGlossary(
				rendered
					.filter((note) => note.id !== "" && !note.duplicateOf)
					.map((note) => ({ analysis: analysisByPath.get(note.path)!, body: note.body }))
					.filter((entry) => entry.analysis),
			)
		: [];

	const wantKnowledgeMap = profile.packaging.includeKnowledgeMap || profile.packaging.instructionsFile;
	const knowledgeMap = wantKnowledgeMap
		? buildKnowledgeMap({
				docs: cleanedDocs,
				// Only notes with real content: provenance stubs must not appear
				// in the reading order, the hubs or the orphan list.
				included: included.map((entry) => entry.doc.file.path),
				graph,
				themes: buildThemes(cleanedDocs, related, { minSimilarity: 0.45, minSize: 3, maxThemes: 12 }),
				keyTerms: buildKeyTerms(cleanedDocs).byPath,
				duplicates: dedupe.groups,
				// Only lines the stripper would really have removed: a template
				// shared by three notes but below the length floor is not a
				// removal, and reporting it would be a lie.
				boilerplate: boilerplate.samples
					.filter((sample) => sample.text.trim().length >= profile.condensation.boilerplate.minLength)
					.filter((sample) => !lineHasDigits(sample.text))
					.slice(0, 8),
				stats: {
					discovered,
					kept: stats.kept,
					words: stats.words,
					tokens: stats.tokens,
					charCount: stats.chars,
				},
				roots: profile.targets.length > 0 ? profile.targets : ["(vault root)"],
				generatedAt: new Date(deps.now?.() ?? Date.now()),
				profileName: profile.name,
				glossary,
			})
		: undefined;

	const bundleTitle = resolveBundleTitle(profile);
	const renderOptions: RenderOptions = {
		format: profile.packaging.format,
		profileName: profile.name,
		bundleTitle,
		includeToc: profile.packaging.includeToc,
		tocMaxDepth: profile.packaging.tocMaxDepth,
		tocMaxEntries: profile.packaging.tocMaxEntries,
		includeKnowledgeMap: profile.packaging.includeKnowledgeMap,
		citationIds: profile.packaging.citationIds,
		headerTemplate: profile.packaging.headerTemplate,
		footerTemplate: profile.packaging.footerTemplate,
		divider: profile.packaging.divider,
		noteHeadingLevel: profile.packaging.noteHeadingLevel,
		includeManifest: profile.packaging.includeManifest,
		generatedAt: new Date(deps.now?.() ?? Date.now()),
		roots: profile.targets,
		stats,
		knowledgeMap,
		repeatHeaders: true,
	};

	const bundle = renderBundle(rendered, renderOptions);
	const chunking = profile.packaging.chunking;
	// The part limit must account for what assembly adds around the units:
	// header, footer, part notice and note dividers. Measuring it is more
	// reliable than guessing, and it is what makes the limit trustworthy.
	const assemblyOverhead =
		estimateTokens(applyTemplate(profile.packaging.headerTemplate, bundle.variables)).tokens +
		estimateTokens(applyTemplate(profile.packaging.footerTemplate, bundle.variables)).tokens +
		estimateTokens(profile.packaging.divider).tokens * 2 +
		40 +
		chunkingOverhead(profile) +
		// The embedded manifest is appended to the first part *after* chunking,
		// so room for it has to be reserved here or the part overflows.
		embeddedManifestTokens(profile, included);
	const partLimit = resolvePartLimit(chunking);
	const chunked = chunkUnits(bundle.units, chunking, assemblyOverhead);

	const generatedAt = new Date(deps.now?.() ?? Date.now());
	// A destination that caps the number of sources (NotebookLM: 50) is served
	// by grouping parts into volumes: each volume is a source-sized bundle of
	// its own, instead of one oversized export that cannot be imported at all.
	const volumeSize = profile.limits.maxParts > 0 ? profile.limits.maxParts : Math.max(1, chunked.parts.length);
	const volumeCount = Math.max(1, Math.ceil(chunked.parts.length / Math.max(1, volumeSize)));
	const volumeOf = (index: number) => (volumeCount > 1 ? Math.floor(index / volumeSize) + 1 : 1);
	const parts = chunked.parts.map((part, index) => {
		const content = normalizeLineEndings(
			assemblePart(part.units, {
				format: profile.packaging.format,
				header: profile.packaging.headerTemplate,
				footer: profile.packaging.footerTemplate,
				divider: profile.packaging.divider,
				partIndex: index,
				partTotal: chunked.parts.length,
				volumeIndex: volumeOf(index),
				volumeTotal: volumeCount,
				variables: bundle.variables,
				title: bundleTitle,
				stats,
				generatedAt,
				citationIds: profile.packaging.citationIds,
				includeManifest: profile.packaging.includeManifest,
				profile: { id: profile.id, name: profile.name },
				includeNoteSeparators: true,
			}),
			profile.packaging.lineEnding,
		);
		const tokens = estimateTokens(content);
		return {
			index,
			total: chunked.parts.length,
			volume: volumeOf(index),
			volumeTotal: volumeCount,
			path: "",
			content,
			chars: content.length,
			words: countWords(content),
			tokens: tokens.tokens,
			sources: part.sources,
			warnings: [] as string[],
		};
	});

	// A self-describing bundle: the first part carries a small JSON block with
	// the citation map, so a model (or a human) can resolve `S03` without the
	// sidecar file. Appended before the limit check so the numbers stay honest.
	if (profile.packaging.manifestEmbedded && parts.length > 0) {
		const sources: Record<string, string> = {};
		for (const entry of included) sources[entry.citationId] = entry.doc.file.path;
		const embedded = {
			plugin: { id: "condensated-vault-exporter", version: deps.pluginVersion ?? "1.0.0" },
			profile: { id: profile.id, name: profile.name },
			generatedAt: generatedAt.toISOString(),
			format: profile.packaging.format,
			parts: parts.length,
			volumes: volumeCount,
			stats,
			citation: {
				scheme: "S01, S02 … — the id printed in front of each note",
				sources,
			},
		};
		const block = `\n\n<!-- bundle manifest -->\n\`\`\`json\n${JSON.stringify(embedded)}\n\`\`\`\n`;
		const first = parts[0];
		first.content += block;
		first.chars = first.content.length;
		first.tokens = estimateTokens(first.content).tokens;
		first.words = countWords(first.content);
	}


	const partsPerVolume = Math.max(1, Math.min(volumeSize, parts.length));
	const limitViolations = checkLimits(
		{
			// A volume is what a single source of the destination receives, so the
			// part cap is measured per volume, not over the whole export.
			parts: volumeCount > 1 ? partsPerVolume : parts.length,
			totalWords: stats.words,
			totalTokens: stats.tokens,
			maxPartWords: Math.max(0, ...parts.map((p) => p.words)),
			maxPartTokens: Math.max(0, ...parts.map((p) => p.tokens)),
			maxPartBytes: Math.max(0, ...parts.map((p) => p.content.length)),
		},
		profile.limits,
	);
	if (volumeCount > 1) {
		warnings.push(
			`ℹ️ ${parts.length} parts exceed the ${profile.limits.maxParts}-source limit of the destination, so they were grouped into ${volumeCount} volumes of at most ${partsPerVolume} parts. Import one volume (or notebook) at a time.`,
		);
	}
	warnings.push(...chunked.warnings);
	warnings.push(...limitViolations.map((v) => `${v.severity === "error" ? "❌" : v.severity === "warning" ? "⚠️" : "ℹ️"} ${v.message}`));
	if (deltaNote) warnings.push(`🔄 ${deltaNote}`);

	// Instructions for the destination model: always computed (the UI can offer
	// them even when no file is written), written only when the profile asks.
	const instructionsText = knowledgeMap
		? buildInstructions({
				map: knowledgeMap,
				citationIds: profile.packaging.citationIds,
				stats: { words: stats.words, tokens: stats.tokens, chars: stats.chars },
				profileName: profile.name,
				parts: parts.length,
				volumes: volumeCount,
				lastModified: knowledgeMap.overview.dateRange?.to,
				destination: profile.limits.label !== "" ? profile.limits.label : profile.name,
			})
		: null;
	const instructionsPath =
		profile.packaging.instructionsFile && instructionsText
			? joinOutputPath(
					{ ...profile.output, ...(request.outputOverride ?? {}) },
					sanitizeRelativePath(
						planOutputNames(
							profile,
							bundleTitle,
							parts.length,
							generatedAt,
							volumeCount,
							volumeSize,
							parts.map((part) => part.sources),
						)[0],
						"bundle",
					)
						.replace(/-v\d+(\.[^.]+)$/, "$1")
						.replace(/\.[^.]+$/, "") + ".instructions.md",
				)
			: null;

	// Per-note content hashes: they make the sidecar a real record of what was
	// exported (and of the exact revision of each note).
	const bundledHashes: Record<string, string> = {};
	for (const note of rendered) {
		const analysis = analysisByPath.get(note.path);
		if (analysis) bundledHashes[note.path] = analysis.hash;
	}
	// How does this compare to the previous export of the same profile? The
	// previous manifest is read before anything is written (it is about to be
	// replaced), so the diff can be reported to the user either way.
	const previousManifest = deps.readPreviousManifest ? await deps.readPreviousManifest(profile.id).catch(() => null) : null;
	const delta = computeExportDelta(bundledHashes, previousManifest);

	const written: string[] = [];
	const output = { ...profile.output, ...(request.outputOverride ?? {}) };
	// Planned once: the write phase, the sidecar, the instructions file and the
	// report all need the same names.
	const names = planOutputNames(
		profile,
		bundleTitle,
		parts.length,
		generatedAt,
		volumeCount,
		volumeSize,
		parts.map((part) => part.sources),
	);
	const droppedEntries: ReportEntry[] = budget.dropped.map((path) => ({
		path,
		reason: "the token budget could not fit it",
	}));
	const reportText = buildExportReport({
		profileName: profile.name,
		generatedAt,
		durationMs: Date.now() - wallStarted,
		stats,
		parts: parts.map((part, index) => ({
			index,
			// In preview nothing is written yet: the report names the file the
			// export *would* create, which is what the dialog shows.
			path: part.path !== "" ? part.path : joinOutputPath(output, names[index]),
			words: part.words,
			tokens: part.tokens,
			sources: part.sources.length,
			bytes: part.content.length,
		})),
		volumes: volumeCount,
		limits: profile.limits,
		violations: limitViolations,
		dropped: droppedEntries,
		duplicates: dedupe.groups.map((group) => ({
			representative: group.representative,
			duplicates: group.duplicates,
			similarity: group.similarity,
		})),
		boilerplate: boilerplate.samples.map((sample) => ({ text: sample.text, docs: sample.docs })),
		transforms: transformStats,
		summarized: budget.summarized.length,
		truncated: budget.truncated.length,
		warnings,
		delta: previousManifest ? delta : undefined,
	});
	const reportPath =
		profile.packaging.reportFile && reportText !== ""
			? joinOutputPath(
					output,
					sanitizeRelativePath(names[0], "bundle")
						.replace(/-v\d+(\.[^.]+)$/, "$1")
						.replace(/\.[^.]+$/, "") + ".report.md",
				)
			: null;



	// ---------------------------------------------------------------- write
	const manifest = buildManifest(
		profile,
		bundle.variables.title,
		stats,
		parts,
		generatedAt,
		dedupe,
		boilerplate.samples.length,
		deps,
		warnings,
		bundledHashes,
		started,
	);
	if (request.mode !== "preview") {
		check();
		progress({ phase: "write", progress: 0.9, message: "Writing the bundle…" });
		const targets = names.map((name) => joinOutputPath(output, name));
		if (deps.beforeWrite && !(await deps.beforeWrite(targets))) {
			throw new ExportAbortedError("The export was aborted before writing any file.");
		}
		for (let i = 0; i < parts.length; i++) {
			// Cancellation is checked between writes too: the write phase is the
			// destructive one, and a long bundle must not be un-cancellable just
			// because it is already past the analysis.
			check();
			const target = joinOutputPath(output, names[i]);
			const finalPath = await deps.sink.write(target, parts[i].content);
			parts[i].path = finalPath;
			written.push(finalPath);
		}

		if (profile.packaging.manifestSidecar && parts.length > 0) {
			check();
			const manifestPath = joinOutputPath(
				output,
				sanitizeRelativePath(names[0], "bundle").replace(/\.md$|\.txt$|\.jsonl?$|\.xml$/i, "") + ".manifest.json",
			);
			written.push(await deps.sink.write(manifestPath, JSON.stringify(withDelta(manifest, delta), null, 2)));
		}

		if (instructionsPath !== null && instructionsText !== null) {
			check();
			written.push(await deps.sink.write(instructionsPath, instructionsText));
		}

		if (reportPath !== null) {
			check();
			written.push(await deps.sink.write(reportPath, reportText));
		}

		if (parts.length > 1 && profile.output.destination === "vault") {
			check();
			// A small index file makes a 50-part bundle navigable.
			const indexPath = joinOutputPath(
				output,
				sanitizeRelativePath(names[0], "bundle").replace(/-v\d+(\.[^.]+)$/, "$1").replace(/\.[^.]+$/, "") + ".index.md",
			);
			written.push(await deps.sink.write(indexPath, renderPartIndex(profile, bundleTitle, parts, generatedAt)));
		}

		if (deps.clipboard && (output.alsoCopyToClipboard || output.destination === "clipboard")) {
			check();
			progress({ phase: "write", progress: 0.97, message: "Copying to the clipboard…" });
			const text = parts.map((p) => p.content).join("\n\n");
			await deps.clipboard.write(text);
		}

		if (deps.state) {
			recordExport(deps.state, {
				profileId: profile.id,
				docs: analyses,
				included: rendered.map((r) => r.path),
				generatedAt,
				outputs: written,
				words: stats.words,
				tokens: stats.tokens,
				parts: parts.length,
				durationMs: (deps.now?.() ?? Date.now()) - started,
			});
		}
	}

	progress({
		phase: "done",
		progress: 1,
		message: `${parts.length} part(s), ${formatCount(stats.words)} words, ~${formatCount(stats.tokens)} tokens.`,
	});

	const result: ExportResult = {
		chunking: {
			partLimitTokens: partLimit,
			overheadTokens: assemblyOverhead,
			packLimitTokens: Math.max(0, partLimit - assemblyOverhead),
			units: bundle.units.length,
			largestUnitTokens: bundle.units.reduce((max, u) => Math.max(max, u.tokens), 0),
		},
		parts,
		instructions: instructionsText ?? undefined,
		report: reportText,
		delta: previousManifest ? delta : undefined,
		manifest: {
			...manifest,
			parts: parts.map((p) => ({
				index: p.index,
				volume: p.volumeTotal > 1 ? p.volume : undefined,
				path: p.path,
				sources: p.sources.length,
				words: p.words,
				tokens: p.tokens,
			})),
		},
		stats,
		warnings,
		written,

	};
	return result;
}

/* -------------------------------------------------------------------------- */
/*  Discovery                                                                  */
/* -------------------------------------------------------------------------- */

const NOTE_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

export interface CandidateSelection {
	files: SourceFile[];
	warnings: string[];
}

export function selectCandidates(
	files: SourceFile[],
	profile: ExportProfile,
	maxFileBytes: number,
	extraExclude: string[] = [],
): CandidateSelection {
	const warnings: string[] = [];
	const roots = profile.targets.map(normalizeVaultPath).filter((t) => t !== "");
	const filters = profile.filters;
	const outputFolder = normalizeVaultPath(profile.output.folder);
	const includePatterns = [...profile.include, "!**/*.excalidraw.md"];
	const hasInclude = hasPositivePattern(includePatterns);

	const selected: SourceFile[] = [];
	for (const file of files) {
		const path = normalizeVaultPath(file.path);
		const ext = file.ext;

		// A note is a Markdown file; other text files are opt-in.
		const textual = NOTE_EXTENSIONS.has(ext) || (filters.includeTextFiles && ["txt", "text", "csv", "org", "tex"].includes(ext));
		if (!textual) continue;

		// Cheap folder exclusions first (Obsidian internals, own output).
		if (path.startsWith(".obsidian/") || path.includes("/.obsidian/")) continue;
		if (path.startsWith(".trash/") || path.includes("/.trash/")) continue;
		if (filters.excludeOutputFolder && outputFolder !== "" && (path === outputFolder || path.startsWith(outputFolder + "/"))) continue;

		// Roots & depth.
		if (roots.length > 0 && !roots.some((root) => path === root || path.startsWith(root + "/"))) continue;
		if (profile.depth >= 0) {
			const root = roots.find((r) => path === r || path.startsWith(r + "/"));
			const relative = root ? path.slice(root === "" ? 0 : root.length + 1) : path;
			const depth = relative.split("/").length - 1;
			if (depth > profile.depth) continue;
		}

		// Include / exclude globs, evaluated against both the full path and the
		// path relative to the deepest matching root (so `*.md` works in a folder).
		const relative = relativeToRoot(path, roots);
		const included = hasInclude ? matchAny(includePatterns, relative) || matchAny(includePatterns, path) : true;
		if (!included) continue;
		if (profile.exclude.length > 0 && (matchAny(profile.exclude, relative) || matchAny(profile.exclude, path))) continue;
		if (extraExclude.length > 0 && (matchAny(extraExclude, relative) || matchAny(extraExclude, path))) continue;

		// Cheap pre-filters.
		if (filters.maxFileMegabytes > 0 && file.size > filters.maxFileMegabytes * 1024 * 1024) {
			warnings.push(`${path} skipped (${(file.size / 1024 / 1024).toFixed(1)} MB > limit).`);
			continue;
		}
		if (maxFileBytes > 0 && file.size > maxFileBytes) {
			warnings.push(`${path} skipped (larger than ${Math.round(maxFileBytes / 1024 / 1024)} MB).`);
			continue;
		}
		selected.push({ ...file, path });
	}

	selected.sort((a, b) => naturalCompare(a.path, b.path));
	return { files: selected, warnings };
}

function relativeToRoot(path: string, roots: string[]): string {
	let best = path;
	for (const root of roots) {
		if (root === "" || root === ".") continue;
		if (path.startsWith(root + "/") && root.length < best.length) best = path.slice(root.length + 1);
	}
	return best;
}

function scoreCacheKey(file: SourceFile): string {
	return `${file.path}|${file.size}|${Math.round(file.mtime)}`;
}

interface FilterResult {
	keep: boolean;
	reasons: string[];
}

export function applyFilters(doc: DocAnalysis, profile: ExportProfile, now: number): FilterResult {
	const filters = profile.filters;
	const reasons: string[] = [];
	const tags = doc.tags.map((t) => t.toLowerCase());

	if (filters.tagsAll.length > 0) {
		for (const required of filters.tagsAll) {
			if (!tags.some((tag) => tagMatches(tag, required))) {
				reasons.push(`missing required tag #${required}`);
				break;
			}
		}
	}
	if (reasons.length === 0 && filters.tagsAny.length > 0) {
		if (!tags.some((tag) => filters.tagsAny.some((required) => tagMatches(tag, required)))) {
			reasons.push(`none of the tags ${filters.tagsAny.map((t) => `#${t}`).join(", ")}`);
		}
	}
	if (filters.tagsNone.length > 0 && tags.some((tag) => filters.tagsNone.some((banned) => tagMatches(tag, banned)))) {
		reasons.push("carries an excluded tag");
	}
	if (filters.minWordsHard !== null && doc.stats.words < filters.minWordsHard) {
		reasons.push(`fewer than ${filters.minWordsHard} words`);
	}
	if (filters.maxWords !== null && doc.stats.words > filters.maxWords) reasons.push(`more than ${filters.maxWords} words`);
	if (filters.modifiedWithinDays !== null) {
		const cutoff = now - filters.modifiedWithinDays * 86_400_000;
		if ((doc.file.mtime || 0) < cutoff) reasons.push(`not modified in the last ${filters.modifiedWithinDays} days`);
	}
	if (filters.createdWithinDays !== null) {
		const cutoff = now - filters.createdWithinDays * 86_400_000;
		if ((doc.file.ctime || 0) < cutoff) reasons.push(`not created in the last ${filters.createdWithinDays} days`);
	}
	if (filters.pathRegex) {
		try {
			const re = new RegExp(filters.pathRegex);
			if (!re.test(doc.file.path)) reasons.push(`path does not match /${filters.pathRegex}/`);
		} catch {
			// An invalid regex must not silently drop everything.
		}
	}
	if (filters.requireFrontmatterKey) {
		const value = doc.frontmatter.data[filters.requireFrontmatterKey];
		if (value === undefined || value === null || value === "") {
			reasons.push(`missing frontmatter key “${filters.requireFrontmatterKey}”`);
		}
	}
	if (filters.skipEmpty && filters.minWords > 0 && doc.stats.words < filters.minWords) reasons.push("empty note");

	return { keep: reasons.length === 0, reasons };
}

function tagMatches(tag: string, pattern: string): boolean {
	const normalized = pattern.replace(/^#/, "").toLowerCase();
	if (normalized === "") return false;
	if (normalized.endsWith("*")) return tag.startsWith(normalized.slice(0, -1));
	return tag === normalized || tag.startsWith(normalized + "/");
}

function isStubDocument(doc: DocAnalysis, profile: ExportProfile): boolean {
	const options = profile.condensation.dropStubs;
	if (!options.enabled) return false;
	if (doc.stats.words > options.maxWords) return false;
	if (options.linksOnly) {
		// A stub is a note with almost no prose: either empty or pure link list.
		const hasProse = doc.stats.proseChars > Math.max(120, options.maxWords * 4);
		if (hasProse) return false;
		return doc.links.filter((l) => !l.isExternal).length > 0 || doc.stats.words <= 3;
	}
	return true;
}

/* -------------------------------------------------------------------------- */
/*  Ordering                                                                   */
/* -------------------------------------------------------------------------- */

interface PreparedNote {
	entry: OrderedEntry;
	/** Transformed body: what the budget measures and the renderer writes. */
	body: string;
	tokens: number;
	words: number;
	transformed: { stats: TransformStats; inlineTags: string[] };
}

interface OrderedEntry {
	doc: DocAnalysis;
	decision: BudgetDecision;
	citationId: string;
	score: number;
}

export function orderSelection(
	docs: DocAnalysis[],
	profile: ExportProfile,
	graph: LinkGraph,
	related: RelatedIndex,
): OrderedEntry[] {
	const order = profile.order;
	const direction = order.direction === "desc" ? -1 : 1;
	const centrality = new Map<string, number>();
	for (const [path, node] of graph.nodes) centrality.set(path, node.centrality);

	const scored = new Map(
		scoreDocuments(docs, centrality, {
			weightSignal: 1,
			weightCentrality: 1,
			weightRecency: 0.6,
			weightLength: 0.3,
			recencyHalfLifeDays: 180,
			folderWeights: [],
			boostPatterns: [],
			demotePatterns: [],
		}).map((entry) => [entry.path, entry.score]),
	);

	const compare = (a: DocAnalysis, b: DocAnalysis): number => {
		const result = compareBy(a, b, order);
		if (result !== 0) return result * direction;
		return naturalCompare(a.file.path, b.file.path);
	};

	let sorted = [...docs].sort(compare);

	if (order.clusterSimilar && sorted.length > 2) {
		sorted = clusterSimilar(sorted, related, centrality);
	}

	const entries: OrderedEntry[] = sorted.map((doc) => ({
		doc,
		decision: { path: doc.file.path, action: "full", allowance: doc.stats.tokens, reason: "" },
		citationId: "",
		score: scored.get(doc.file.path) ?? 0,
	}));

	if (profile.filters.maxNotes !== null && profile.filters.maxNotes > 0 && entries.length > profile.filters.maxNotes) {
		// The ordering *is* the priority: a cap keeps the first N notes in the
		// requested order. (The token budget is what drops by value instead.)
		const kept = entries.slice(0, profile.filters.maxNotes);
		for (const entry of entries.slice(profile.filters.maxNotes)) {
			entry.decision = { path: entry.doc.file.path, action: "drop", allowance: 0, reason: "max notes reached" };
		}
		return entries;
	}
	return entries;
}

function compareBy(a: DocAnalysis, b: DocAnalysis, order: ExportProfile["order"]): number {
	let result = 0;
	switch (order.by) {
		case "title":
			result = naturalCompare(a.title, b.title);
			break;
		case "modified":
			result = (a.file.mtime || 0) - (b.file.mtime || 0);
			break;
		case "created":
			result = (a.file.ctime || 0) - (b.file.ctime || 0);
			break;
		case "words":
			result = a.stats.words - b.stats.words;
			break;
		case "frontmatter": {
			const key = order.frontmatterKey || "order";
			const av = a.frontmatter.data[key];
			const bv = b.frontmatter.data[key];
			result = compareValues(av, bv);
			break;
		}
		case "centrality":
			result = a.stats.words - b.stats.words; // replaced by score ordering below
			break;
		case "path":
		default:
			result = naturalCompare(a.file.path, b.file.path);
			break;
	}
	if (result === 0 && order.groupByFolder) {
		result = naturalCompare(a.file.folder, b.file.folder);
	}
	return result;
}

function compareValues(a: FrontmatterValue | undefined, b: FrontmatterValue | undefined): number {
	if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1;
	if (b === undefined || b === null) return -1;
	if (typeof a === "number" && typeof b === "number") return a - b;
	if (Array.isArray(a) && Array.isArray(b)) return a.length - b.length;
	if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
	return String(a).localeCompare(String(b));
}

/**
 * Greedy nearest-neighbour chaining: start from the most central note, then
 * repeatedly append the unvisited note that is most similar to the current
 * one; fall back to the next note in the original order when nothing is
 * similar. Keeps related material contiguous in the bundle.
 */
function clusterSimilar(docs: DocAnalysis[], related: RelatedIndex, centrality: Map<string, number>): DocAnalysis[] {
	const byPath = new Map(docs.map((d) => [d.file.path, d]));
	const orderIndex = new Map(docs.map((d, i) => [d.file.path, i]));
	let start = docs[0];
	for (const doc of docs) {
		if ((centrality.get(doc.file.path) ?? 0) > (centrality.get(start.file.path) ?? 0)) start = doc;
	}
	const visited = new Set<string>([start.file.path]);
	const out: DocAnalysis[] = [start];
	let current = start;
	let fallbackCursor = orderIndex.get(start.file.path) ?? 0;

	while (out.length < docs.length) {
		const neighbours = related.byPath.get(current.file.path) ?? [];
		let next: DocAnalysis | undefined;
		for (const neighbour of neighbours) {
			if (visited.has(neighbour.path)) continue;
			next = byPath.get(neighbour.path);
			if (next) break;
		}
		if (!next) {
			// Nothing similar left: continue with the next note in the original order.
			for (let step = 1; step <= docs.length; step++) {
				const candidate = docs[(fallbackCursor + step) % docs.length];
				if (!visited.has(candidate.file.path)) {
					next = candidate;
					fallbackCursor = (fallbackCursor + step) % docs.length;
					break;
				}
			}
		}
		if (!next) break;
		visited.add(next.file.path);
		out.push(next);
		current = next;
	}
	return out;
}

/* -------------------------------------------------------------------------- */
/*  Condensation helpers                                                       */
/* -------------------------------------------------------------------------- */

export function selectFrontmatter(doc: DocAnalysis, profile: ExportProfile): Record<string, FrontmatterValue> {
	const mode = profile.transform.frontmatter;
	if (mode === "strip" || mode === "keep") return {};
	const fields = profile.transform.metadataCardFields;
	const data = doc.frontmatter.data;
	if (fields.length === 0) return { ...data };
	const out: Record<string, FrontmatterValue> = {};
	for (const field of fields) if (data[field] !== undefined) out[field] = data[field];
	return out;
}

function truncateToTokens(text: string, tokenBudget: number): { text: string; truncated: boolean } {
	if (tokenBudget <= 0) return { text, truncated: false };
	const { tokens } = estimateTokens(text);
	if (tokens <= tokenBudget) return { text, truncated: false };
	const ratio = tokenBudget / tokens;
	const targetChars = Math.max(200, Math.floor(text.length * ratio));
	const cut = text.slice(0, targetChars);
	const lastBreak = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". "));
	const clean = (lastBreak > targetChars * 0.5 ? cut.slice(0, lastBreak) : cut).trimEnd();
	return { text: `${clean}\n\n*… truncated to fit the token budget …*`, truncated: true };
}

/**
 * Appends the lines a duplicate has and the retained note does not.
 *
 * This is the difference between "we deleted your duplicate" and "we merged
 * your two versions": the first loses information, the second does not.
 */
async function mergeDuplicates(
	baseBody: string,
	duplicatePaths: string[],
	deps: ExportDeps,
): Promise<{ text: string; addedLines: number }> {
	if (duplicatePaths.length === 0) return { text: "", addedLines: 0 };
	const known = new Set<number>();
	for (const line of baseBody.split("\n")) known.add(hash32(normalizeLine(line), 0x51ed));

	const blocks: string[] = [];
	let added = 0;
	for (const path of duplicatePaths) {
		let raw: string | null = null;
		try {
			raw = await deps.vault.read(path);
		} catch {
			continue;
		}
		if (raw === null) continue;
		const lines = raw.split("\n");
		const uniqueLines: string[] = [];
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed === "") {
				uniqueLines.push(line);
				continue;
			}
			const hash = hash32(normalizeLine(line), 0x51ed);
			if (known.has(hash)) continue;
			known.add(hash);
			uniqueLines.push(line);
			added++;
		}
		const text = uniqueLines.join("\n").trim();
		if (text !== "") blocks.push(`**From \`${path}\`**\n\n${text}`);
	}
	if (blocks.length === 0) return { text: "", addedLines: 0 };
	return { text: blocks.join("\n\n"), addedLines: added };
}

/* -------------------------------------------------------------------------- */
/*  Output planning                                                            */
/* -------------------------------------------------------------------------- */

function resolveBundleTitle(profile: ExportProfile): string {
	if (profile.targets.length === 1) {
		const target = profile.targets[0];
		return target === "" || target === "/" ? "Vault export" : `${stripExtension(basename(target))} bundle`;
	}
	if (profile.targets.length > 1) return `Multi-folder bundle (${profile.targets.length} roots)`;
	return "Vault bundle";
}

export function planOutputNames(
	profile: ExportProfile,
	bundleTitle: string,
	partCount: number,
	generatedAt: Date,
	volumeCount = 1,
	volumeSize = partCount,
	/** Source path of each part, in order (used for `{{note_*}}` templates). */
	sources: string[][] = [],
): string[] {
	const extension = extensionFor(profile.packaging.format);
	const variables = templateVariables(profile, bundleTitle, generatedAt);
	const base = applyTemplate(profile.output.fileNameTemplate, { ...variables, part: "", total: String(partCount) }).trim();
	const withExt = base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`;
	const usesVolumeVariable = /\{\{\s*volume/.test(profile.output.fileNameTemplate);
	const usesNoteVariable = /\{\{\s*note_/.test(profile.output.fileNameTemplate);
	const names: string[] = [];
	for (let i = 0; i < partCount; i++) {
		const volume = volumeCount > 1 ? Math.floor(i / Math.max(1, volumeSize)) + 1 : 1;
		// A one-note part can be named after that note; folders are preserved
		// when the template or the profile asks for it.
		const source = sources[i]?.length === 1 ? sources[i][0] : undefined;
		const noteVariables = source !== undefined ? noteTemplateVariables(source, profile) : undefined;
		const single = partCount === 1 && !usesNoteVariable;
		if (single) {
			names.push(sanitizeFileName(withExt, `bundle${extension}`));
			continue;
		}
		const rendered = applyTemplate(profile.output.fileNameTemplate, {
			...variables,
			part: String(i + 1),
			part_padded: String(i + 1).padStart(2, "0"),
			total: String(partCount),
			volume: String(volume),
			volume_total: String(volumeCount),
			...(noteVariables ?? {}),
		}).trim();
		let stem = rendered.toLowerCase().endsWith(extension) ? rendered : `${rendered}${extension}`;
		// Volumes must never collide, even with a template that ignores them.
		if (volumeCount > 1 && !usesVolumeVariable) {
			stem = stem.replace(new RegExp(`${escapeRegExp(extension)}$`), `-v${volume}${extension}`);
		}
		names.push(sanitizeRelativePath(stem, `bundle-${i + 1}${extension}`));
	}
	// Guarantee uniqueness even with a template that ignores {{part}}.
	const seen = new Map<string, number>();
	return names.map((name) => {
		const count = seen.get(name) ?? 0;
		seen.set(name, count + 1);
		if (count === 0) return name;
		return name.replace(/(\.[^.]+)$/, `-${count + 1}$1`);
	});
}

/** `{{note_*}}` variables for a single source note. */
function noteTemplateVariables(path: string, profile: ExportProfile): Record<string, string> {
	const name = basename(path);
	const stem = stripExtension(name);
	const folder = profile.output.mirrorFolders ? parentFolder(path) : "";
	return {
		note_path: joinPath(folder, name),
		note_folder: folder,
		note_title: sanitizeFileName(stem, "note"),
		note_slug: slugify(stem) || "note",
	};
}

/**
 * Sanitizes each segment of a relative path so a template can produce
 * sub-folders (`{{note_folder}}/{{note_title}}`) without escaping the output
 * directory or creating illegal names.
 */
function sanitizeRelativePath(path: string, fallback: string): string {
	const segments = path
		.split("/")
		.map((segment) => sanitizeFileName(segment.replace(/^[.]+$/, ""), ""))
		.filter((segment) => segment !== "");
	if (segments.length === 0) return sanitizeFileName(fallback, "bundle");
	return segments.join("/");
}

function templateVariables(profile: ExportProfile, bundleTitle: string, generatedAt: Date): Record<string, string> {
	const folder = profile.targets.length === 1 ? profile.targets[0] : "vault";
	const date = generatedAt;
	const pad = (n: number) => String(n).padStart(2, "0");
	return {
		folder: folder === "" ? "vault" : sanitizeFileName(stripExtension(basename(folder)) || "vault"),
		profile: sanitizeFileName(profile.name, "profile"),
		profile_id: profile.id,
		title: sanitizeFileName(bundleTitle, "bundle"),
		date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
		time: `${pad(date.getHours())}${pad(date.getMinutes())}`,
		datetime: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`,
		year: String(date.getFullYear()),
		month: pad(date.getMonth() + 1),
		day: pad(date.getDate()),
		notes: "",
	};
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extensionFor(format: ExportProfile["packaging"]["format"]): string {
	switch (format) {
		case "plain":
			return ".txt";
		case "json":
			return ".json";
		case "jsonl":
			return ".jsonl";
		case "xml":
			return ".xml";
		default:
			return ".md";
	}
}

function joinOutputPath(output: ExportProfile["output"], fileName: string): string {
	const folder = normalizeVaultPath(output.folder);
	if (output.destination === "filesystem") {
		const sep = folder === "" ? "" : "/";
		return `${folder}${sep}${fileName}`;
	}
	return folder === "" ? fileName : joinPath(folder, fileName);
}

function normalizeLineEndings(text: string, ending: "lf" | "crlf"): string {
	return ending === "crlf" ? text.replace(/\r?\n/g, "\r\n") : text;
}

function renderPartIndex(
	profile: ExportProfile,
	bundleTitle: string,
	parts: {
		index: number;
		volume: number;
		volumeTotal: number;
		path: string;
		words: number;
		tokens: number;
		sources: string[];
	}[],
	generatedAt: Date,
): string {
	const lines: string[] = [];
	lines.push(`# ${bundleTitle} — parts`, "");
	lines.push(
		`${parts.length} parts · ${formatCount(parts.reduce((acc, p) => acc + p.words, 0))} words · ~${formatCount(
			parts.reduce((acc, p) => acc + p.tokens, 0),
		)} tokens · generated ${generatedAt.toISOString().slice(0, 16).replace("T", " ")}`,
		"",
	);
	lines.push("| # | File | Notes | Words | ~Tokens |", "| --- | --- | --- | --- | --- |");
	let currentVolume = -1;
	for (const part of parts) {
		if (part.volumeTotal > 1 && part.volume !== currentVolume) {
			currentVolume = part.volume;
			lines.push(`| | **Volume ${part.volume} of ${part.volumeTotal}** | | | |`);
		}
		lines.push(`| ${part.index + 1} | \`${basename(part.path)}\` | ${part.sources.length} | ${formatCount(part.words)} | ${formatCount(part.tokens)} |`);
	}
	if (parts.length > 0 && parts[0].volumeTotal > 1) {
		lines.push(
			"",
			`> The destination accepts at most ${profile.limits.maxParts} sources: import one volume at a time.`,
		);
	}
	lines.push("");
	lines.push(`> Profile: **${profile.name}** — ${profile.description || "no description"}`);
	return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/*  Content resolver                                                           */
/* -------------------------------------------------------------------------- */

export function createResolver(deps: ExportDeps, pathIndex: Map<string, string>, files: SourceFile[]): ContentResolver {
	const byPath = new Map(files.map((f) => [f.path.toLowerCase(), f]));
	const nameIndex = buildNameIndex(files.map((f) => f.path));
	const readNote = async (path: string): Promise<string | null> => {
		if (deps.readNote) return deps.readNote(path);
		try {
			return await deps.vault.read(path);
		} catch {
			return null;
		}
	};
	return {
		readNote,
		resolve: (target, fromPath) => resolveLinkTarget(target, fromPath, pathIndex, nameIndex),
		readBinary: async (path) => {
			if (deps.readBinary) return deps.readBinary(path);
			if (deps.vault.readBinary) {
				try {
					return await deps.vault.readBinary(path);
				} catch {
					return null;
				}
			}
			return null;
		},
		isImage: (path) => /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(path),
		sizeOf: (path) => byPath.get(path.toLowerCase())?.size,
	};
}

/* -------------------------------------------------------------------------- */
/*  Budget helpers                                                             */
/* -------------------------------------------------------------------------- */

export function budgetTokensFromProfile(profile: ExportProfile): number {
	if (profile.limits.maxTotalTokens > 0) return profile.limits.maxTotalTokens;
	if (profile.limits.maxTokensPerPart > 0 && profile.limits.maxParts > 0) {
		return profile.limits.maxTokensPerPart * profile.limits.maxParts;
	}
	if (profile.limits.maxWordsPerPart > 0 && profile.limits.maxParts > 0) {
		return Math.round(profile.limits.maxWordsPerPart * profile.limits.maxParts * 1.35);
	}
	if (profile.limits.maxTotalWords > 0) return Math.round(profile.limits.maxTotalWords * 1.35);
	return 0; // unlimited
}

/** Rough size of the JSON block appended to the first part. */
function embeddedManifestTokens(profile: ExportProfile, included: { citationId: string; doc: { file: { path: string } } }[]): number {
	if (!profile.packaging.manifestEmbedded || included.length === 0) return 0;
	const entries = included.map((entry) => `"${entry.citationId}":"${entry.doc.file.path}",`).join("");
	return estimateTokens(entries).tokens + 80; // envelope + stats
}

function chunkingOverhead(profile: ExportProfile): number {
	// Structural overhead of a JSON/XML part (envelope, escaping).
	if (profile.packaging.chunking.mode === "single") return 0;
	return profile.packaging.format === "json" || profile.packaging.format === "xml" ? 60 : 0;
}

/**
 * Pre-flight estimate of what the framing of the bundle costs in tokens:
 * the header, the corpus map, and the per-note contents/citation lines.
 *
 * The per-note part is measured from a representative contents line rather
 * than guessed, and it is charged only for notes that actually make it in
 * (`allocateBudget` handles that), capped by the contents limit.
 */
function estimateOverhead(
	profile: ExportProfile,
	docs: DocAnalysis[],
): { base: number; perNote: number; perIncluded: number; cap: number } {
	let base = 400; // bundle header
	if (profile.packaging.includeKnowledgeMap) base += 900;
	let perNote = 0;
	if (profile.packaging.includeToc) {
		const averageTitle =
			docs.length > 0 ? Math.max(8, Math.round(docs.reduce((acc, doc) => acc + doc.title.length, 0) / docs.length)) : 24;
		const sampleTitle = "word ".repeat(Math.max(1, Math.round(averageTitle / 5))).trim();
		const sample = profile.packaging.citationIds
			? `- \`S01\` ${sampleTitle} — *1 234 words*`
			: `- ${sampleTitle} — *1 234 words*`;
		perNote += estimateTokens(sample).tokens + 1; // the line itself plus its newline
	}
	// What a note costs on top of its body, measured on real bundles: the
	// `## Title` heading, the source line, the divider, the inline citation
	// marker and the note's entry in the embedded manifest.
	let perIncluded = 12;
	if (profile.packaging.citationIds) perIncluded += 5;
	if (profile.packaging.manifestEmbedded) perIncluded += 9;
	// The corpus map lists notes too (reading order, orphans); its entries are
	// what makes a large bundle's preamble grow with the note count.
	if (profile.packaging.includeKnowledgeMap) perIncluded += 6;
	return { base, perNote, perIncluded, cap: profile.packaging.tocMaxEntries };
}

/* -------------------------------------------------------------------------- */
/*  Manifest                                                                   */
/* -------------------------------------------------------------------------- */

function buildManifest(
	profile: ExportProfile,
	title: string,
	stats: PlanStats,
	parts: {
		index: number;
		volume: number;
		volumeTotal: number;
		path: string;
		words: number;
		tokens: number;
		sources: string[];
	}[],
	generatedAt: Date,
	dedupe: DedupeOutcome,
	boilerplateSamples: number,
	deps: ExportDeps,
	warnings: string[],
	hashes: Record<string, string>,
	startedAt: number,
): ExportManifest {
	void title;
	void boilerplateSamples;
	return {
		version: 1,
		plugin: { id: "condensated-vault-exporter", version: deps.pluginVersion ?? "1.0.0" },
		generatedAt: generatedAt.toISOString(),
		profileId: profile.id,
		profileName: profile.name,
		format: profile.packaging.format,
		hashes,
		stats,
		roots: profile.targets,
		parts: parts.map((p) => ({
			index: p.index,
			volume: p.volumeTotal > 1 ? p.volume : undefined,
			path: p.path,
			sources: p.sources.length,
			words: p.words,
			tokens: p.tokens,
		})),
		durationMs: (deps.now?.() ?? Date.now()) - startedAt,
		warnings: [...warnings],
		duplicates: dedupe.groups.length,
	};
}

/**
 * Compares the notes in this bundle with the previous manifest's hashes.
 *
 * The manifest is the export's own record, so the diff has to be computed
 * before the file is replaced — and the hashes it stores must describe *this*
 * run, otherwise the next diff would compare against a run two exports old.
 */
function computeExportDelta(
	hashes: Record<string, string>,
	previous: PreviousManifestLike | null,
): ExportDelta {
	const delta: ExportDelta = { known: previous !== null, added: [], changed: [], removed: [], unchanged: 0 };
	if (!previous) return delta;
	for (const [path, hash] of Object.entries(hashes)) {
		const before = previous.hashes[path];
		if (before === undefined) delta.added.push(path);
		else if (before !== hash) delta.changed.push(path);
		else delta.unchanged++;
	}
	for (const path of Object.keys(previous.hashes)) {
		if (!(path in hashes)) delta.removed.push(path);
	}
	delta.added.sort();
	delta.changed.sort();
	delta.removed.sort();
	return delta;
}

/** The manifest as written to disk: this run's hashes plus the diff summary. */
function withDelta(manifest: ExportManifest, delta: ExportDelta): unknown {
	if (!delta.known) return manifest;
	return {
		...manifest,
		previous: {
			added: delta.added.length,
			changed: delta.changed.length,
			removed: delta.removed.length,
			unchanged: delta.unchanged,
			paths: {
				added: delta.added.slice(0, 50),
				changed: delta.changed.slice(0, 50),
				removed: delta.removed.slice(0, 50),
			},
		},
	};
}

/** Resolves the part budget in tokens for the configured chunking mode. */
export function resolvePartLimit(chunking: ExportProfile["packaging"]["chunking"]): number {
	switch (chunking.mode) {
		case "maxTokens":
			return Math.max(0, chunking.maxTokens);
		case "maxChars":
			return chunking.maxChars > 0 ? Math.round(chunking.maxChars / 3.6) : 0;
		case "maxWords":
			return chunking.maxWords > 0 ? Math.round(chunking.maxWords * 1.35) : 0;
		default:
			return 0;
	}
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function citationIndex(id: string): number {
	const match = /^S(\d+)/.exec(id);
	return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export { ExportCancelledError };
export type { LimitViolation, KnowledgeMap };
