/**
 * Corpus-wide boilerplate detection.
 *
 * Export 300 daily notes and most of the bundle is the same template:
 * "## Gratitude", "## Tasks", the same dataview block, the same footer. This
 * module finds lines that appear in a large share of the notes and removes
 * them during the transform pass — a compression that is only possible when
 * the whole corpus is considered at once.
 *
 * Nothing is retained in memory: the analyzer pushes hashed lines into a
 * {@link LineSink} while it works, and the transform pass re-hashes the lines
 * of each note (before any markup rewriting) to decide what to drop.
 */

import { hash32 } from "../util";
import { stripInlineMarkup } from "../markdown/syntax";
import type { BoilerplateOptions } from "../types";

export type { BoilerplateOptions };

/** Cap on the number of lines pushed to a sink per document. */
export const MAX_SINK_LINES = 400;
/** Lines shorter than this are too generic to be treated as boilerplate. */
export const MIN_BOILERPLATE_LINE_LENGTH = 8;

/**
 * Receives normalized lines while documents are analysed. Implementations
 * must not retain the raw text longer than the current document.
 */
export interface LineIdentity {
	/** Hash of the line with digits preserved (exact-identity matching). */
	exactHash: number;
	/** True when the raw line contained no digit. */
	digitFree: boolean;
}

export interface LineSink {
	beginDocument(): void;
	addLine(hash: number, text?: string, identity?: LineIdentity): void;
	endDocument(): void;
}

/** Normalizes a line, keeping digits: the "exact" identity of a line. */
export function normalizeExact(raw: string): string {
	return stripInlineMarkup(raw)
		.replace(/\s+/g, " ")
		.replace(/[*_`~]/g, "")
		.toLowerCase()
		.trim()
		.slice(0, 160);
}

/** Normalizes a line, replacing digits with `#`: the "template" identity. */
export function normalizeLine(line: string): string {
	return normalizeExact(line).replace(/\d+/g, "#");
}

/**
 * Canonical form of a raw line: markup is stripped first so that the same
 * sentence written `**bold**` in one note and plain in another still matches.
 * This exact function must be used by pass 1 (collection), pass 2 (stripping)
 * and the analysis cache, otherwise nothing ever matches.
 */
export function canonicalizeLine(raw: string): string {
	return normalizeLine(stripInlineMarkup(raw));
}

/** Hash of a raw line's template identity (digits replaced by `#`). */
export function hashBoilerplateLine(raw: string): number {
	return hash32(canonicalizeLine(raw), 0x51ed);
}

/** Hash of a raw line's exact identity (digits preserved). */
export function hashExactLine(raw: string): number {
	return hash32(normalizeExact(raw), 0x9371);
}

/** True when the raw line contains a digit. */
export function lineHasDigits(raw: string): boolean {
	return /\d/.test(raw);
}

/** Hash of an already canonical line (used when re-feeding a cached analysis). */
export function hashCanonicalLine(canonical: string): number {
	return hash32(canonical, 0x51ed);
}

export interface BoilerplateResult {
	/**
	 * Template hashes (digits → `#`) of digit-free lines repeated across notes.
	 * Safe to remove without checking the exact text.
	 */
	hashes: Set<number>;
	/**
	 * Exact hashes of lines that are byte-identical across notes. Used for
	 * lines that contain digits, where the template form alone is too weak a
	 * signal (see {@link stripBoilerplate}).
	 */
	exactHashes: Set<number>;
	/** Human-readable samples, for reporting (bounded). */
	samples: { text: string; docs: number }[];
	/** Number of documents that contributed lines. */
	documents: number;
	/** Total number of lines examined. */
	lines: number;
}

const MAX_SAMPLES = 120;
/** Upper bound for the internal counters, to stay memory-safe on huge vaults. */
const MAX_TRACKED_LINES = 400_000;

export class BoilerplateAccumulator implements LineSink {
	private counts = new Map<number, number>();
	private exactCounts = new Map<number, number>();
	private texts = new Map<number, string>();
	private seenInDoc = new Set<number>();
	private seenExactInDoc = new Set<number>();
	private documents = 0;
	private totalLines = 0;
	private overflow = false;

	constructor(private readonly options: BoilerplateOptions) {}

	beginDocument(): void {
		this.documents++;
		if (this.seenInDoc.size > 0) this.seenInDoc = new Set<number>();
		if (this.seenExactInDoc.size > 0) this.seenExactInDoc = new Set<number>();
	}

	addLine(hash: number, text?: string, identity?: LineIdentity): void {
		if (!this.seenInDoc.has(hash)) {
			this.seenInDoc.add(hash);
			this.totalLines++;
			if (this.counts.size < MAX_TRACKED_LINES || this.counts.has(hash)) {
				this.counts.set(hash, (this.counts.get(hash) ?? 0) + 1);
			} else {
				this.overflow = true;
			}
			if (text !== undefined && this.texts.size < MAX_SAMPLES * 4 && !this.texts.has(hash)) {
				this.texts.set(hash, text.length > 120 ? text.slice(0, 117) + "…" : text);
			}
		}
		if (identity !== undefined && !this.seenExactInDoc.has(identity.exactHash)) {
			this.seenExactInDoc.add(identity.exactHash);
			this.exactCounts.set(identity.exactHash, (this.exactCounts.get(identity.exactHash) ?? 0) + 1);
		}
	}

	/** Feeds an already-analyzed document (used with the analysis cache). */
	addDocument(doc: {
		lineHashes: Uint32Array;
		lineExactHashes?: Uint32Array;
		lineDigitFree?: Uint8Array;
		lineSamples: string[];
	}): void {
		this.beginDocument();
		const byHash = new Map<number, string>();
		for (const sample of doc.lineSamples) byHash.set(hashCanonicalLine(sample), sample);
		for (let i = 0; i < doc.lineHashes.length; i++) {
			const hash = doc.lineHashes[i];
			const exactHash = doc.lineExactHashes?.[i];
			this.addLine(
				hash,
				byHash.get(hash),
				exactHash === undefined ? undefined : { exactHash, digitFree: doc.lineDigitFree?.[i] === 1 },
			);
		}
		this.endDocument();
	}

	endDocument(): void {
		this.seenInDoc.clear();
		this.seenExactInDoc.clear();
	}

	/** Number of documents fed so far. */
	get documentCount(): number {
		return this.documents;
	}

	/** True when the line table saturated (very large corpus). */
	get saturated(): boolean {
		return this.overflow;
	}

	finish(): BoilerplateResult {
		const hashes = new Set<number>();
		const exactHashes = new Set<number>();
		const samples: { text: string; docs: number }[] = [];
		if (!this.options.enabled || this.documents < 2) {
			return { hashes, exactHashes, samples, documents: this.documents, lines: this.totalLines };
		}
		const minDocs = Math.max(2, Math.min(this.options.minDocs, this.documents));
		for (const [hash, count] of this.counts) {
			if (count < minDocs) continue;
			// Whether a shared template may actually be removed depends on the
			// digits it contains, which only the raw text knows — see
			// `stripBoilerplate`. Here every frequent template is recorded.
			hashes.add(hash);
			const text = this.texts.get(hash);
			if (text !== undefined && samples.length < MAX_SAMPLES) samples.push({ text, docs: count });
		}
		// Verbatim repetitions (digits included) are removed as well, but the
		// same `minDocs` bar applies: two notes sharing one sentence is not
		// necessarily a template.
		for (const [hash, count] of this.exactCounts) {
			if (count >= minDocs) exactHashes.add(hash);
		}
		samples.sort((a, b) => b.docs - a.docs);
		return { hashes, exactHashes, samples, documents: this.documents, lines: this.totalLines };
	}
}

export interface StripResult {
	text: string;
	removedLines: number;
}

/**
 * Removes boilerplate lines from a note body (must run *before* any markup
 * transformation, so that line hashes match the ones collected in pass 1).
 */
export function stripBoilerplate(
	text: string,
	hashes: Set<number>,
	options: BoilerplateOptions,
	exactHashes?: Set<number>,
): StripResult {
	if (!options.enabled || (hashes.size === 0 && (exactHashes?.size ?? 0) === 0)) return { text, removedLines: 0 };
	const lines = text.split("\n");
	const isBoiler = new Array<boolean>(lines.length).fill(false);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed.length < options.minLength) continue;
		if (line.length > 400) continue;
		const hasDigits = lineHasDigits(line);
		// Verbatim repetitions are boilerplate no matter what they contain.
		if (exactHashes && exactHashes.size > 0 && exactHashes.has(hashExactLine(line))) {
			isBoiler[i] = true;
			continue;
		}
		// A digit-free template match is safe; a line whose digits vary between
		// notes ("Day 1", "Score: 12") is kept, because the number is content.
		if (!hasDigits && hashes.size > 0 && hashes.has(hashBoilerplateLine(line))) isBoiler[i] = true;
	}

	if (options.blocks) {
		let i = 0;
		while (i < lines.length) {
			if (!isBoiler[i]) {
				i++;
				continue;
			}
			let lastContent = i;
			let j = i;
			while (j < lines.length && (isBoiler[j] || lines[j].trim() === "")) {
				if (lines[j].trim() !== "") lastContent = j;
				j++;
			}
			// A run of >= 2 boilerplate lines is a template block: drop it whole.
			if (lastContent - i + 1 >= 2) {
				for (let k = i; k <= lastContent; k++) isBoiler[k] = true;
			}
			i = j;
		}
	}

	const keep: string[] = [];
	let removed = 0;
	for (let i = 0; i < lines.length; i++) {
		if (isBoiler[i]) removed++;
		else keep.push(lines[i]);
	}
	const total = lines.length;
	if (total > 0 && removed / total > options.maxRemovalRatio) {
		// Safety: never gut a note entirely.
		return { text, removedLines: 0 };
	}
	if (removed === 0) return { text, removedLines: 0 };
	return { text: keep.join("\n"), removedLines: removed };
}

/** Convenience helper for the transform pass. */
export function boilerplateLineHasher(): (line: string) => number {
	return hashBoilerplateLine;
}
