/**
 * Token budgeting: decide what actually fits, and how.
 *
 * A corpus is almost never the "right size". This module implements the
 * strategy ladder that makes the export predictable:
 *
 *   1. everything fits                        → keep full notes;
 *   2. too big, but summaries fit             → summarize the notes;
 *   3. still too big                          → drop lowest-value notes;
 *   4. a single note is bigger than the part  → truncate it at a boundary.
 *
 * "Value" is a transparent weighted blend (signal, centrality, recency,
 * length, folder weights), so users can see *why* something was dropped.
 */

import type { DocAnalysis } from "../types";

export interface FolderWeight {
	/** Glob matched against the note path. */
	pattern: string;
	weight: number;
}

export interface ScoreOptions {
	weightSignal: number;
	weightCentrality: number;
	weightRecency: number;
	weightLength: number;
	/** Half-life in days for the recency term. */
	recencyHalfLifeDays: number;
	folderWeights: FolderWeight[];
	/** Notes matching one of these globs are exported first. */
	boostPatterns: string[];
	/** Notes matching one of these globs are penalized. */
	demotePatterns: string[];
}

export interface ScoredDoc {
	path: string;
	score: number;
	/** Components, for the "why" tooltip / report. */
	breakdown: { signal: number; centrality: number; recency: number; length: number; folder: number };
}

export interface BudgetOptions {
	/** 0 = unlimited. */
	maxTokens: number;
	/** 0 = unlimited. */
	maxWords: number;
	/** Tokens consumed by headers, TOC and knowledge map. */
	overheadTokens: number;
	/** Never shrink a note below this. */
	minDocTokens: number;
	/** Tokens kept when a note is summarized (0 = use the summary as-is). */
	summaryTokens: number;
	allowSummarize: boolean;
	allowDrop: boolean;
	allowTruncate: boolean;
}

export type BudgetAction = "full" | "summarize" | "truncate" | "drop";

export interface BudgetDecision {
	path: string;
	action: BudgetAction;
	/** Token allowance when the action is `summarize` or `truncate`. */
	allowance: number;
	reason: string;
}

export interface BudgetOutcome {
	decisions: Map<string, BudgetDecision>;
	totalTokens: number;
	dropped: string[];
	summarized: string[];
	truncated: string[];
}

export function scoreDocuments(
	docs: DocAnalysis[],
	centrality: Map<string, number>,
	options: ScoreOptions,
	now = Date.now(),
): ScoredDoc[] {
	const maxWords = Math.max(1, ...docs.map((d) => d.stats.words));
	return docs.map((doc) => {
		const signal = doc.signal;
		const centralityValue = centrality.get(doc.file.path) ?? 0;
		const ageDays = Math.max(0, (now - (doc.file.mtime || now)) / 86_400_000);
		const recency = Math.pow(0.5, ageDays / Math.max(1, options.recencyHalfLifeDays));
		const length = Math.log10(doc.stats.words + 1) / Math.log10(maxWords + 1);
		const folder = folderWeightOf(doc.file.path, options);
		const score =
			signal * options.weightSignal +
			centralityValue * options.weightCentrality +
			recency * options.weightRecency +
			length * options.weightLength +
			folder;
		return {
			path: doc.file.path,
			score,
			breakdown: { signal, centrality: centralityValue, recency, length, folder },
		};
	});
}

function folderWeightOf(path: string, options: ScoreOptions): number {
	let weight = 0;
	for (const rule of options.folderWeights) {
		if (globMatch(rule.pattern, path)) weight += rule.weight;
	}
	return weight;
}

/**
 * Allocates the token budget across the (already ordered) documents.
 *
 * The order of `docs` is preserved: the user's ordering choice is respected,
 * only *what fits* is decided here.
 */
export function allocateBudget(docs: DocAnalysis[], options: BudgetOptions): BudgetOutcome {
	const decisions = new Map<string, BudgetDecision>();
	const dropped: string[] = [];
	const summarized: string[] = [];
	const truncated: string[] = [];

	const budget = options.maxTokens > 0 ? options.maxTokens : Number.POSITIVE_INFINITY;
	const available = Math.max(0, budget - options.overheadTokens);
	let used = 0;

	const fullTotal = docs.reduce((acc, d) => acc + d.stats.tokens, 0);
	if (fullTotal <= available) {
		for (const doc of docs) {
			decisions.set(doc.file.path, { path: doc.file.path, action: "full", allowance: doc.stats.tokens, reason: "fits" });
		}
		return { decisions, totalTokens: fullTotal, dropped, summarized, truncated };
	}

	// -- Step 2: try summaries -------------------------------------------------
	if (options.allowSummarize) {
		const summaryTotal = docs.reduce((acc, d) => acc + estimateSummaryTokens(d, options), 0);
		if (summaryTotal <= available) {
			for (const doc of docs) {
				const allowance = estimateSummaryTokens(doc, options);
				decisions.set(doc.file.path, {
					path: doc.file.path,
					action: "summarize",
					allowance,
					reason: "budget: summarized to fit",
				});
				summarized.push(doc.file.path);
				used += allowance;
			}
			return { decisions, totalTokens: used, dropped, summarized, truncated };
		}
	}

	// -- Step 3: drop the least valuable notes --------------------------------
	const order = [...docs];
	if (options.allowDrop) {
		const keep = new Set(order.map((d) => d.file.path));
		// Recompute with progressively fewer documents, dropping the smallest
		// "value per token" first (cheap approximation of a knapsack).
		const ranked = [...order].sort((a, b) => valuePerToken(a, options) - valuePerToken(b, options));
		let current = order.reduce((acc, d) => acc + perDocCost(d, options), 0);
		for (const candidate of ranked) {
			if (current <= available) break;
			if (keep.size <= 1) break;
			keep.delete(candidate.file.path);
			dropped.push(candidate.file.path);
			current -= perDocCost(candidate, options);
		}
		for (const doc of order) {
			if (!keep.has(doc.file.path)) {
				decisions.set(doc.file.path, { path: doc.file.path, action: "drop", allowance: 0, reason: "budget: lowest value per token" });
				continue;
			}
			const cost = perDocCost(doc, options);
			const action: BudgetAction = cost < doc.stats.tokens ? "summarize" : "full";
			if (action === "summarize") summarized.push(doc.file.path);
			decisions.set(doc.file.path, {
				path: doc.file.path,
				action,
				allowance: action === "summarize" ? cost : doc.stats.tokens,
				reason: action === "summarize" ? "budget: summarized to fit" : "fits",
			});
			used += action === "summarize" ? cost : doc.stats.tokens;
		}
	}

	// -- Step 4: a single document may still overflow --------------------------
	const remaining = docs.filter((d) => {
		const decision = decisions.get(d.file.path);
		return decision !== undefined && decision.action !== "drop";
	});
	const projected = remaining.reduce((acc, d) => acc + (decisions.get(d.file.path)?.allowance ?? 0), 0);
	if (projected > available && options.allowTruncate && remaining.length > 0) {
		const overflow = projected - available;
		const bySize = [...remaining].sort((a, b) => b.stats.tokens - a.stats.tokens);
		let toTrim = overflow;
		for (const doc of bySize) {
			if (toTrim <= 0) break;
			const decision = decisions.get(doc.file.path)!;
			const currentAllowance = decision.allowance;
			const minimum = Math.min(options.minDocTokens, Math.max(1, Math.floor(currentAllowance * 0.25)));
			const reducible = Math.max(0, currentAllowance - minimum);
			const cut = Math.min(reducible, toTrim);
			if (cut <= 0) continue;
			decision.allowance = currentAllowance - cut;
			decision.action = "truncate";
			decision.reason = "budget: truncated";
			if (!truncated.includes(doc.file.path)) truncated.push(doc.file.path);
			toTrim -= cut;
		}
	}

	used = 0;
	for (const doc of docs) {
		const decision = decisions.get(doc.file.path);
		if (!decision || decision.action === "drop") continue;
		used += decision.allowance;
	}
	return { decisions, totalTokens: used, dropped, summarized, truncated };
}

function perDocCost(doc: DocAnalysis, options: BudgetOptions): number {
	if (!options.allowSummarize) return doc.stats.tokens;
	return estimateSummaryTokens(doc, options);
}

function estimateSummaryTokens(doc: DocAnalysis, options: BudgetOptions): number {
	if (options.summaryTokens > 0) return Math.min(doc.stats.tokens, options.summaryTokens);
	// Rough estimate: ~35 % of the note, never below the minimum.
	return Math.max(options.minDocTokens, Math.round(doc.stats.tokens * 0.35));
}

/** Value density used to decide which notes survive a budget cut. */
function valuePerToken(doc: DocAnalysis, options: BudgetOptions): number {
	const value = doc.signal * 1.0 + Math.log10(doc.stats.words + 10) * 0.3;
	void options;
	return value / Math.max(1, perDocCost(doc, options));
}

/* -------------------------------------------------------------------------- */
/*  Local glob helper (avoids a dependency cycle with core/glob)                */
/* -------------------------------------------------------------------------- */

function globMatch(pattern: string, path: string): boolean {
	if (pattern === "" ) return false;
	if (pattern === "**" || pattern === "*") return true;
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "\u0000")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\u0000/g, ".*");
	try {
		return new RegExp(`^(?:.*/)?${escaped}$`).test(path) || new RegExp(`^${escaped}$`).test(path);
	} catch {
		return false;
	}
}
