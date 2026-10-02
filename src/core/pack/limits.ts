/**
 * Destination limits ("recipes").
 *
 * Feeding 40 notes into an LLM is easy; feeding them into NotebookLM is not:
 * it accepts a limited number of sources, each with a word ceiling. Rather
 * than letting the user discover that at upload time, the plugin encodes the
 * known constraints and shapes the bundle accordingly, warning when a corpus
 * simply cannot fit.
 *
 * The values below are defaults published by each tool (sources: Google
 * Gemini Notebook help pages, September 2026) — they are all editable.
 */

import type { BundleLimits, ChunkOptions } from "../types";
import { formatCount } from "../util";

export interface LimitPreset {
	id: string;
	label: string;
	description: string;
	limits: BundleLimits;
	/** Chunking configuration that satisfies the preset. */
	chunking: Partial<ChunkOptions>;
}

export const UNLIMITED: BundleLimits = {
	maxParts: 0,
	maxWordsPerPart: 0,
	maxTokensPerPart: 0,
	maxTotalWords: 0,
	maxTotalTokens: 0,
	maxMegabytesPerPart: 0,
	label: "No limit",
};

export const LIMIT_PRESETS: LimitPreset[] = [
	{
		id: "none",
		label: "No limit",
		description: "Write everything, however large. Best for archiving or local search.",
		limits: { ...UNLIMITED },
		chunking: { mode: "single" },
	},
	{
		id: "notebooklm-free",
		label: "NotebookLM — free",
		description: "50 sources, 500 000 words and 200 MB per source.",
		limits: {
			label: "NotebookLM (free)",
			maxParts: 50,
			maxWordsPerPart: 500_000,
			maxTokensPerPart: 0,
			maxTotalWords: 0,
			maxTotalTokens: 0,
			maxMegabytesPerPart: 200,
		},
		chunking: { mode: "maxWords", maxWords: 450_000, overlapTokens: 200 },
	},
	{
		id: "notebooklm-plus",
		label: "NotebookLM — Plus / AI Pro",
		description: "100 to 300 sources, 500 000 words and 200 MB per source.",
		limits: {
			label: "NotebookLM (paid)",
			maxParts: 100,
			maxWordsPerPart: 500_000,
			maxTokensPerPart: 0,
			maxTotalWords: 0,
			maxTotalTokens: 0,
			maxMegabytesPerPart: 200,
		},
		chunking: { mode: "maxWords", maxWords: 450_000, overlapTokens: 200 },
	},
	{
		id: "chat-context",
		label: "Chat model context (single prompt)",
		description: "One part sized for a ~200 000-token context window, leaving room for the answer.",
		limits: {
			label: "Chat context",
			maxParts: 1,
			maxWordsPerPart: 0,
			maxTokensPerPart: 150_000,
			maxTotalWords: 0,
			maxTotalTokens: 150_000,
			maxMegabytesPerPart: 0,
		},
		chunking: { mode: "maxTokens", maxTokens: 150_000, overlapTokens: 0 },
	},
	{
		id: "rag-chunks",
		label: "RAG ingestion (~1 000 tokens per part)",
		description: "Many small parts, ideal for embedding pipelines that chunk before indexing.",
		limits: {
			label: "RAG chunks",
			maxParts: 0,
			maxWordsPerPart: 0,
			maxTokensPerPart: 1_200,
			maxTotalWords: 0,
			maxTotalTokens: 0,
			maxMegabytesPerPart: 0,
		},
		chunking: { mode: "maxTokens", maxTokens: 1_000, overlapTokens: 120 },
	},
	{
		id: "one-file-per-note",
		label: "One file per note",
		description: "Useful to convert a folder of Markdown into a clean, processed mirror.",
		limits: {
			label: "One per note",
			maxParts: 0,
			maxWordsPerPart: 0,
			maxTokensPerPart: 0,
			maxTotalWords: 0,
			maxTotalTokens: 0,
			maxMegabytesPerPart: 0,
		},
		chunking: { mode: "perNote" },
	},
];

export function presetById(id: string): LimitPreset | undefined {
	return LIMIT_PRESETS.find((preset) => preset.id === id);
}

export interface LimitViolation {
	severity: "error" | "warning" | "info";
	message: string;
}

export interface LimitCheckInput {
	parts: number;
	totalWords: number;
	totalTokens: number;
	maxPartWords: number;
	maxPartTokens: number;
	maxPartBytes: number;
}

/** Verifies a produced bundle against the destination constraints. */
export function checkLimits(input: LimitCheckInput, limits: BundleLimits): LimitViolation[] {
	const violations: LimitViolation[] = [];
	if (limits.maxParts > 0 && input.parts > limits.maxParts) {
		violations.push({
			severity: "error",
			message: `${input.parts} parts were produced but ${limits.label} accepts only ${limits.maxParts}. Raise the part size, drop notes, or enable the token budget.`,
		});
	} else if (limits.maxParts > 0 && input.parts > limits.maxParts * 0.9) {
		violations.push({
			severity: "info",
			message: `${input.parts} parts used out of the ${limits.maxParts} allowed by ${limits.label}.`,
		});
	}
	if (limits.maxWordsPerPart > 0 && input.maxPartWords > limits.maxWordsPerPart) {
		violations.push({
			severity: "error",
			message: `The largest part holds ${formatCount(input.maxPartWords)} words, above the ${formatCount(limits.maxWordsPerPart)}-word limit of ${limits.label}.`,
		});
	}
	if (limits.maxTokensPerPart > 0 && input.maxPartTokens > limits.maxTokensPerPart) {
		violations.push({
			severity: "warning",
			message: `The largest part is ~${formatCount(input.maxPartTokens)} tokens, above the ${formatCount(limits.maxTokensPerPart)}-token limit of ${limits.label}.`,
		});
	}
	if (limits.maxMegabytesPerPart > 0 && input.maxPartBytes > limits.maxMegabytesPerPart * 1024 * 1024) {
		violations.push({
			severity: "error",
			message: `A part exceeds the ${limits.maxMegabytesPerPart} MB file-size limit of ${limits.label}.`,
		});
	}
	if (limits.maxTotalWords > 0 && input.totalWords > limits.maxTotalWords) {
		violations.push({
			severity: "error",
			message: `The corpus holds ${formatCount(input.totalWords)} words, above the ${formatCount(limits.maxTotalWords)}-word capacity of ${limits.label}.`,
		});
	}
	if (limits.maxTotalTokens > 0 && input.totalTokens > limits.maxTotalTokens) {
		violations.push({
			severity: "warning",
			message: `The corpus is ~${formatCount(input.totalTokens)} tokens, above the ${formatCount(limits.maxTotalTokens)}-token capacity of ${limits.label}.`,
		});
	}
	return violations;
}

/** Human-readable summary of the constraints, for the settings/UI. */
export function describeLimits(limits: BundleLimits): string {
	const parts: string[] = [];
	if (limits.maxParts > 0) parts.push(`≤ ${limits.maxParts} parts`);
	if (limits.maxWordsPerPart > 0) parts.push(`≤ ${formatCount(limits.maxWordsPerPart)} words/part`);
	if (limits.maxTokensPerPart > 0) parts.push(`≤ ~${formatCount(limits.maxTokensPerPart)} tokens/part`);
	if (limits.maxMegabytesPerPart > 0) parts.push(`≤ ${limits.maxMegabytesPerPart} MB/part`);
	if (parts.length === 0) return "Unlimited";
	return parts.join(" · ");
}
