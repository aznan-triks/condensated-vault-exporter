/**
 * Splitting a rendered corpus into parts that respect a size budget.
 *
 * The hard part is not cutting, it is cutting *well*: never in the middle of
 * a code fence, preferably at a heading boundary, never losing the note's
 * header, and repeating a small overlap so a retrieval system does not lose
 * the sentence that straddles two parts.
 */

import type { ChunkOptions } from "../types";
import { countTokens } from "../tokens";
import { splitLines } from "../markdown/syntax";

export type { ChunkOptions };

export type PackUnitRole = "preamble" | "footer" | "document";

export interface PackUnit {
	/** Source path (or folder) this unit comes from. */
	origin: string;
	/**
	 * Bundle-level units (title, TOC, knowledge map, footer) are not source
	 * documents: they must be emitted as part of the part's own structure
	 * rather than as a `<document>` entry.
	 */
	role?: PackUnitRole;
	/** Stable id of the unit, e.g. `S07` or `S07.2`. */
	id: string;
	title: string;
	content: string;
	chars: number;
	tokens: number;
	/** Header block repeated when the unit is split across parts. */
	header?: string;
	/** True when the unit may be split at paragraph boundaries. */
	splittable: boolean;
}

export interface ChunkedPart {
	index: number;
	units: PackUnit[];
	chars: number;
	tokens: number;
	sources: string[];
	/** Ids of the units that continue in the next part. */
	continued: string[];
}

export interface ChunkResult {
	parts: ChunkedPart[];
	/** Warnings raised while splitting (oversized units, …). */
	warnings: string[];
}

const HARD_CAP_FACTOR = 1.35;
/** Words→tokens ratio used to enforce word-based limits. */
const TOKENS_PER_WORD = 1.35;

/** Effective part budget in tokens for any chunking mode. */
export function resolveLimitTokens(options: ChunkOptions): number {
	switch (options.mode) {
		case "maxTokens":
			return Math.max(1, options.maxTokens);
		case "maxChars":
			return options.maxChars > 0 ? estimateTokensFromChars(options.maxChars) : 0;
		case "maxWords":
			return options.maxWords > 0 ? Math.round(options.maxWords * TOKENS_PER_WORD) : 0;
		default:
			return 0;
	}
}

/** Effective part budget in words (for reporting). */
export function resolveLimitWords(options: ChunkOptions): number {
	const tokens = resolveLimitTokens(options);
	return tokens > 0 ? Math.round(tokens / TOKENS_PER_WORD) : 0;
}

export function chunkUnits(units: PackUnit[], options: ChunkOptions, overheadPerPart = 0): ChunkResult {
	const warnings: string[] = [];
	switch (options.mode) {
		case "perNote":
			return { parts: units.map((unit, index) => makePart(index, [unit])), warnings };
		case "perFolder":
			return { parts: groupByFolder(units), warnings };
		case "single": {
			const total = units.reduce((acc, u) => acc + u.tokens, 0);
			if (options.maxChars > 0 && total > estimateTokensFromChars(options.maxChars)) {
				warnings.push(
					`The bundle (~${total} tokens) exceeds the configured single-part limit — it was still written as one file.`,
				);
			}
			return { parts: [makePart(0, units)], warnings };
		}
		case "maxChars":
		case "maxTokens":
		case "maxWords":
		default:
			break;
	}

	let limitTokens = resolveLimitTokens(options);
	if (limitTokens <= 0) {
		warnings.push("No part size configured — the bundle was written as a single part.");
		return { parts: [makePart(0, units)], warnings };
	}
	if (limitTokens <= overheadPerPart + 64) {
		warnings.push(
			`The configured part size (~${limitTokens} tokens) is smaller than what the bundle header, table of contents and map occupy — parts cannot honour it. Raise the part size or disable the table of contents / corpus map.`,
		);
		limitTokens = overheadPerPart + 64;
	}
	// Everything a part contains beyond its units (header, part notice, footer,
	// separators) is `overheadPerPart`: packing must leave room for it.
	const packLimit = Math.max(64, limitTokens - overheadPerPart);

	const parts: ChunkedPart[] = [];
	let current: PackUnit[] = [];
	let currentTokens = overheadPerPart;
	let currentChars = 0;

	const flush = () => {
		if (current.length === 0) return;
		parts.push(makePart(parts.length, current));
		current = [];
		currentTokens = overheadPerPart;
		currentChars = 0;
	};

	for (const original of units) {
		let unit = original;
		if (unit.tokens > packLimit) {
			// Too big to ever fit: split it internally first.
			const pieces = splitUnit(unit, packLimit, options);
			if (pieces.length > 1) {
				flush();
				for (const piece of pieces) {
					if (currentTokens + piece.tokens > packLimit && current.length > 0) flush();
					current.push(piece);
					currentTokens += piece.tokens;
					currentChars += piece.chars;
					if (currentTokens >= packLimit) flush();
				}
				continue;
			}
			warnings.push(
				`“${unit.title}” (~${unit.tokens} tokens) has no splittable boundary and exceeds the part budget.`,
			);
		}
		if (currentTokens + unit.tokens > packLimit && current.length > 0) flush();
		current.push(unit);
		currentTokens += unit.tokens;
		currentChars += unit.chars;
		void currentChars;
		if (currentTokens >= packLimit) flush();
	}
	flush();

	// Report any part that still exceeds the budget after splitting: this can
	// only happen for content with no boundary (a single enormous code fence).
	for (const part of parts) {
		const limit = Math.round(limitTokens * HARD_CAP_FACTOR);
		if (part.tokens <= limit) continue;
		for (const unit of part.units.filter((u) => u.tokens > limit)) {
			if (warnings.some((w) => w.includes(unit.title))) continue;
			warnings.push(
				`“${unit.title}” (~${unit.tokens} tokens) is larger than the configured part size and could not be split.`,
			);
		}
	}

	return { parts, warnings };
}

function makePart(index: number, units: PackUnit[]): ChunkedPart {
	const sources = Array.from(new Set(units.flatMap((u) => u.origin.split("|"))));
	return {
		index,
		units,
		chars: units.reduce((acc, u) => acc + u.chars, 0),
		tokens: units.reduce((acc, u) => acc + u.tokens, 0),
		sources,
		continued: [],
	};
}

function groupByFolder(units: PackUnit[]): ChunkedPart[] {
	const buckets = new Map<string, PackUnit[]>();
	for (const unit of units) {
		const folder = unit.origin.includes("/") ? unit.origin.slice(0, unit.origin.lastIndexOf("/")) : "";
		const list = buckets.get(folder);
		if (list) list.push(unit);
		else buckets.set(folder, [unit]);
	}
	return Array.from(buckets.values()).map((list, index) => makePart(index, list));
}

/**
 * Splits one oversized unit at heading boundaries (falling back to paragraph
 * boundaries), repeating an optional header at the top of each piece and
 * overlapping by `overlapTokens`.
 */
export function splitUnit(unit: PackUnit, limitTokens: number, options: ChunkOptions): PackUnit[] {
	const lines = splitLines(unit.content);
	const blocks: { text: string; tokens: number; headings: number }[] = [];
	let buffer: string[] = [];
	let inFence = false;
	let fenceChar = "";

	const flushBlock = () => {
		if (buffer.length === 0) return;
		const text = buffer.join("\n");
		blocks.push({ text, tokens: countTokens(text), headings: buffer.filter((l) => /^#{1,6}\s/.test(l)).length });
		buffer = [];
	};

	for (const line of lines) {
		const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
		if (fence) {
			if (!inFence) {
				inFence = true;
				fenceChar = fence[1][0];
			} else if (fence[1][0] === fenceChar) {
				inFence = false;
			}
			buffer.push(line);
			continue;
		}
		if (inFence) {
			buffer.push(line);
			continue;
		}
		const heading = /^(#{1,6})\s+/.exec(line);
		if (heading && heading[1].length <= options.splitAtLevel) {
			flushBlock();
			buffer.push(line);
			continue;
		}
		if (line.trim() === "" && buffer.length > 0) {
			flushBlock();
			continue;
		}
		buffer.push(line);
	}
	flushBlock();

	if (blocks.length <= 1) {
		// No natural boundaries: cut at sentence boundaries as a last resort.
		const sentences = unit.content.split(/(?<=[.!?…])\s+/);
		if (sentences.length <= 1) {
			if (unit.tokens <= limitTokens) return [unit];
			return hardSplit(unit.content, limitTokens).map((content, index, all) => makeChild(unit, content, index, all.length));
		}
		const pieces: string[] = [];
		let current = "";
		for (const sentence of sentences) {
			const candidate = current === "" ? sentence : `${current} ${sentence}`;
			if (countTokens(candidate) > limitTokens && current !== "") {
				pieces.push(current);
				current = sentence;
			} else current = candidate;
		}
		if (current !== "") pieces.push(current);
		return pieces.map((content, index) => makeChild(unit, content, index, pieces.length));
	}

	// Blocks that are still too large (a giant paragraph, a long list, a code
	// fence with no blank line) are hard-split at sentence or word boundaries so
	// the requested part size is actually respected.
	const expanded: { text: string; tokens: number; headings: number; hard?: boolean }[] = [];
	for (const block of blocks) {
		if (block.tokens <= limitTokens) {
			expanded.push(block);
			continue;
		}
		for (const piece of hardSplit(block.text, limitTokens)) {
			expanded.push({ text: piece, tokens: countTokens(piece), headings: 0, hard: true });
		}
	}

	const pieces: string[] = [];
	let current: string[] = [];
	let currentTokens = countTokens(unit.header ?? "");
	for (const block of expanded) {
		if (currentTokens + block.tokens > limitTokens && current.length > 0) {
			pieces.push(current.join("\n\n"));
			// Overlap is taken block by block: reconstructing it from the joined
			// string would lose the paragraph boundaries.
			const overlap = options.overlapTokens > 0 ? tailBlocks(current, options.overlapTokens) : [];
			current = [...overlap];
			currentTokens = countTokens(overlap.join("\n\n")) + countTokens(unit.header ?? "");
		}
		current.push(block.text);
		currentTokens += block.tokens;
	}
	if (current.length > 0) pieces.push(current.join("\n\n"));

	return pieces.map((content, index) => makeChild(unit, content, index, pieces.length));
}

/**
 * Splits text on word boundaries into pieces of at most `limitTokens`.
 * Used as a last resort for text without any structural boundary.
 */
export function hardSplit(text: string, limitTokens: number): string[] {
	const words = text.split(/(\s+)/);
	const pieces: string[] = [];
	let current = "";
	let tokens = 0;
	for (const word of words) {
		const wordTokens = estimateTokensFromChars(word.length);
		if (tokens + wordTokens > limitTokens && current.trim() !== "") {
			pieces.push(current.trimEnd());
			current = "";
			tokens = 0;
		}
		current += word;
		tokens += wordTokens;
	}
	if (current.trim() !== "") pieces.push(current.trimEnd());
	return pieces.length > 0 ? pieces : [text];
}

function makeChild(parent: PackUnit, content: string, index: number, total: number): PackUnit {
	const header = parent.header && index > 0 ? `${parent.header}\n` : "";
	const text = header ? `${header}${content}` : content;
	return {
		origin: parent.origin,
		id: total > 1 ? `${parent.id}.${index + 1}` : parent.id,
		title: total > 1 ? `${parent.title} (${index + 1}/${total})` : parent.title,
		content: text,
		chars: text.length,
		tokens: countTokens(text),
		header: parent.header,
		splittable: false,
	};
}

/**
 * Returns the trailing blocks that fit in `tokens` — always at least one, so
 * a paragraph larger than the overlap budget never disappears from the next
 * piece entirely.
 */
export function tailBlocks(blocks: string[], tokens: number): string[] {
	if (tokens <= 0 || blocks.length === 0) return [];
	const kept: string[] = [];
	let total = 0;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const count = countTokens(blocks[i]);
		if (total + count > tokens && kept.length > 0) break;
		kept.unshift(blocks[i]);
		total += count;
		if (total >= tokens) break;
	}
	return kept;
}

/** Cheap chars→tokens conversion for the `maxChars` mode. */
export function estimateTokensFromChars(chars: number): number {
	return Math.round(chars / 3.6);
}
