/**
 * Pass 1: turn a raw note into a compact, comparable {@link DocAnalysis}.
 *
 * The analyzer is intentionally lossless-free: it never keeps the note text so
 * that even a 10 000-note vault fits comfortably in memory. Everything it
 * retains is a bounded structure (headings, links, a 128-byte MinHash
 * signature, line hashes, top terms).
 */

import { estimateTokens } from "../tokens";
import type {
	DocAnalysis,
	DocStats,
	Frontmatter,
	Heading,
	LinkRef,
	SourceFile,
} from "../types";
import { asDate, asStringArray, normalizeTag, parseFrontmatter } from "../frontmatter";
import { contentHash, hash32, slugify, unique } from "../util";
import { type LineSink } from "../condense/boilerplate";
import { extractLinksFromLine } from "./links";
import {
	countWords,
	indentWidth,
	isListItem,
	isTaskItem,
	matchBlockquote,
	matchHeading,
	scanLines,
	stripInlineMarkup,
} from "./syntax";

import { collectTerms, rankTerms, STOP_WORDS } from "../intel/terms";

/** Number of 32-bit hashes in a MinHash signature. */
export const SHINGLE_SIZE = 32;

/** Word-shingle length used for near-duplicate detection. */
export const SHINGLE_K = 8;
/**
 * Notes with at most this many shingles also keep their exact shingle hashes,
 * which turns duplicate detection from an estimate into an exact comparison
 * (and makes containment — "is this note an extract of that one?" — reliable
 * instead of noisy). ~1 KB per note.
 */
export const MAX_EXACT_SHINGLES = 512;

import {
	MIN_BOILERPLATE_LINE_LENGTH,
	canonicalizeLine,
	hashCanonicalLine,
	hashExactLine,
} from "../condense/boilerplate";

export interface AnalyzeOptions {
	/** Frontmatter keys holding tags. */
	tagKeys?: string[];
	/** Frontmatter keys holding aliases. */
	aliasKeys?: string[];
	/** Frontmatter keys holding a title. */
	titleKeys?: string[];
	/** Frontmatter keys holding a creation date. */
	createdKeys?: string[];
	/** Sink receiving normalized lines (used for corpus boilerplate detection). */
	lineSink?: LineSink;
	/** Lines shorter than this are never considered boilerplate candidates. */
	minLineLength?: number;
}

type ResolvedOptions = Required<Omit<AnalyzeOptions, "lineSink">>;

const DEFAULT_OPTIONS: ResolvedOptions = {
	tagKeys: ["tags", "tag", "keywords"],
	aliasKeys: ["aliases", "alias"],
	titleKeys: ["title", "name"],
	createdKeys: ["created", "date", "created_at", "ctime"],
	minLineLength: MIN_BOILERPLATE_LINE_LENGTH,
};

export function analyzeDocument(file: SourceFile, text: string, options: AnalyzeOptions = {}): DocAnalysis {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const sink = opts.lineSink;
	sink?.beginDocument();
	const lines = scanLines(text);
	const frontmatter = parseFrontmatter(text);
	const bodyStart = frontmatter.present ? frontmatter.endLine : 0;

	const headings: Heading[] = [];
	const links: LinkRef[] = [];
	const inlineTags: string[] = [];
	const proseParts: string[] = [];
	/** Raw lines eligible for boilerplate detection (bounded). */
	const candidateLines: string[] = [];
	const wordFrequencies = new Map<string, number>();
	let codeLines = 0;
	let proseWords = 0;
	let sentenceCount = 0;
	let firstH1: string | undefined;
	let title: string | undefined;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (i < bodyStart) continue;

		if (line.kind === "code" || line.kind === "fence") {
			codeLines++;
			continue;
		}

		const heading = matchHeading(line.text);
		if (heading) {
			headings.push({ level: heading.level, text: heading.text, line: i, slug: slugify(heading.text) });
			if (heading.level === 1 && firstH1 === undefined) firstH1 = heading.text;
		}

		const extracted = extractLinksFromLine(line.text);
		for (const link of extracted.links) links.push(link);
		for (const tag of extracted.tags) inlineTags.push(tag);

		const quoted = matchBlockquote(line.text);
		const content = quoted ? quoted.text : line.text;
		// Strip a leading list bullet / task marker before measuring prose.
		const withoutMarker = content.replace(/^\s*(?:[-*+]|\d+[.)])\s+(\[[ xX/\-]\]\s*)?/, "");
		const plain = stripInlineMarkup(withoutMarker).trim();

		if (plain !== "") {
			proseParts.push(plain);
			const words = countWords(plain);
			proseWords += words;
			sentenceCount += Math.max(1, (plain.match(/[.!?…](\s|$)/g) ?? []).length);
			collectTerms(plain, wordFrequencies);
		}
		if (
			line.kind === "text" &&
			line.text.trim() !== "" &&
			line.text.length <= 300 &&
			line.text.trim().length >= opts.minLineLength &&
			candidateLines.length < MAX_NORMALIZED_LINES
		) {
			candidateLines.push(line.text);
		}
	}

	const tagSet = new Map<string, string>();
	for (const key of opts.tagKeys) {
		for (const value of asStringArray(frontmatter.data[key])) tagSet.set(normalizeTag(value).toLowerCase(), normalizeTag(value));
	}
	for (const tag of inlineTags) tagSet.set(normalizeTag(tag).toLowerCase(), normalizeTag(tag));
	const tags = Array.from(tagSet.values()).sort((a, b) => a.localeCompare(b));

	const aliases: string[] = [];
	for (const key of opts.aliasKeys) for (const value of asStringArray(frontmatter.data[key])) aliases.push(value);

	for (const key of opts.titleKeys) {
		const value = frontmatter.data[key];
		if (typeof value === "string" && value.trim() !== "") {
			title = value.trim();
			break;
		}
	}
	if (!title && firstH1) title = firstH1;
	if (!title) title = file.name.replace(/\.[^.]+$/, "");

	const proseText = proseParts.join("\n");
	const stats = buildStats(text, proseText, proseWords, sentenceCount, lines.length, codeLines, file.size);
	const outgoing = unique(
		links
			.filter((l) => !l.isExternal && l.target !== "")
			.map((l) => l.target),
	);

	const lineHashes = new Uint32Array(candidateLines.length);
	const lineExactHashes = new Uint32Array(candidateLines.length);
	const canonicalLines: string[] = new Array(candidateLines.length);
	for (let i = 0; i < candidateLines.length; i++) {
		const canonical = canonicalizeLine(candidateLines[i]);
		canonicalLines[i] = canonical;
		const hash = hashCanonicalLine(canonical);
		lineHashes[i] = hash;
		lineExactHashes[i] = hashExactLine(candidateLines[i]);
		sink?.addLine(hash, canonical, { exactHash: lineExactHashes[i] });
	}
	const lineSamples = canonicalLines.slice(0, MAX_LINE_SAMPLES);
	sink?.endDocument();

	const { shingles, shingleHashes, wordCount, shingleCount } = buildSignature(proseText);
	const signal = computeSignal({
		words: wordCount,
		proseWords,
		totalWords: stats.words,
		linkCount: links.filter((l) => !l.isExternal).length,
		headingCount: headings.length,
		codeLines,
		lineCount: lines.length,
		taskCount: lines.filter((l) => isTaskItem(l.text)).length,
		listCount: lines.filter((l) => isListItem(l.text)).length,
	});

	const createdFromFrontmatter = createdTimestamp(frontmatter, opts.createdKeys);
	const effectiveFile: SourceFile = createdFromFrontmatter
		? { ...file, ctime: Math.min(file.ctime || createdFromFrontmatter, createdFromFrontmatter) }
		: file;

	return {
		file: effectiveFile,
		hash: contentHash(text),
		title,
		frontmatter,
		tags,
		aliases,
		headings,
		links,
		outgoing,
		stats,
		shingles,
		shingleHashes,
		shingleCount,
		lineHashes,
		lineExactHashes,
		lineSamples,
		topTerms: rankTerms(wordFrequencies, 14),
		signal,
		error: frontmatter.error,
	};
}

function createdTimestamp(fm: Frontmatter, keys: string[]): number | undefined {
	for (const key of keys) {
		const ts = asDate(fm.data[key]);
		if (ts !== undefined) return ts;
	}
	return undefined;
}

function buildStats(
	raw: string,
	prose: string,
	proseWords: number,
	sentences: number,
	lineCount: number,
	codeLines: number,
	size: number,
): DocStats {
	const tokens = estimateTokens(raw);
	return {
		chars: raw.length || size,
		proseChars: prose.length,
		words: proseWords,
		tokens: tokens.tokens,
		sentences: Math.max(sentences, proseWords > 0 ? 1 : 0),
		lines: lineCount,
		codeLines,
		readingMinutes: Math.max(0, Math.round((proseWords / 225) * 10) / 10),
	};
}

const MAX_NORMALIZED_LINES = 400;
const MAX_LINE_SAMPLES = 24;


/**
 * Builds the MinHash signature of the note: signature[i] is the minimum hash
 * obtained by applying the i-th permutation (simulated by seeding) to all
 * k-word shingles. Jaccard similarity between two notes is then estimated by
 * the fraction of equal slots.
 */
function buildSignature(text: string): {
	shingles: Uint32Array | null;
	shingleHashes: Uint32Array | null;
	wordCount: number;
	shingleCount: number;
} {
	const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
	const wordCount = words.length;
	if (wordCount < SHINGLE_K * 2) return { shingles: null, shingleHashes: null, wordCount, shingleCount: 0 };

	const signature = new Uint32Array(SHINGLE_SIZE).fill(0xffffffff);
	const shingle = new Array<string>(SHINGLE_K);
	const distinct = new Set<number>();
	for (let i = 0; i + SHINGLE_K <= words.length; i++) {
		for (let k = 0; k < SHINGLE_K; k++) shingle[k] = words[i + k];
		const text2 = shingle.join(" ");
		for (let s = 0; s < SHINGLE_SIZE; s++) {
			const h = hash32(text2, s * 0x9e3779b1);
			if (h < signature[s]) signature[s] = h;
		}
		if (distinct.size <= MAX_EXACT_SHINGLES) distinct.add(hash32(text2, 0x51ed2701));
	}
	const exact = distinct.size <= MAX_EXACT_SHINGLES;
	const hashes = exact ? Uint32Array.from([...distinct].sort((a, b) => a - b)) : null;
	// For long notes the distinct count is no longer tracked exactly (the set is
	// capped for memory reasons); the number of shingle positions is a tight
	// upper bound and only feeds the approximate containment estimate.
	const shingleCount = exact ? distinct.size : Math.max(0, wordCount - SHINGLE_K + 1);
	return { shingles: signature, shingleHashes: hashes, wordCount, shingleCount };
}

interface SignalInput {
	words: number;
	proseWords: number;
	totalWords: number;
	linkCount: number;
	headingCount: number;
	codeLines: number;
	lineCount: number;
	taskCount: number;
	listCount: number;
}

/**
 * Local "how much is there to learn here" score in [0,1].
 *
 * It is deliberately cheap and interpretable: length on a log scale, prose
 * density, structural richness (headings/code), and penalties for notes that
 * are mostly link lists, task dumps or tag clouds.
 */
function computeSignal(input: SignalInput): number {
	const lengthScore = Math.min(1, Math.log10(Math.max(1, input.proseWords) + 1) / 2.6); // ~400 words → 1
	const proseRatio = input.totalWords > 0 ? input.proseWords / input.totalWords : 0;
	const linkDensity = input.totalWords > 0 ? input.linkCount / Math.max(1, input.totalWords / 20) : 0;
	const structureScore = Math.min(1, (input.headingCount * 0.12 + (input.codeLines > 0 ? 0.25 : 0)) / 0.9);
	const listRatio = input.lineCount > 0 ? input.listCount / input.lineCount : 0;
	const taskRatio = input.lineCount > 0 ? input.taskCount / input.lineCount : 0;

	const penalty = Math.min(0.55, linkDensity * 0.3 + listRatio * 0.2 + taskRatio * 0.35);
	const raw = lengthScore * 0.5 + proseRatio * 0.24 + structureScore * 0.26;
	return Math.max(0, Math.min(1, raw - penalty));
}

/* -------------------------------------------------------------------------- */
/*  Minimal perfect "signature" helpers                                        */
/* -------------------------------------------------------------------------- */

/**
 * Estimated Jaccard similarity between two MinHash signatures.
 * Returns 0 when either note is too short to have a signature.
 */
/** MinHash + containment report for two notes. */
export interface SignatureComparison {
	/** Estimated Jaccard similarity (0-1). */
	jaccard: number;
	/** Estimated share of the smaller note's shingles that the larger one also has (0-1). */
	containment: number;
}

/**
 * Compares two MinHash signatures. Slot equality estimates the Jaccard index.
 * Containment is derived from it with the sizes of both shingle sets, which is
 * exactly what distinguishes "a copy of the note" (Jaccard 0.4, containment 1)
 * from "two notes that share a paragraph" (Jaccard 0.4, containment 0.4).
 */
export function compareSignatures(
	a: Uint32Array | null,
	b: Uint32Array | null,
	shinglesA = 0,
	shinglesB = 0,
): SignatureComparison {
	if (!a || !b) return { jaccard: 0, containment: 0 };
	let equal = 0;
	for (let i = 0; i < SHINGLE_SIZE; i++) if (a[i] === b[i]) equal++;
	const jaccard = equal / SHINGLE_SIZE;
	if (jaccard <= 0) return { jaccard: 0, containment: 0 };
	const smaller = Math.min(shinglesA, shinglesB);
	if (smaller <= 0) return { jaccard, containment: jaccard };
	// |A∩B| = J·(|A|+|B|)/(1+J), so containment in the smaller set follows.
	const intersection = Math.min(smaller, (jaccard * (shinglesA + shinglesB)) / (1 + jaccard));
	return { jaccard, containment: Math.min(1, intersection / smaller) };
}

export function signatureSimilarity(a: Uint32Array | null, b: Uint32Array | null): number {
	if (!a || !b || a.length !== b.length) return 0;
	let equal = 0;
	for (let i = 0; i < a.length; i++) if (a[i] === b[i]) equal++;
	return equal / a.length;
}

/** Containment estimate: |A∩B| / min(|A|,|B|), approximated from signatures. */
export function signatureContainment(a: Uint32Array | null, b: Uint32Array | null): number {
	return signatureSimilarity(a, b);
}

/** Indentation-aware link-list detection used by the stub dropper. */
export function isMostlyLinks(text: string): boolean {
	const lines = scanLines(text);
	let considered = 0;
	let linkOnly = 0;
	for (const line of lines) {
		if (line.kind !== "text") continue;
		const trimmed = line.text.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		considered++;
		const withoutList = trimmed.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
		const stripped = stripInlineMarkup(withoutList).replace(/[\s\-–—•*+.,;:()[\]{}|]/g, "");
		const hasLink = withoutList.includes("[[") || /\]\(/.test(withoutList);
		if (hasLink && stripped.length <= 12) linkOnly++;
		else if (stripped.length <= 3 && hasLink) linkOnly++;
	}
	if (considered === 0) return true;
	return linkOnly / considered >= 0.6;
}

export function indentationOf(line: string): number {
	return indentWidth(line);
}
