/**
 * Link graph over the selected corpus.
 *
 * Produces the statistics that make a bundle feel "aware" of itself: hubs,
 * orphans, broken links, folder connectivity and per-note centrality (used as
 * a ranking signal when a token budget forces us to drop notes).
 */

import type { DocAnalysis } from "../types";
import { buildNameIndex, resolveLinkTarget } from "../markdown/links";
import { normalizeVaultPath } from "../util";

export interface GraphNode {
	path: string;
	inDegree: number;
	outDegree: number;
	/** PageRank-like centrality in [0,1] (relative to the maximum). */
	centrality: number;
	/** True when the note has no in- or out-links inside the corpus. */
	orphan: boolean;
}

export interface BrokenLink {
	from: string;
	target: string;
}

export interface LinkGraph {
	nodes: Map<string, GraphNode>;
	hubs: GraphNode[];
	orphans: GraphNode[];
	broken: BrokenLink[];
	/** Notes that are only reachable from a single other note. */
	deadEnds: GraphNode[];
}

export interface GraphOptions {
	/** Damping factor of the PageRank computation. */
	damping: number;
	iterations: number;
	maxBrokenReported: number;
}

const DEFAULT_OPTIONS: GraphOptions = { damping: 0.85, iterations: 20, maxBrokenReported: 200 };

export function buildLinkGraph(docs: DocAnalysis[], options: Partial<GraphOptions> = {}): LinkGraph {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const nodes = new Map<string, GraphNode>();
	const pathIndex = new Map<string, string>();
	for (const doc of docs) pathIndex.set(doc.file.path.toLowerCase(), doc.file.path);
	const nameIndex = buildNameIndex(docs.map((doc) => doc.file.path));
	for (const doc of docs) {
		nodes.set(doc.file.path, {
			path: doc.file.path,
			inDegree: 0,
			outDegree: 0,
			centrality: 0,
			orphan: false,
		});
	}

	const edges: { from: string; to: string }[] = [];
	const broken: BrokenLink[] = [];
	for (const doc of docs) {
		const seen = new Set<string>();
		for (const target of doc.outgoing) {
			const resolved = resolveLinkTarget(target, doc.file.path, pathIndex, nameIndex);
			if (!resolved) {
				if (broken.length < opts.maxBrokenReported) broken.push({ from: doc.file.path, target });
				continue;
			}
			if (resolved === doc.file.path || seen.has(resolved)) continue;
			seen.add(resolved);
			edges.push({ from: doc.file.path, to: resolved });
			nodes.get(doc.file.path)!.outDegree++;
			nodes.get(resolved)!.inDegree++;
		}
	}

	// Reverse edges for the PageRank sweep.
	const inbound = new Map<string, string[]>();
	for (const edge of edges) {
		const list = inbound.get(edge.to);
		if (list) list.push(edge.from);
		else inbound.set(edge.to, [edge.from]);
	}

	const n = Math.max(1, docs.length);
	let rank = new Map<string, number>();
	for (const path of nodes.keys()) rank.set(path, 1 / n);
	for (let iteration = 0; iteration < opts.iterations; iteration++) {
		const next = new Map<string, number>();
		let dangling = 0;
		for (const [path, value] of rank) {
			const out = nodes.get(path)!.outDegree;
			if (out === 0) dangling += value;
		}
		for (const path of nodes.keys()) {
			const sources = inbound.get(path) ?? [];
			let sum = 0;
			for (const source of sources) {
				const sourceOut = nodes.get(source)!.outDegree;
				if (sourceOut > 0) sum += (rank.get(source) ?? 0) / sourceOut;
			}
			next.set(path, (1 - opts.damping) / n + opts.damping * (sum + dangling / n));
		}
		rank = next;
	}

	let max = 0;
	for (const value of rank.values()) max = Math.max(max, value);
	for (const node of nodes.values()) {
		node.centrality = max > 0 ? (rank.get(node.path) ?? 0) / max : 0;
		node.orphan = node.inDegree === 0 && node.outDegree === 0;
	}

	const all = Array.from(nodes.values());
	// A "hub" must actually be referenced: sorting every note by in-degree would
	// label untouched notes as hubs just because they happen to be first.
	const referenced = all.filter((node) => node.inDegree > 0);
	const hubs = (referenced.length > 0 ? referenced : all)
		.sort((a, b) => b.inDegree - a.inDegree || b.centrality - a.centrality || a.path.localeCompare(b.path))
		.slice(0, 25);
	const orphans = all.filter((node) => node.orphan).sort((a, b) => a.path.localeCompare(b.path));
	const deadEnds = all
		.filter((node) => node.outDegree === 0 && node.inDegree > 0)
		.sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path))
		.slice(0, 25);
	return { nodes, hubs, orphans, broken, deadEnds };
}

/** Resolves link targets once, for reuse by the renderer. */
export function buildPathIndex(docs: { path: string }[]): Map<string, string> {
	const index = new Map<string, string>();
	for (const doc of docs) {
		const path = normalizeVaultPath(doc.path);
		index.set(path.toLowerCase(), path);
	}
	return index;
}
