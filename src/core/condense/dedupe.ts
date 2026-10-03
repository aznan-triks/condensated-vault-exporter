/**
 * Near-duplicate detection over a whole corpus.
 *
 * Algorithm: MinHash signatures (computed in pass 1) are grouped with LSH
 * banding into candidate pairs; candidates are then verified with the exact
 * signature estimate, and a union-find links every document to its cluster.
 * Documents with an identical content hash short-circuit the whole thing.
 *
 * Memory: O(docs) small structures (128 bytes of signature per doc) and
 * O(candidate pairs) which is bounded by `maxPairComparisons`.
 */

import type { DedupeOptions, DocAnalysis } from "../types";
import { compareSignatures, type SignatureComparison } from "../markdown/analyzer";

/** Rows per LSH band: 4 gives ~99 % recall above 0.85 similarity. */
const BAND_ROWS = 4;
const SIGNATURE_LENGTH = 32;

export interface DuplicateGroup {
	/** Path of the document retained in the bundle. */
	representative: string;
	/** Paths removed from the bundle. */
	duplicates: string[];
	/** Estimated similarity of the weakest duplicate in the group. */
	similarity: number;
	/** exact = identical, near = same note slightly edited, subset = copied excerpt. */
	kind: "exact" | "near" | "subset";
}

export interface DedupeOutcome {
	/** path -> representative path (only for removed documents). */
	duplicateOf: Map<string, string>;
	groups: DuplicateGroup[];
	/** True when the pair budget was exhausted (results may be partial). */
	truncated: boolean;
	comparisons: number;
}

/**
 * Compares two notes: exactly when both kept their shingle hashes, with the
 * MinHash estimate otherwise.
 */
function compareDocuments(a: DocAnalysis, b: DocAnalysis): SignatureComparison {
	if (a.shingleHashes && b.shingleHashes && a.shingleHashes.length > 0 && b.shingleHashes.length > 0) {
		const left = a.shingleHashes;
		const right = b.shingleHashes;
		let i = 0;
		let j = 0;
		let shared = 0;
		while (i < left.length && j < right.length) {
			if (left[i] === right[j]) {
				shared++;
				i++;
				j++;
			} else if (left[i] < right[j]) i++;
			else j++;
		}
		const union = left.length + right.length - shared;
		return {
			jaccard: union > 0 ? shared / union : 0,
			containment: Math.min(left.length, right.length) > 0 ? shared / Math.min(left.length, right.length) : 0,
		};
	}
	return compareSignatures(a.shingles, b.shingles, a.shingleCount, b.shingleCount);
}

class UnionFind {
	private parent: number[];
	constructor(size: number) {
		this.parent = new Array(size);
		for (let i = 0; i < size; i++) this.parent[i] = i;
	}
	find(x: number): number {
		let root = x;
		while (this.parent[root] !== root) root = this.parent[root];
		while (this.parent[x] !== root) {
			const next = this.parent[x];
			this.parent[x] = root;
			x = next;
		}
		return root;
	}
	union(a: number, b: number): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) this.parent[rb] = ra;
	}
}

export function detectDuplicates(
	docs: DocAnalysis[],
	options: DedupeOptions,
): DedupeOutcome {
	const outcome: DedupeOutcome = {
		duplicateOf: new Map(),
		groups: [],
		truncated: false,
		comparisons: 0,
	};
	if (!options.enabled || docs.length < 2) return outcome;

	const maxPairs = options.maxPairComparisons ?? 400_000;
	const eligible: number[] = [];
	for (let i = 0; i < docs.length; i++) {
		if (docs[i].stats.words >= options.minWords && docs[i].shingles) eligible.push(i);
	}
	if (eligible.length < 2) return outcome;

	const uf = new UnionFind(docs.length);
	const bestSimilarity = new Map<string, number>();
	/** Pairs whose relationship is containment rather than similarity. */
	const subsetPairs = new Set<string>();

	// 1. Exact hash duplicates — O(n).
	const byHash = new Map<string, number>();
	for (const i of eligible) {
		const hash = docs[i].hash;
		const seen = byHash.get(hash);
		if (seen === undefined) byHash.set(hash, i);
		else {
			uf.union(seen, i);
			const key = pairKey(seen, i);
			bestSimilarity.set(key, 1);
		}
	}

	// 2. Candidate pairs. Two channels feed the comparison step:
	//    a. an inverted index over exact shingle hashes — this is what finds a
	//       note that is an extract of a longer one, whatever the size ratio;
	//    b. LSH banding over the MinHash signatures, which finds near-edits.
	//    Both stay bounded: only eligible notes are indexed and the pair budget
	//    is enforced before any comparison happens.
	const candidates = new Map<number, Set<number>>();
	const addCandidate = (a: number, c: number): boolean => {
		if (a === c) return true;
		const [x, y] = a < c ? [a, c] : [c, a];
		const key = x * docs.length + y;
		if (candidates.has(key)) return true;
		if (candidates.size >= maxPairs) {
			outcome.truncated = true;
			return false;
		}
		candidates.set(key, new Set([x, y]));
		return true;
	};

	const MIN_SHARED_SHINGLES = 8;
	const inverted = new Map<number, number[]>();
	for (const i of eligible) {
		const hashes = docs[i].shingleHashes;
		if (!hashes) continue;
		for (const hash of hashes) {
			const list = inverted.get(hash);
			if (list) {
				if (list.length < 64) list.push(i);
			} else inverted.set(hash, [i]);
		}
	}
	const shared = new Map<number, number>();
	for (const list of inverted.values()) {
		if (list.length < 2 || list.length > 64) continue;
		for (let x = 0; x < list.length; x++) {
			for (let y = x + 1; y < list.length; y++) {
				const a = list[x];
				const c = list[y];
				const key = Math.min(a, c) * docs.length + Math.max(a, c);
				shared.set(key, (shared.get(key) ?? 0) + 1);
			}
		}
	}
	for (const [key, count] of shared) {
		if (count < MIN_SHARED_SHINGLES) continue;
		const a = Math.floor(key / docs.length);
		const c = key % docs.length;
		if (!addCandidate(a, c)) break;
	}

	if (!outcome.truncated) {
		const bands = Math.floor(SIGNATURE_LENGTH / BAND_ROWS);
		const buckets: Map<string, number[]>[] = new Array(bands);
		for (let b = 0; b < bands; b++) buckets[b] = new Map();
		for (const i of eligible) {
			const sig = docs[i].shingles!;
			if (uf.find(i) !== i) continue; // already an exact duplicate
			for (let b = 0; b < bands; b++) {
				const key = bucketKey(sig, b);
				const list = buckets[b].get(key);
				if (list) list.push(i);
				else buckets[b].set(key, [i]);
			}
		}
		outer: for (let b = 0; b < bands; b++) {
			for (const list of buckets[b].values()) {
				if (list.length < 2) continue;
				for (let x = 0; x < list.length; x++) {
					for (let y = x + 1; y < list.length; y++) {
						if (!addCandidate(list[x], list[y])) break outer;
					}
				}
			}
		}
	}

	// 3. Verify each candidate: exact when both notes kept their shingles.
	for (const [a, c] of candidates.values()) {
		outcome.comparisons++;
		const comparison = compareDocuments(docs[a], docs[c]);
		const similarity = comparison.jaccard;
		const isNear = similarity >= options.threshold;
		const isSubset =
			!isNear &&
			similarity >= options.threshold * 0.55 &&
			comparison.containment >= options.containmentThreshold &&
			Math.min(docs[a].shingleCount, docs[c].shingleCount) >= MIN_SHARED_SHINGLES;
		if (!isNear && !isSubset) continue;
		uf.union(a, c);
		const key = pairKey(a, c);
		const score = isSubset ? Math.min(1, Math.max(similarity, comparison.containment * 0.97)) : similarity;
		if ((bestSimilarity.get(key) ?? 0) < score) bestSimilarity.set(key, score);
		if (isSubset) subsetPairs.add(key);
	}

	// 3. Build clusters and pick representatives.
	const clusters = new Map<number, number[]>();
	for (const i of eligible) {
		const root = uf.find(i);
		const list = clusters.get(root);
		if (list) list.push(i);
		else clusters.set(root, [i]);
	}

	for (const members of clusters.values()) {
		if (members.length < 2) continue;
		const sorted = [...members].sort((a, c) => rank(docs[c]) - rank(docs[a]) || docs[a].file.path.localeCompare(docs[c].file.path));
		const representative = sorted[0];
		const duplicates: string[] = [];
		let weakest = 1;
		let kind: "exact" | "near" | "subset" = "exact";
		for (const member of sorted.slice(1)) {
			outcome.duplicateOf.set(docs[member].file.path, docs[representative].file.path);
			duplicates.push(docs[member].file.path);
			const key = pairKey(member, representative);
			const similarity = bestSimilarity.get(key) ?? options.threshold;
			weakest = Math.min(weakest, similarity);
			if (docs[member].hash !== docs[representative].hash) {
				if (kind === "exact") kind = "near";
				if (subsetPairs.has(key)) kind = "subset";
			}
		}
		outcome.groups.push({
			representative: docs[representative].file.path,
			duplicates,
			similarity: weakest,
			kind,
		});
	}

	return outcome;
}

/** Ranking used to decide which copy of a duplicate is kept. */
function rank(doc: DocAnalysis): number {
	// Longer, richer notes win; ties are broken by recency then path.
	return doc.stats.words * 1.0 + doc.signal * 100 + Math.min(doc.file.mtime, 4e12) / 1e10;
}

function pairKey(a: number, b: number): string {
	return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function bucketKey(sig: Uint32Array, band: number): string {
	const start = band * BAND_ROWS;
	let key = "";
	for (let i = start; i < start + BAND_ROWS; i++) key += sig[i].toString(36) + "|";
	return key;
}
