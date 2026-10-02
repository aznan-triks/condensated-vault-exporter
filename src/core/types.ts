/**
 * Condensated Vault Exporter — core domain model.
 *
 * Everything in `src/core` is deliberately free of any Obsidian import so the
 * whole condensation engine can run (and be tested) in a plain Node process.
 * The Obsidian layer plugs into the small `VaultPort` / `SinkPort` interfaces
 * defined here.
 */

/* -------------------------------------------------------------------------- */
/*  Files & vault abstraction                                                  */
/* -------------------------------------------------------------------------- */

export interface SourceFile {
	/** Vault-relative path, always with `/` separators. */
	path: string;
	/** File name including extension. */
	name: string;
	/** Parent folder path ("" for vault root). */
	folder: string;
	/** Lowercase extension without the dot ("" when none). */
	ext: string;
	size: number;
	/** Epoch milliseconds. */
	mtime: number;
	ctime: number;
}

/** Read-only view of a vault used by the engine. */
export interface VaultPort {
	/** Snapshot of every file in the vault (or of every file under `roots`). */
	listFiles(roots?: string[]): Promise<SourceFile[]>;
	/** Read a text file. */
	read(path: string): Promise<string>;
	/** Read binary content as base64 (used only when inlining attachments). */
	readBinary?(path: string): Promise<string>;
	/** Whether the path exists. */
	exists(path: string): Promise<boolean>;
}

/** Destination used by the engine to persist a bundle. */
export interface SinkPort {
	/** Write (creating parent folders as needed) and return the final path. */
	write(path: string, content: string): Promise<string>;
}

export interface CancelSignal {
	readonly cancelled: boolean;
	/** Throws an {@link ExportCancelledError} when cancellation was requested. */
	throwIfCancelled(): void;
	onCancel(cb: () => void): void;
}

export class ExportCancelledError extends Error {
	constructor(message = "Export cancelled") {
		super(message);
		this.name = "ExportCancelledError";
	}
}

/**
 * Thrown when a run is stopped *before* it writes anything (the user declined
 * the overwrite confirmation, for instance). Distinct from cancellation so the
 * UI can explain what happened.
 */
export class ExportAbortedError extends Error {
	constructor(message = "Export aborted") {
		super(message);
		this.name = "ExportAbortedError";
	}
}

/* -------------------------------------------------------------------------- */
/*  File analysis                                                              */
/* -------------------------------------------------------------------------- */

export interface Heading {
	level: number;
	text: string;
	/** 0-based line number of the heading in the source file. */
	line: number;
	/** Slugified anchor, matching Obsidian's `#^block` / `#heading` conventions. */
	slug: string;
}

export interface LinkRef {
	/** Raw link target without `[[ ]]` and without the `#`/`|` suffixes. */
	target: string;
	heading?: string;
	block?: string;
	alias?: string;
	isEmbed: boolean;
	isExternal: boolean;
	url?: string;
}

export interface DocStats {
	/** Characters in the raw file. */
	chars: number;
	/** Characters of prose only (code fences and markup removed). */
	proseChars: number;
	words: number;
	/** Estimated tokens (see {@link estimateTokens}). */
	tokens: number;
	sentences: number;
	lines: number;
	codeLines: number;
	readingMinutes: number;
}

export interface Frontmatter {
	present: boolean;
	/** Parse errors are surfaced instead of thrown. */
	error?: string;
	/** Raw YAML block, without `---` delimiters. */
	raw: string;
	/** Where the block ends (0-based line index of the closing `---` + 1). */
	endLine: number;
	data: Record<string, FrontmatterValue>;
}

export type FrontmatterValue =
	| string
	| number
	| boolean
	| null
	| FrontmatterValue[]
	| { [key: string]: FrontmatterValue };

/** Result of the first analysis pass over one file. */
export interface DocAnalysis {
	file: SourceFile;
	hash: string;
	title: string;
	frontmatter: Frontmatter;
	tags: string[];
	aliases: string[];
	headings: Heading[];
	links: LinkRef[];
	/** Outgoing note links (deduplicated, vault-relative candidates unresolved). */
	outgoing: string[];
	stats: DocStats;
	/**
	 * MinHash signature (32 x 32-bit) over word shingles, used for
	 * near-duplicate detection. Kept tiny so the whole vault fits in memory.
	 */
	shingles: Uint32Array | null;
	/**
	 * Sorted exact shingle hashes, kept for notes with at most
	 * `MAX_EXACT_SHINGLES` shingles: lets duplicate detection compare two short
	 * notes exactly instead of estimating.
	 */
	shingleHashes: Uint32Array | null;
	/**
	 * Number of distinct word shingles: exact for short notes, a tight upper
	 * bound for long ones (used by the containment estimate).
	 */
	shingleCount: number;
	/** Bounded hashes of the note's normalized lines (boilerplate detection). */
	lineHashes: Uint32Array;
	/** Same lines hashed with digits preserved (exact-identity matching). */
	lineExactHashes: Uint32Array;
	/** First normalized lines, kept only for human-readable reports. */
	lineSamples: string[];
	/** Most characteristic terms, used for the knowledge map / tag cloud. */
	topTerms: string[];
	/** Heuristic "signal" score in [0,1]: how much unique substance the note has. */
	signal: number;
	error?: string;
}

/* -------------------------------------------------------------------------- */
/*  Options                                                                    */
/* -------------------------------------------------------------------------- */

export interface NeighbourhoodFilter {
	/** Vault path of the note at the centre. */
	root: string;
	/** Link hops included (0 = the root only). */
	hops: number;
}

export interface FilterOptions {
	/** Keep notes carrying all of these tags. */
	tagsAll: string[];
	/** Keep notes carrying at least one of these tags. */
	tagsAny: string[];
	/** Drop notes carrying any of these tags. */
	tagsNone: string[];
	/** Notes shorter than this many words are treated as empty (0 disables). */
	minWords: number;
	/** Hard lower bound: notes shorter than this are dropped when set. */
	minWordsHard: number | null;
	maxWords: number | null;
	modifiedWithinDays: number | null;
	createdWithinDays: number | null;
	/** Only keep files whose vault path matches this regular expression. */
	pathRegex: string | null;
	/** Require the presence of this frontmatter key. */
	requireFrontmatterKey: string | null;
	/** Never re-ingest the plugin's own previous exports. */
	excludeOutputFolder: boolean;
	/** Also skip the files the user excluded in Obsidian's own settings. */
	respectObsidianIgnore: boolean;
	/** Skip files larger than this (megabytes); 0 = no limit. */
	maxFileMegabytes: number;
	/** Include non-Markdown text files (.txt, .markdown, .svg-as-text…). */
	includeTextFiles: boolean;
	/** Hard cap on the number of notes kept, applied after ordering. */
	maxNotes: number | null;
	skipEmpty: boolean;
	/**
	 * Restrict the export to the link neighbourhood of one note ("this note and
	 * everything it connects to"). `null` exports the whole selection.
	 */
	neighbourhood: NeighbourhoodFilter | null;
}

export type OrderBy =
	| "path"
	| "title"
	| "modified"
	| "created"
	| "words"
	| "frontmatter"
	| "centrality";

export interface OrderOptions {
	by: OrderBy;
	direction: "asc" | "desc";
	/** Frontmatter key used when `by === "frontmatter"`. */
	frontmatterKey: string;
	/** Group notes by their folder before ordering. */
	groupByFolder: boolean;
	/**
	 * Re-order the selection so that similar notes end up next to each other.
	 * Improves retrieval quality of the resulting bundle noticeably.
	 */
	clusterSimilar: boolean;
}

export type FrontmatterMode = "strip" | "keep" | "metadata-card";
export type WikilinkMode = "keep" | "label" | "path" | "remove";
export type EmbedMode = "transclude" | "reference" | "remove";
export type AttachmentMode = "reference" | "inline" | "drop";
export type CodeBlockMode = "keep" | "collapse" | "remove";
export type TagMode = "keep" | "hoist" | "strip";
export type ExternalLinkMode = "keep" | "label" | "strip";

export interface TransformOptions {
	frontmatter: FrontmatterMode;
	/** Frontmatter keys kept when `frontmatter === "metadata-card"` ([] = all). */
	metadataCardFields: string[];
	wikilinks: WikilinkMode;
	embeds: EmbedMode;
	transcludeDepth: number;
	transcludeMaxChars: number;
	attachments: AttachmentMode;
	inlineImageMaxBytes: number;
	codeBlocks: CodeBlockMode;
	stripHtmlComments: boolean;
	stripObsidianComments: boolean;
	stripDataviewBlocks: boolean;
	stripTemplaterExpressions: boolean;
	unwrapCallouts: boolean;
	tags: TagMode;
	externalLinks: ExternalLinkMode;
	collapseBlankLines: number;
	trimTrailingWhitespace: boolean;
	/** Re-level headings so the note title sits at `noteHeadingLevel`. */
	normalizeHeadingLevels: boolean;
	noteHeadingLevel: number;
	/** Drop a leading H1 that merely repeats the note title (avoids duplicates). */
	dedupeTitleHeading: boolean;
	/** Convert `- [ ]` tasks: keep, clear checkboxes, or drop completed ones. */
	taskHandling: "keep" | "clear" | "dropDone";
	/** Prepend a title line when the note has no H1. */
	ensureTitle: boolean;
}

export interface DedupeOptions {
	enabled: boolean;
	/**
	 * `skip` drops near-duplicates entirely, `collapse` keeps a one-line
	 * pointer to the retained copy, `merge` appends the unique lines of the
	 * duplicates to the retained note.
	 */
	mode: "skip" | "collapse" | "merge";
	/** Jaccard similarity in [0,1] above which two notes are duplicates. */
	threshold: number;
	/**
	 * Containment in [0,1] above which a note is treated as an extract of
	 * another one, even when their sizes differ a lot.
	 */
	containmentThreshold: number;
	/** Notes shorter than this are never considered duplicates. */
	minWords: number;
	/** Safety valve: stop comparing after this many candidate pairs. */
	maxPairComparisons?: number;
}

export interface BoilerplateOptions {
	enabled: boolean;
	/** A line must appear in at least this many notes to count as boilerplate. */
	minDocs: number;
	/** Minimum character length for a line to be considered. */
	minLength: number;
	/** Also try to strip repeated multi-line blocks (front/back matter). */
	blocks: boolean;
	/** Never remove more than this share of a note's lines. */
	maxRemovalRatio: number;
}

export interface SummarizeOptions {
	enabled: boolean;
	/** How sentences are picked: leading, tf-scored centroid, or keypoint based. */
	method: "lead" | "centroid" | "keypoints";
	mode: "ratio" | "sentences";
	/** Fraction of sentences to keep when `mode === "ratio"`. */
	ratio: number;
	sentences: number;
	/** Notes shorter than this are never summarized. */
	minWords: number;
	/** Keep the note's headings in the summary so structure survives. */
	keepHeadings: boolean;
}

export interface DropStubsOptions {
	enabled: boolean;
	/** Notes with fewer words than this and no unique content are dropped. */
	maxWords: number;
	/** Only drop when the note is essentially a collection of links. */
	linksOnly: boolean;
}

export interface CondensationOptions {
	dedupe: DedupeOptions;
	boilerplate: BoilerplateOptions;
	summarize: SummarizeOptions;
	dropStubs: DropStubsOptions;
	/** Merge a note's body inline at the position of its embed instead of at its own place. */
	inlineTransclusions: boolean;
}

export type ExportFormat = "markdown" | "plain" | "json" | "jsonl" | "xml";
export interface ChunkOptions {
	mode: ChunkMode;
	maxChars: number;
	maxTokens: number;
	maxWords: number;
	/** Tokens of the previous part repeated at the start of the next one. */
	overlapTokens: number;
	/** When splitting a long note, cut at headings of at most this level. */
	splitAtLevel: number;
	/** Repeat the note header at the top of a continuation part. */
	repeatHeader: boolean;
}

export interface PackagingOptions {
	format: ExportFormat;
	chunking: ChunkOptions;
	includeToc: boolean;
	tocMaxDepth: number;
	/**
	 * Upper bound on the table-of-contents entries written per part. A vault
	 * with thousands of notes would otherwise spend most of the token budget
	 * on a contents list; beyond the cap a single "…and N more" line is
	 * written instead (the manifest always lists everything).
	 */
	tocMaxEntries: number;
	/**
	 * Write `<bundle>.report.md` next to the bundle: what was kept, what was
	 * left out and why, what was cleaned up, and how the result compares to the
	 * destination's limits. The audit trail for a lossy export.
	 */
	reportFile: boolean;
	/** Prefix the bundle with a generated map of the corpus. */
	includeKnowledgeMap: boolean;
	/** Append a glossary harvested from definition-style lines. */
	includeGlossary: boolean;
	/** Stable per-source citation ids (`[S07]`) usable by the model. */
	citationIds: boolean;
	headerTemplate: string;
	footerTemplate: string;
	/** Separator inserted between two notes (supports `{{...}}` variables). */
	divider: string;
	/** Heading level assigned to each note title. */
	noteHeadingLevel: number;
	includeManifest: boolean;
	manifestEmbedded: boolean;
	manifestSidecar: boolean;
	/**
	 * Write a paste-ready "custom instructions" file next to the bundle: what
	 * the corpus is, how to cite it, and what it can be asked. Destinations
	 * such as NotebookLM have a dedicated instructions field for exactly this.
	 */
	instructionsFile: boolean;
	lineEnding: "lf" | "crlf";
}

export type OutputDestination = "vault" | "filesystem" | "clipboard";
export type IncrementalMode = "off" | "delta";

export interface OutputOptions {
	destination: OutputDestination;
	/** Vault-relative folder, or absolute path when destination is `filesystem`. */
	folder: string;
	/**
	 * Supports `{{folder}}`, `{{profile}}`, `{{date:FORMAT}}`, `{{part}}`,
	 * `{{total}}`, `{{volume}}` — and, for one-file-per-note exports,
	 * `{{note_path}}`, `{{note_folder}}`, `{{note_title}}` and `{{note_slug}}`.
	 */
	fileNameTemplate: string;
	/**
	 * One directory per note, mirroring the vault tree (per-note exports).
	 * `{{note_path}}` in the file name template implies the same layout.
	 */
	mirrorFolders: boolean;
	/** Only export notes added/changed since the last run of this profile. */
	incremental: IncrementalMode;
	/** Reveal the produced file(s) after the export. */
	openAfterExport: boolean;
	/** Attach the bundle to the clipboard as well. */
	alsoCopyToClipboard: boolean;
}

export interface ExportProfile {
	id: string;
	name: string;
	description: string;
	/** Built-in profiles cannot be deleted (they can be duplicated). */
	builtin?: boolean;
	/** Folders or files to export ("" = vault root). */
	targets: string[];
	/** Recursion depth: -1 = unlimited, 0 = only the target folder's files. */
	depth: number;
	include: string[];
	exclude: string[];
	filters: FilterOptions;
	order: OrderOptions;
	transform: TransformOptions;
	condensation: CondensationOptions;
	packaging: PackagingOptions;
	output: OutputOptions;
	/** Optional hard caps emulating the limits of a target tool. */
	limits: BundleLimits;
}

export interface BundleLimits {
	/** Max parts (sources) the destination accepts; 0 = unlimited. */
	maxParts: number;
	/** Max words per part; 0 = unlimited. */
	maxWordsPerPart: number;
	/** Max tokens per part; 0 = unlimited. */
	maxTokensPerPart: number;
	/** Max total words; 0 = unlimited. */
	maxTotalWords: number;
	/** Max total tokens; 0 = unlimited. */
	maxTotalTokens: number;
	/** Max file size in megabytes per part; 0 = unlimited. */
	maxMegabytesPerPart: number;
	/** Label of the tool these limits emulate (used in warnings). */
	label: string;
}

export type ChunkMode = "single" | "maxChars" | "maxTokens" | "maxWords" | "perNote" | "perFolder";

/* -------------------------------------------------------------------------- */
/*  Plan / result                                                              */
/* -------------------------------------------------------------------------- */

export interface PlannedDoc {
	analysis: DocAnalysis;
	/** Index inside the ordered selection. */
	index: number;
	/** Stable citation id, e.g. `S07`. */
	citationId: string;
	/** Set when the note was removed as a near-duplicate of another one. */
	duplicateOf?: string;
	summaryOf?: string;
}

export interface PlanStats {
	discovered: number;
	kept: number;
	droppedByFilter: number;
	droppedAsDuplicate: number;
	droppedAsStub: number;
	droppedAsUnreadable: number;
	words: number;
	tokens: number;
	chars: number;
	boilerplateLines: number;
	summarized: number;
}

export interface CondensedDoc {
	path: string;
	title: string;
	citationId: string;
	body: string;
	/** Rendered heading for the note. */
	heading: string;
	words: number;
	tokens: number;
	chars: number;
	frontmatter: Record<string, FrontmatterValue>;
	summaryApplied: boolean;
	duplicateOf?: string;
}

export interface BundlePart {
	index: number;
	total: number;
	/** 1-based volume (a source-sized group of parts) — 1 when there is only one. */
	volume: number;
	volumeTotal: number;
	path: string;
	content: string;
	chars: number;
	words: number;
	tokens: number;
	/** Source paths contained in this part. */
	sources: string[];
	/** Non-fatal problems encountered while producing this part. */
	warnings: string[];
}

export interface ExportManifest {
	version: 1;
	plugin: { id: string; version: string };
	generatedAt: string;
	profileId: string;
	profileName: string;
	format: ExportFormat;
	/** sha256 of each source path (path -> hash). */
	hashes: Record<string, string>;
	stats: PlanStats;
	roots: string[];
	parts: { index: number; path: string; sources: number; words: number; tokens: number }[];
	/** Wall-clock duration of the export, in milliseconds. */
	durationMs: number;
	/** Non-fatal problems encountered during the run. */
	warnings: string[];
	/** Number of duplicate groups collapsed in this run. */
	duplicates: number;
}

export interface ChunkDiagnostics {
	/** Part budget in tokens (0 = unlimited). */
	partLimitTokens: number;
	/** Tokens of the header, part notice, footer and dividers of one part. */
	overheadTokens: number;
	/** Tokens available to the actual content of one part. */
	packLimitTokens: number;
	/** Units handed to the chunker (preamble + documents). */
	units: number;
	/** Tokens of the largest unit before splitting. */
	largestUnitTokens: number;
}

export interface ExportResult {
	parts: BundlePart[];
	manifest: ExportManifest;
	stats: PlanStats;
	warnings: string[];
	/** Paths written to disk (bundle parts + sidecars). */
	written: string[];
	/** How the part limit was spent — shown in the preview and diagnostics. */
	chunking: ChunkDiagnostics;
	/**
	 * Paste-ready instructions for the destination model, when the profile asks
	 * for them (or the caller wants to offer them).
	 */
	instructions?: string;
	/** Human-readable account of what the export did (see `pack/report.ts`). */
	report?: string;
	/** How the bundled notes differ from the previous export's manifest. */
	delta?: ExportDelta;
}

/** Difference between this run and the previous one, note by note. */
export interface ExportDelta {
	/** The previous manifest was found and could be compared. */
	known: boolean;
	/** Paths in this bundle that the previous manifest did not contain. */
	added: string[];
	/** Paths whose content hash changed. */
	changed: string[];
	/** Paths the previous manifest contained and this bundle does not. */
	removed: string[];
	/** Number of notes present with an identical hash. */
	unchanged: number;
}

export interface ProgressEvent {
	phase: "discover" | "analyze" | "condense" | "render" | "write" | "done";
	/** 0..1, or -1 when the total is not yet known. */
	progress: number;
	message: string;
	/** Number of files processed so far, when relevant. */
	current?: number;
	total?: number;
}

export type ProgressReporter = (event: ProgressEvent) => void;

/* -------------------------------------------------------------------------- */
/*  Persisted state                                                            */
/* -------------------------------------------------------------------------- */

export interface CachedDocInfo {
	hash: string;
	mtime: number;
	size: number;
	words: number;
	tokens: number;
	/** Last time this file appeared in an export of the given profile. */
	lastExportedAt?: number;
}

export interface ExportHistoryEntry {
	profileId: string;
	generatedAt: string;
	outputs: string[];
	notes: number;
	words: number;
	tokens: number;
	parts: number;
	durationMs: number;
}
