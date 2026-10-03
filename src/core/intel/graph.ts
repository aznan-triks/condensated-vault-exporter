/**
 * Link graph & topological analysis over the selected corpus.
 *
 * Produces the statistics that make a bundle feel "aware" of itself:
 * - PageRank centrality (used as a ranking signal when a token budget drops notes)
 * - HITS Hub & Authority scores (separating Maps of Content from foundational notes)
 * - Bridge notes (notes connecting distinct folders or clusters)
 * - Phantom notes (missing targets referenced across multiple notes)
 * - Orphans, dead ends, and broken links.
 */

import type { DocAnalysis } from "../types";
import { buildNameIndex, resolveLinkTarget } from "../markdown/links";
import { dirName, normalizeVaultPath } from "../util";

export interface GraphNode {
	path: string;
	inDegree: number;
	outDegree: number;
	/** PageRank-like centrality in [0,1] (relative to the maximum). */
	centrality: number;
	/** HITS hub score in [0,1] (high for Maps of Content / index notes). */
	hubScore: number;
	/** HITS authority score in [0,1] (high for foundational reference notes). */
	authorityScore: number;
	/** Number of distinct folders bridged by this note's immediate neighbourhood. */
	foldersBridged: number;
	/** True when the note has no in- or out-links inside the corpus. */
	orphan: boolean;
	/** Resolved outgoing targets inside the corpus, in link order. */
	links: string[];
	/** Resolved incoming sources inside the corpus, in encounter order. */
	backlinks: string[];
	/** Distinct outgoing targets that point outside the corpus. */
	outside: number;
}

export interface BrokenLink {
	from: string;
	target: string;
}

export interface PhantomNote {
	/** Normalized missing target name. */
	target: string;
	/** Paths of notes in the corpus that link to this missing target. */
	referencedBy: string[];
	/** Number of distinct notes referencing this missing target. */
	count: number;
}

export interface LinkGraph {
	nodes: Map<string, GraphNode>;
	/** Most-referenced notes (sorted by in-degree, then centrality). */
	hubs: GraphNode[];
	/** Maps of Content / index notes (sorted by HITS hubScore & out-degree). */
	mocs: GraphNode[];
	/** Notes that bridge different folders or structural clusters. */
	bridges: GraphNode[];
	orphans: GraphNode[];
	broken: BrokenLink[];
	/** Total unresolved targets, even beyond the reported sample. */
	brokenTotal: number;
	/** Missing notes referenced by corpus notes, ordered by citation count. */
	phantoms: PhantomNote[];
	/** Notes that are only reachable from other notes and have no outgoing links. */
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
	const titleIndex = new Map<string, string>();
	for (const doc of docs) {
		pathIndex.set(doc.file.path.toLowerCase(), doc.file.path);
		if (doc.title) {
			const cleanTitle = doc.title.trim().toLowerCase();
			if (cleanTitle !== "" && !titleIndex.has(cleanTitle)) titleIndex.set(cleanTitle, doc.file.path);
		}
		for (const alias of doc.aliases) {
			const cleanAlias = alias.trim().toLowerCase();
			if (cleanAlias !== "" && !titleIndex.has(cleanAlias)) titleIndex.set(cleanAlias, doc.file.path);
		}
	}
	const nameIndex = buildNameIndex(docs.map((doc) => doc.file.path));
	for (const doc of docs) {
		nodes.set(doc.file.path, {
			path: doc.file.path,
			inDegree: 0,
			outDegree: 0,
			centrality: 0,
			hubScore: 0,
			authorityScore: 0,
			foldersBridged: 0,
			orphan: false,
			links: [],
			backlinks: [],
			outside: 0,
		});
	}

	const edges: { from: string; to: string }[] = [];
	const broken: BrokenLink[] = [];
	const phantomMap = new Map<string, { display: string; sources: Set<string> }>();
	let brokenTotal = 0;

	for (const doc of docs) {
		const seen = new Set<string>();
		for (const target of doc.outgoing) {
			const cleanLookup = target.replace(/\.md$/i, "").trim().toLowerCase();
			const resolved =
				resolveLinkTarget(target, doc.file.path, pathIndex, nameIndex) ?? titleIndex.get(cleanLookup);
			if (!resolved) {
				brokenTotal++;
				if (broken.length < opts.maxBrokenReported) broken.push({ from: doc.file.path, target });
				const cleanTarget = target.replace(/\.md$/i, "").trim();
				const key = cleanTarget.toLowerCase();
				if (key !== "") {
					if (!seen.has(`\u0000${key}`)) {
						seen.add(`\u0000${key}`);
						nodes.get(doc.file.path)!.outside++;
					}
					const entry = phantomMap.get(key);
					if (entry) entry.sources.add(doc.file.path);
					else phantomMap.set(key, { display: cleanTarget, sources: new Set([doc.file.path]) });
				}
				continue;
			}
			if (resolved === doc.file.path || seen.has(resolved)) continue;
			seen.add(resolved);
			edges.push({ from: doc.file.path, to: resolved });
			const source = nodes.get(doc.file.path)!;
			const destination = nodes.get(resolved)!;
			source.outDegree++;
			source.links.push(resolved);
			destination.inDegree++;
			destination.backlinks.push(doc.file.path);
		}
	}

	// Reverse edges for the PageRank and HITS sweeps.
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

	// HITS (Hyperlink-Induced Topic Search) power iteration to distinguish
	// Maps of Content (hubs) from foundational concepts (authorities).
	let hubVec = new Map<string, number>();
	let authVec = new Map<string, number>();
	for (const path of nodes.keys()) {
		hubVec.set(path, 1);
		authVec.set(path, 1);
	}
	if (edges.length > 0) {
		const hitsSteps = Math.min(12, opts.iterations);
		for (let step = 0; step < hitsSteps; step++) {
			const nextAuth = new Map<string, number>();
			let authNorm = 0;
			for (const path of nodes.keys()) {
				const sources = inbound.get(path) ?? [];
				let s = 0;
				for (const src of sources) s += hubVec.get(src) ?? 0;
				nextAuth.set(path, s);
				authNorm += s * s;
			}
			authNorm = Math.sqrt(authNorm) || 1;
			for (const [p, v] of nextAuth) nextAuth.set(p, v / authNorm);
			authVec = nextAuth;

			const nextHub = new Map<string, number>();
			let hubNorm = 0;
			for (const [path, node] of nodes) {
				let s = 0;
				for (const dst of node.links) s += authVec.get(dst) ?? 0;
				nextHub.set(path, s);
				hubNorm += s * s;
			}
			hubNorm = Math.sqrt(hubNorm) || 1;
			for (const [p, v] of nextHub) nextHub.set(p, v / hubNorm);
			hubVec = nextHub;
		}
	}

	let maxRank = 0;
	let maxHub = 0;
	let maxAuth = 0;
	for (const path of nodes.keys()) {
		maxRank = Math.max(maxRank, rank.get(path) ?? 0);
		maxHub = Math.max(maxHub, hubVec.get(path) ?? 0);
		maxAuth = Math.max(maxAuth, authVec.get(path) ?? 0);
	}

	for (const node of nodes.values()) {
		node.centrality = maxRank > 0 ? (rank.get(node.path) ?? 0) / maxRank : 0;
		node.hubScore = maxHub > 0 ? (hubVec.get(node.path) ?? 0) / maxHub : 0;
		node.authorityScore = maxAuth > 0 ? (authVec.get(node.path) ?? 0) / maxAuth : 0;
		node.orphan = node.inDegree === 0 && node.outDegree === 0;

		const folders = new Set<string>();
		folders.add(dirName(node.path));
		for (const l of node.links) folders.add(dirName(l));
		for (const b of node.backlinks) folders.add(dirName(b));
		node.foldersBridged = folders.size;
	}

	const all = Array.from(nodes.values());
	// A "hub" must actually be referenced: sorting every note by in-degree would
	// label untouched notes as hubs just because they happen to be first.
	const referenced = all.filter((node) => node.inDegree > 0);
	const hubs = (referenced.length > 0 ? referenced : all)
		.sort((a, b) => b.inDegree - a.inDegree || b.centrality - a.centrality || a.path.localeCompare(b.path))
		.slice(0, 25);

	const mocs = all
		.filter((node) => node.outDegree >= 2)
		.sort((a, b) => b.outDegree - a.outDegree || b.hubScore - a.hubScore || a.path.localeCompare(b.path))
		.slice(0, 15);

	const bridges = all
		.filter((node) => (node.inDegree > 0 && node.outDegree > 0) || node.foldersBridged >= 2)
		.filter((node) => node.inDegree + node.outDegree >= 2)
		.sort(
			(a, b) =>
				b.foldersBridged - a.foldersBridged ||
				b.inDegree * b.outDegree - a.inDegree * a.outDegree ||
				b.centrality - a.centrality ||
				a.path.localeCompare(b.path),
		)
		.slice(0, 15);

	const orphans = all.filter((node) => node.orphan).sort((a, b) => a.path.localeCompare(b.path));
	const deadEnds = all
		.filter((node) => node.outDegree === 0 && node.inDegree > 0)
		.sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path))
		.slice(0, 25);

	const phantoms: PhantomNote[] = Array.from(phantomMap.values())
		.map((entry) => ({
			target: entry.display,
			referencedBy: Array.from(entry.sources).sort(),
			count: entry.sources.size,
		}))
		.sort((a, b) => b.count - a.count || a.target.localeCompare(b.target))
		.slice(0, 25);

	return { nodes, hubs, mocs, bridges, orphans, broken, brokenTotal, phantoms, deadEnds };
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
