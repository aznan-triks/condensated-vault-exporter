/**
 * In-memory cache of pass-1 analyses.
 *
 * Re-running an export on an unchanged vault is common (tweak a setting, add
 * one note, export again). Caching the analysis turns a multi-second pass into
 * a few hundred milliseconds.
 *
 * The cache key is `path|size|mtime`, which is exactly what Obsidian's own
 * metadata cache uses for invalidation: cheap and reliable enough, with a
 * content hash still computed on every *fresh* analysis so the manifest stays
 * trustworthy.
 */

import type { DocAnalysis } from "../types";

interface CacheEntry {
	analysis: DocAnalysis;
	/** Approximate memory weight (bytes) for the LRU budget. */
	weight: number;
	lastUsed: number;
}

export interface CacheStats {
	entries: number;
	hits: number;
	misses: number;
	bytes: number;
}

export class AnalysisCache {
	private entries = new Map<string, CacheEntry>();
	private hits = 0;
	private misses = 0;
	private bytes = 0;

	constructor(
		private readonly maxEntries = 20_000,
		private readonly maxBytes = 96 * 1024 * 1024,
	) {}

	static key(path: string, size: number, mtime: number): string {
		return `${path}|${size}|${Math.round(mtime)}`;
	}

	get(key: string): DocAnalysis | undefined {
		const entry = this.entries.get(key);
		if (!entry) {
			this.misses++;
			return undefined;
		}
		entry.lastUsed = Date.now();
		this.hits++;
		// Keep a recency order for cheap eviction.
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.analysis;
	}

	set(key: string, analysis: DocAnalysis): void {
		const weight = estimateWeight(analysis);
		const existing = this.entries.get(key);
		if (existing) {
			this.bytes -= existing.weight;
			this.entries.delete(key);
		}
		this.entries.set(key, { analysis, weight, lastUsed: Date.now() });
		this.bytes += weight;
		this.evict();
	}

	invalidate(path: string): void {
		for (const [key, entry] of this.entries) {
			if (entry.analysis.file.path === path) {
				this.bytes -= entry.weight;
				this.entries.delete(key);
			}
		}
	}

	clear(): void {
		this.entries.clear();
		this.bytes = 0;
	}

	stats(): CacheStats {
		return { entries: this.entries.size, hits: this.hits, misses: this.misses, bytes: this.bytes };
	}

	private evict(): void {
		while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			const entry = this.entries.get(oldest.value);
			this.entries.delete(oldest.value);
			if (entry) this.bytes -= entry.weight;
		}
	}
}

function estimateWeight(analysis: DocAnalysis): number {
	const linkCost = analysis.links.length * 96;
	const headingCost = analysis.headings.length * 64;
	const termCost = analysis.topTerms.reduce((acc, t) => acc + t.length * 2 + 16, 0);
	const sigCost = (analysis.shingles?.length ?? 0) * 4 + analysis.lineHashes.length * 4;
	const sampleCost = analysis.lineSamples.reduce((acc, l) => acc + l.length * 2 + 16, 0);
	return 512 + linkCost + headingCost + termCost + sigCost + sampleCost;
}
