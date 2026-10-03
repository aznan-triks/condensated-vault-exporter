/**
 * Extractive summarization, offline and dependency free.
 *
 * Four strategies, all deterministic:
 *
 *  - `lead`      — the opening sentences (fast, works well for notes).
 *  - `centroid`  — sentences scored by the frequency of their content words
 *                  (a poor man's TextRank/TF-IDF): picks the sentences that
 *                  best represent the note's vocabulary.
 *  - `keypoints` — sentences that mention the note's own key terms, headings
 *                  or definition patterns ("X is/means/refers to…").
 *  - `mmr`       — Maximal Marginal Relevance: combines relevance (centroid +
 *                  keypoints + numeric/definition signals) with a Jaccard
 *                  redundancy penalty so selected sentences cover distinct
 *                  facets of the note instead of repeating the same point.
 *
 * The result keeps the original wording (extractive), so a human verifying the
 * bundle still recognises their own notes — a property abstractive summaries
 * cannot offer without a network round-trip.
 */

import type { Heading } from "../types";
import { countWords, splitSentences, stripInlineMarkup } from "../markdown/syntax";

export interface SummarizeOptions {
	enabled: boolean;
	method: "lead" | "centroid" | "keypoints" | "mmr";
	mode: "ratio" | "sentences";
	ratio: number;
	sentences: number;
	minWords: number;
	/** Prepend a compact outline built from the note's headings. */
	keepHeadings: boolean;
}

export interface SummarizeInput {
	headings: Heading[];
	/** Characteristic terms of the note (from pass 1). */
	topTerms: string[];
}

export interface SummaryResult {
	text: string;
	kept: number;
	total: number;
	applied: boolean;
	outline?: string;
}

const STOP_WORDS = new Set(
	`the a an and or but if then than that this these those of in on at to for with from by as is are was were be been being it its it's their there here we you they he she i not no do does did done have has had having will would can could should may might must about into over under again more most some such only own same so too very s t don now also pour que les des une dans est sont avec plus mais comme tout tous toute cette ces son sa ses leur leurs qui quoi dont donc alors quand nous vous ils elles elle il on ne pas aux par sur ou où`.split(
		/\s+/,
	),
);

export function summarize(text: string, options: SummarizeOptions, input: SummarizeInput): SummaryResult {
	if (!options.enabled) return { text, kept: 0, total: 0, applied: false };

	const sentences = splitSentences(text)
		.map((s) => s.replace(/\s+/g, " ").trim())
		.filter((s) => s !== "" && !isMarkupOnly(s));

	const total = sentences.length;
	const totalWords = countWords(sentences.map(stripInlineMarkup).join(" "));
	if (total < 4 || totalWords < options.minWords) {
		return { text, kept: total, total, applied: false };
	}

	const budget = Math.max(1, Math.min(options.mode === "ratio" ? Math.ceil(total * options.ratio) : options.sentences, total - 1));

	let chosen: number[];
	switch (options.method) {
		case "centroid":
			chosen = selectCentroid(sentences, budget);
			break;
		case "keypoints":
			chosen = selectKeypoints(sentences, budget, input.headings, input.topTerms);
			break;
		case "mmr":
			chosen = selectMmr(sentences, budget, input.headings, input.topTerms);
			break;
		case "lead":
		default:
			chosen = range(budget);
			break;
	}

	chosen.sort((a, b) => a - b);
	const body = chosen.map((i) => sentences[i]).join(" ");
	const outline = options.keepHeadings ? buildOutline(input.headings, 24) : undefined;
	const result = outline ? `${outline}\n\n${body}` : body;
	return { text: result, kept: chosen.length, total, applied: true, outline };
}

/* -------------------------------------------------------------------------- */
/*  Strategies                                                                 */
/* -------------------------------------------------------------------------- */

function range(n: number): number[] {
	return Array.from({ length: n }, (_, i) => i);
}

interface Scored {
	index: number;
	score: number;
}

function selectCentroid(sentences: string[], budget: number): number[] {
	const frequencies = new Map<string, number>();
	const tokensPerSentence: string[][] = [];
	for (const sentence of sentences) {
		const tokens = contentTokens(sentence);
		tokensPerSentence.push(tokens);
		for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
	}
	const maxFreq = Math.max(1, ...frequencies.values());
	const scored: Scored[] = sentences.map((_sentence, index) => {
		const tokens = tokensPerSentence[index];
		if (tokens.length === 0) return { index, score: 0 };
		let score = 0;
		const seen = new Set<string>();
		for (const token of tokens) {
			if (seen.has(token)) continue;
			seen.add(token);
			score += (frequencies.get(token) ?? 0) / maxFreq;
		}
		score /= Math.sqrt(tokens.length);
		// Normalize by position: opening sentences carry the note's thesis.
		score *= 1 + (1 - index / sentences.length) * 0.35;
		return { index, score };
	});
	return pickTop(scored, budget, [0]);
}

function selectKeypoints(
	sentences: string[],
	budget: number,
	headings: Heading[],
	topTerms: string[],
): number[] {
	const terms = new Set(topTerms.map((t) => t.toLowerCase()));
	for (const heading of headings) {
		for (const token of contentTokens(heading.text)) terms.add(token);
	}
	const definitionPattern = /\b(is|are|was|were|means|refers to|consists of|defined as|stands for)\b/i;
	const scored: Scored[] = sentences.map((sentence, index) => {
		let score = 0;
		for (const token of contentTokens(sentence)) if (terms.has(token)) score += 1;
		if (definitionPattern.test(sentence)) score += 1.5;
		if (/^\s*#{1,6}\s/.test(sentence)) score += 0.8;
		if (/\d/.test(sentence)) score += 0.3;
		score /= Math.sqrt(Math.max(1, countWords(sentence)));
		score += (1 - index / sentences.length) * 0.2;
		return { index, score };
	});
	return pickTop(scored, budget, [0]);
}

/**
 * Maximal Marginal Relevance (MMR): greedily selects sentences that balance
 * intrinsic relevance (`lambda = 0.68`) against lexical similarity (`1 - lambda`)
 * to already-selected sentences.
 */
function selectMmr(
	sentences: string[],
	budget: number,
	headings: Heading[],
	topTerms: string[],
	lambda = 0.55,
): number[] {
	const frequencies = new Map<string, number>();
	const tokenSets: Set<string>[] = [];
	const simSets: Set<string>[] = [];
	for (const sentence of sentences) {
		const tokens = contentTokens(sentence);
		tokenSets.push(new Set(tokens));
		const simTokens = new Set<string>();
		for (const token of tokens) {
			frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
			simTokens.add(token);
			if (token.length >= 5) simTokens.add( token.slice(0, 5));
		}
		simSets.push(simTokens);
	}
	const maxFreq = Math.max(1, ...frequencies.values());
	const terms = new Set(topTerms.map((t) => t.toLowerCase()));
	for (const heading of headings) {
		for (const token of contentTokens(heading.text)) terms.add(token);
	}
	const definitionPattern = /\b(is|are|was|were|means|refers to|consists of|defined as|stands for)\b/i;

	const rawRel = sentences.map((sentence, index) => {
		const tokens = tokenSets[index];
		if (tokens.size === 0) return 0;
		let centroid = 0;
		let keyHits = 0;
		for (const token of tokens) {
			centroid += (frequencies.get(token) ?? 0) / maxFreq;
			if (terms.has(token)) keyHits += 1;
		}
		let score = (centroid + keyHits * 1.2) / Math.sqrt(tokens.size);
		if (definitionPattern.test(sentence)) score += 0.8;
		if (/\d/.test(sentence)) score += 0.25;
		score *= 1 + (1 - index / sentences.length) * 0.25;
		return score;
	});

	const maxRel = Math.max(1e-6, ...rawRel);
	const relevance = rawRel.map((r) => r / maxRel);

	const chosen: number[] = [0];
	const chosenSet = new Set<number>(chosen);

	while (chosen.length < budget) {
		let bestIdx = -1;
		let bestMmr = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < sentences.length; i++) {
			if (chosenSet.has(i)) continue;
			let maxSim = 0;
			for (const j of chosen) {
				const sim = jaccardSets(simSets[i], simSets[j]);
				if (sim > maxSim) maxSim = sim;
			}
			const mmr = lambda * relevance[i] - (1 - lambda) * maxSim;
			if (mmr > bestMmr) {
				bestMmr = mmr;
				bestIdx = i;
			}
		}
		if (bestIdx === -1) break;
		chosen.push(bestIdx);
		chosenSet.add(bestIdx);
	}

	return chosen.sort((a, b) => a - b);
}

function jaccardSets(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	for (const item of small) if (large.has(item)) inter++;
	const union = a.size + b.size - inter;
	return union === 0 ? 0 : inter / union;
}

function pickTop(scored: Scored[], budget: number, alwaysInclude: number[]): number[] {
	const sorted = [...scored].sort((a, b) => b.score - a.score || a.index - b.index);
	const chosen = new Set<number>(alwaysInclude.filter((i) => i < scored.length));
	for (const item of sorted) {
		if (chosen.size >= budget) break;
		if (item.score <= 0 && chosen.size > 0) continue;
		chosen.add(item.index);
	}
	for (const item of sorted) {
		if (chosen.size >= budget) break;
		chosen.add(item.index);
	}
	return Array.from(chosen).sort((a, b) => a - b);
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function contentTokens(sentence: string): string[] {
	const plain = stripInlineMarkup(sentence).toLowerCase();
	const tokens = plain.match(/[\p{L}][\p{L}\p{N}'’-]+/gu) ?? [];
	return tokens.filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

function isMarkupOnly(sentence: string): boolean {
	const stripped = stripInlineMarkup(sentence).trim();
	if (stripped === "") return true;
	if (/^[-*_=~#`|>\s]+$/.test(stripped)) return true;
	return stripped.length < 12;
}

/** Compact outline of the note's headings (root level only). */
export function buildOutline(headings: Heading[], maxEntries = 20): string {
	if (headings.length === 0) return "";
	const minLevel = Math.min(...headings.map((h) => h.level));
	const top = headings.filter((h) => h.level === minLevel).slice(0, maxEntries);
	if (top.length === 0) return "";
	return top.map((h) => `- ${h.text}`).join("\n");
}
