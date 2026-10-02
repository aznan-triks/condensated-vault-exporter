/**
 * Corpus-aware keyword extraction.
 *
 * Pass 1 already extracts a note's most frequent terms. Document frequency
 * across the whole selection then turns "frequent" into "characteristic":
 * a term that shows up in every note says nothing about any of them, while a
 * term appearing in three notes is exactly what the model needs to connect
 * them. This is TF-IDF with the IDF estimated from the per-note term lists —
 * cheap, bounded, and good enough to label themes and build a glossary.
 */

import type { DocAnalysis } from "../types";

export interface TermWeight {
	term: string;
	weight: number;
}

export interface KeyTermsResult {
	/** path -> distinctive terms, best first. */
	byPath: Map<string, TermWeight[]>;
	/** Corpus-wide term document frequency. */
	documentFrequency: Map<string, number>;
	/** Terms ordered by how characteristic they are of the corpus. */
	topTerms: TermWeight[];
}

export interface KeyTermsOptions {
	/** Terms appearing in more than this share of notes are considered noise. */
	maxDocumentRatio: number;
	/** Terms must appear in at least this many notes. */
	minDocuments: number;
	/** How many terms to keep per note. */
	perNote: number;
}

const DEFAULT_OPTIONS: KeyTermsOptions = { maxDocumentRatio: 0.6, minDocuments: 1, perNote: 8 };

const MAX_TERM_LENGTH = 40;

export const STOP_WORDS = new Set(
	(
		"a about above after again against all also am an and another any are as at au aux avec avoir be because been " +
		"before being below between both but by can cannot ce ces cette chez comme could d dans de des did do does doing " +
		"done down du during each elle elles en encore est et etre être eux few for from further had has have having he " +
		"her here hers herself him himself his how however i if il ils in into is it its itself je just l la le les " +
		"leur leurs like lui mais me meme même mes might moi mon more most much must my myself ne no nor nos not nous of " +
		"off on once only ont or other ou où our ours ourselves out over own par pas plus pour qu que quel quelle qui sa " +
		"sans se ses she should si so some son sont sous such sur ta te than that the their theirs them themselves then " +
		"there these they this those through to too ton tous tout toute tres très tu under un une until up very was we " +
		"were what when where which while who whom why will with would you your yours yourself vous votre yet aussi cela " +
		"donc alors toujours jamais rien tout tous autre autres fait faire peut sont etre entre selon depuis pendant"
	).split(/[\s,]+/),
);


/** Extracts the meaningful words of `text` into `frequencies`. */
export function collectTerms(text: string, frequencies: Map<string, number>): void {
	const matches = text.toLowerCase().match(/[\p{L}][\p{L}\p{N}'’-]{2,}/gu);
	if (!matches) return;
	for (const raw of matches) {
		if (raw.length > MAX_TERM_LENGTH) continue;
		if (STOP_WORDS.has(raw)) continue;
		if (/^\d+$/.test(raw)) continue;
		if (raw.includes("://")) continue;
		frequencies.set(raw, (frequencies.get(raw) ?? 0) + 1);
	}
}

/** Ranks a term-frequency map by frequency (frequency acts as TF proxy). */
export function rankTerms(frequencies: Map<string, number>, limit: number): string[] {
	return Array.from(frequencies.entries())
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([term]) => term);
}

export function buildKeyTerms(docs: DocAnalysis[], options: Partial<KeyTermsOptions> = {}): KeyTermsResult {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const documentFrequency = new Map<string, number>();
	const byPath = new Map<string, TermWeight[]>();

	for (const doc of docs) {
		const seen = new Set<string>();
		for (const term of doc.topTerms) {
			if (seen.has(term)) continue;
			seen.add(term);
			documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
		}
	}

	const total = Math.max(1, docs.length);
	const maxRatio = Math.max(0.05, opts.maxDocumentRatio);
	const idf = new Map<string, number>();
	for (const [term, df] of documentFrequency) {
		const ratio = df / total;
		if (df < opts.minDocuments) continue;
		if (ratio > maxRatio && total > 6) continue;
		idf.set(term, Math.log(1 + total / (1 + df)));
	}

	const corpusWeights = new Map<string, number>();
	for (const doc of docs) {
		const scored: TermWeight[] = [];
		const seen = new Set<string>();
		doc.topTerms.forEach((term, index) => {
			if (seen.has(term)) return;
			seen.add(term);
			const weight = idf.get(term);
			if (weight === undefined) return;
			// Rank inside the note acts as the term frequency proxy.
			const tf = 1 / Math.sqrt(index + 1);
			const score = weight * tf;
			scored.push({ term, weight: score });
			corpusWeights.set(term, (corpusWeights.get(term) ?? 0) + score);
		});
		scored.sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));
		byPath.set(doc.file.path, scored.slice(0, opts.perNote));
	}

	const topTerms = Array.from(corpusWeights.entries())
		.map(([term, weight]) => ({ term, weight }))
		.sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));

	return { byPath, documentFrequency, topTerms };
}

/* -------------------------------------------------------------------------- */
/*  Glossary: definitions found in the corpus                                  */
/* -------------------------------------------------------------------------- */

export interface GlossaryEntry {
	term: string;
	definition: string;
	path: string;
}

const DEFINITION_RE = /^\s*(?:\*\*|__)?([\p{L}\p{N}][^:\n—–-]{1,60})(?:\*\*|__)?\s*(?:[:—–]|-\s)\s*(\S.{9,240})$/u;
const SHORT_NOTE_WORDS = 160;

/**
 * Harvests "Term — definition" style lines, plus the first sentence of very
 * short notes whose title looks like a concept. Gives the model a vocabulary
 * section it can trust.
 */
export function extractGlossary(docs: { analysis: DocAnalysis; body: string }[]): GlossaryEntry[] {
	const entries: GlossaryEntry[] = [];
	const seen = new Set<string>();
	for (const { analysis, body } of docs) {
		const lines = body.split("\n");
		let found = 0;
		for (const line of lines) {
			const trimmed = line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "").trim();
			if (trimmed === "" || trimmed.startsWith("#") || trimmed.length > 320) continue;
			const match = DEFINITION_RE.exec(trimmed);
			if (!match) continue;
			const term = cleanTerm(match[1]);
			// A glossary entry is a *term*, not a sentence: keep it short and
			// refuse anything that looks like prose ("Real content for the day").
			if (term === "" || term.length > 48 || term.split(/\s+/).length > 4 || term.includes(",")) continue;
			const key = term.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			entries.push({ term, definition: match[2].trim(), path: analysis.file.path });
			found++;
			if (found >= 3) break;
		}
		if (found > 0) continue;
		// Short concept notes: use the title as the term and the first sentence
		// as the definition.
		if (analysis.stats.words <= SHORT_NOTE_WORDS && analysis.stats.words >= 8 && analysis.title.length <= 48) {
			const sentence = body
				.replace(/^#{1,6}[^\n]*\n/, "")
				.split(/(?<=[.!?…])\s+/)[0]
				?.trim();
			const mentionsTerm = sentence
				? sentence.toLowerCase().includes(analysis.title.toLowerCase().split(/\s+/)[0])
				: false;
			if (sentence && mentionsTerm && sentence.length > 20 && sentence.length < 320) {
				const key = analysis.title.toLowerCase();
				if (!seen.has(key)) {
					seen.add(key);
					entries.push({ term: analysis.title, definition: sentence, path: analysis.file.path });
				}
			}
		}
	}
	return entries.slice(0, 200);
}

function cleanTerm(raw: string): string {
	return raw
		.replace(/^\s*[-*+]\s*/, "")
		.replace(/[`*_]/g, "")
		.replace(/\[\[([^\]|]*)\|?[^\]]*\]\]/g, "$1")
		.trim();
}
