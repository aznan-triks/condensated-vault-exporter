/**
 * Topic focus: "export what this vault knows about X".
 *
 * Folder and tag filters need the vault to be organised before the export can
 * be useful. A topic filter needs nothing: the notes are analysed anyway, so
 * the corpus can be ranked against a free-text query and only the best slice
 * exported. It is the difference between "the Retrieval folder" and "everything
 * I have ever written that bears on reranking".
 *
 * The ranking reuses the corpus TF-IDF built for the knowledge map, plus a
 * title/tag/path bonus, so a note called "Reranking notes" beats a note that
 * merely mentions the word once in passing. It is a recall-first heuristic —
 * the point is to bring the right notes to a model, not to rank search results.
 */

import type { DocAnalysis } from "../types";
import { collectTerms, type KeyTermsResult } from "./terms";

export interface FocusScore {
	path: string;
	score: number;
}

export interface FocusOutcome {
	/** Paths that made the cut, best first. */
	kept: string[];
	/** How many notes scored above zero. */
	matched: number;
	/** Query terms that exist in the corpus. */
	terms: string[];
	/** Query terms that do not appear anywhere (typos, jargon, other language). */
	unknown: string[];
}

/** Weight of a title/tag/path match, relative to a body term match (1.0). */
const HEADING_WEIGHT = 2.5;
/** Weight of a heading match: a section about the topic, not a passing mention. */
const SECTION_WEIGHT = 0.8;
/** Weight of a term that is not among the note's most characteristic terms. */
const WEAK_TERM_WEIGHT = 0.35;
/** Extra weight when the whole query appears as a phrase in the heading text. */
const PHRASE_WEIGHT = 1.5;

function wordsOf(text: string): Set<string> {
	const set = new Set<string>();
	const matches = text.toLowerCase().match(/[\p{L}\p{N}'’-]+/gu);
	if (!matches) return set;
	for (const word of matches) set.add(word);
	return set;
}

/**
 * Ranks `docs` against `query` and returns the best `maxNotes` (0 = no cap).
 * Ties break on the note's signal then alphabetically, so the result is stable
 * across runs — an export that keeps changing for no reason is impossible to
 * review.
 */
export function rankByFocus(
	docs: DocAnalysis[],
	keyTerms: KeyTermsResult,
	query: string,
	maxNotes: number,
): FocusOutcome {
	const frequencies = new Map<string, number>();
	collectTerms(query, frequencies);
	const terms = Array.from(frequencies.keys());
	if (terms.length === 0) {
		return { kept: docs.map((doc) => doc.file.path), matched: docs.length, terms: [], unknown: [] };
	}

	const total = Math.max(1, docs.length);
	const unknown: string[] = [];
	const idf = new Map<string, number>();
	for (const term of terms) {
		const df = keyTerms.documentFrequency.get(term) ?? 0;
		if (df === 0) {
			unknown.push(term);
			continue;
		}
		idf.set(term, Math.log(1 + total / (1 + df)));
	}
	const known = terms.filter((term) => idf.has(term));
	const phrase = known.length > 1 ? known.join(" ") : "";

	const scores: FocusScore[] = [];
	for (const doc of docs) {
		const weights = new Map<string, number>();
		for (const entry of keyTerms.byPath.get(doc.file.path) ?? []) weights.set(entry.term, entry.weight);
		const heading = wordsOf(`${doc.title} ${doc.aliases.join(" ")} ${doc.tags.join(" ")} ${doc.file.path}`);
		const sections = wordsOf(doc.headings.map((entry) => entry.text).join(" "));
		const body = new Set(doc.topTerms);
		let score = 0;
		let matched = 0;
		for (const term of known) {
			const termWeight = idf.get(term) ?? 0;
			const keyword = weights.get(term);
			if (keyword !== undefined) score += keyword;
			else if (body.has(term)) score += termWeight * WEAK_TERM_WEIGHT;
			if (sections.has(term)) score += termWeight * SECTION_WEIGHT;
			if (heading.has(term)) score += termWeight * HEADING_WEIGHT;
			if (keyword !== undefined || body.has(term) || heading.has(term) || sections.has(term)) matched++;
		}
		// A note that answers several parts of the query is more on-topic than
		// one that happens to repeat a single word.
		if (matched > 1) score *= 1 + 0.35 * (matched - 1);
		if (phrase !== "" && heading.has(phrase)) {
			const average = known.reduce((acc, term) => acc + (idf.get(term) ?? 0), 0) / known.length;
			score += average * PHRASE_WEIGHT;
		}
		if (score > 0) scores.push({ path: doc.file.path, score });
	}

	const byPath = new Map(docs.map((doc) => [doc.file.path, doc]));
	scores.sort(
		(a, b) =>
			b.score - a.score ||
			(byPath.get(b.path)?.signal ?? 0) - (byPath.get(a.path)?.signal ?? 0) ||
			a.path.localeCompare(b.path),
	);
	const ranked = scores.map((entry) => entry.path);
	const kept = maxNotes > 0 ? ranked.slice(0, maxNotes) : ranked;
	return { kept, matched: ranked.length, terms: known, unknown };
}
