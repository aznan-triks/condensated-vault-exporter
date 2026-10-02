/**
 * "Related notes" index.
 *
 * For each note, the k most similar notes are computed from MinHash
 * signatures (LSH for candidates, then exact signature agreement). This is
 * what makes the bundle navigable for a model: every note can carry a short
 * `Related:` line, and the knowledge map can group the corpus into themes.
 */

import type { DocAnalysis } from "../types";
import { signatureSimilarity } from "../markdown/analyzer";
import { buildLshIndex, candidatesOf } from "./lsh";

export interface RelatedOptions {
	topK: number;
	/** Minimum similarity to be reported. */
	minSimilarity: number;
}

export interface RelatedIndex {
	/** path -> [{ path, similarity }] (descending similarity). */
	byPath: Map<string, { path: string; similarity: number }[]>;
	/** Mean similarity of each note to its neighbourhood (0 when isolated). */
	cohesion: Map<string, number>;
}

export function buildRelatedIndex(docs: DocAnalysis[], options: RelatedOptions): RelatedIndex {
	const byPath = new Map<string, { path: string; similarity: number }[]>();
	const cohesion = new Map<string, number>();
	if (docs.length < 2 || options.topK <= 0) return { byPath, cohesion };

	const withSig: number[] = [];
	for (let i = 0; i < docs.length; i++) if (docs[i].shingles) withSig.push(i);
	if (withSig.length < 2) return { byPath, cohesion };

	const signatures = docs.map((d) => d.shingles);
	const index = buildLshIndex(signatures);

	for (const i of withSig) {
		const candidates = candidatesOf(index, signatures[i], i, 300);
		const scored: { path: string; similarity: number }[] = [];
		for (const c of candidates) {
			const similarity = signatureSimilarity(signatures[i], signatures[c]);
			if (similarity >= options.minSimilarity) scored.push({ path: docs[c].file.path, similarity });
		}
		scored.sort((a, b) => b.similarity - a.similarity || a.path.localeCompare(b.path));
		const top = scored.slice(0, options.topK);
		byPath.set(docs[i].file.path, top);
		if (top.length > 0) {
			cohesion.set(docs[i].file.path, top.reduce((acc, r) => acc + r.similarity, 0) / top.length);
		}
	}
	return { byPath, cohesion };
}

/**
 * Groups documents into themes by propagating along "related" edges
 * (union-find over edges above `minSimilarity`). Returns groups of >= minSize
 * documents, each labelled with its most characteristic shared terms.
 */
export interface ThemeCluster {
	id: number;
	paths: string[];
	label: string;
	terms: string[];
	words: number;
}

export function buildThemes(
	docs: DocAnalysis[],
	related: RelatedIndex,
	options: { minSimilarity: number; minSize: number; maxThemes: number },
): ThemeCluster[] {
	const index = new Map<string, number>();
	for (let i = 0; i < docs.length; i++) index.set(docs[i].file.path, i);

	const parent = new Array<number>(docs.length);
	for (let i = 0; i < docs.length; i++) parent[i] = i;
	const find = (x: number): number => {
		let root = x;
		while (parent[root] !== root) root = parent[root];
		while (parent[x] !== root) {
			const next = parent[x];
			parent[x] = root;
			x = next;
		}
		return root;
	};
	const union = (a: number, b: number) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent[rb] = ra;
	};

	for (const [path, neighbours] of related.byPath) {
		const from = index.get(path);
		if (from === undefined) continue;
		for (const neighbour of neighbours) {
			if (neighbour.similarity < options.minSimilarity) continue;
			const to = index.get(neighbour.path);
			if (to !== undefined) union(from, to);
		}
	}

	const groups = new Map<number, number[]>();
	for (let i = 0; i < docs.length; i++) {
		const root = find(i);
		const list = groups.get(root);
		if (list) list.push(i);
		else groups.set(root, [i]);
	}

	const clusters: ThemeCluster[] = [];
	for (const members of groups.values()) {
		if (members.length < options.minSize) continue;
		const termCounts = new Map<string, number>();
		let words = 0;
		const paths: string[] = [];
		for (const m of members) {
			words += docs[m].stats.words;
			paths.push(docs[m].file.path);
			for (const term of docs[m].topTerms.slice(0, 8)) {
				termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
			}
		}
		const terms = Array.from(termCounts.entries())
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, 6)
			.map(([term]) => term);
		paths.sort((a, b) => a.localeCompare(b));
		clusters.push({
			id: 0,
			paths,
			terms,
			label: terms.slice(0, 3).join(" · ") || paths[0],
			words,
		});
	}

	clusters.sort((a, b) => b.paths.length - a.paths.length || b.words - a.words);
	const limited = clusters.slice(0, options.maxThemes);
	limited.forEach((cluster, i) => (cluster.id = i + 1));
	return limited;
}
