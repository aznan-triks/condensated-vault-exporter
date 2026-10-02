/**
 * The knowledge map: a compact, machine-readable "table of contents with
 * meaning" that is prepended to a bundle.
 *
 * Why it matters: when you push 40 notes into an LLM, the model has no idea
 * what the corpus *is*. A short map — themes, key terms, hubs, timeline,
 * reading order — measurably improves retrieval and lets the model answer
 * "what's in here?" without scanning everything.
 */

import type { DocAnalysis } from "../types";
import { formatCount } from "../util";
import type { LinkGraph } from "./graph";
import type { ThemeCluster } from "./similarity";

export interface KnowledgeMapInput {
	docs: DocAnalysis[];
	graph: LinkGraph;
	themes: ThemeCluster[];
	/** path -> {term, weight}[] — distinctive terms per note. */
	keyTerms: Map<string, { term: string; weight: number }[]>;
	/** Duplicate groups that were collapsed. */
	duplicates: { representative: string; duplicates: string[]; similarity: number; kind: "exact" | "near" | "subset" }[];
	/** Corpus-wide boilerplate samples that were removed. */
	boilerplate: { text: string; docs: number }[];
	stats: {
		discovered: number;
		kept: number;
		words: number;
		tokens: number;
		charCount: number;
	};
	roots: string[];
	generatedAt: Date;
	profileName: string;
	/** Paths actually present in the bundle (used to filter the graph views). */
	included?: string[];
	/** “Term — definition” pairs harvested from the notes. */
	glossary: { term: string; definition: string; path: string }[];
}

export interface KnowledgeMap {
	generatedAt: string;
	profile: string;
	roots: string[];
	overview: {
		notes: number;
		discovered: number;
		words: number;
		tokens: number;
		chars: number;
		readingMinutes: number;
		dateRange: { from: string; to: string } | null;
		folders: { path: string; notes: number; words: number }[];
	};
	keyTerms: { term: string; weight: number; notes: number }[];
	tags: { tag: string; count: number }[];
	themes: { id: number; label: string; notes: number; words: number; paths: string[] }[];
	hubs: { path: string; title: string; inbound: number; centrality: number }[];
	orphans: { path: string; title: string }[];
	brokenLinks: { from: string; target: string }[];
	timeline: { period: string; notes: number }[];
	duplicates: { representative: string; duplicates: string[]; similarity: number; kind: string }[];
	boilerplate: { text: string; docs: number }[];
	/** A suggested reading order: hubs first, then themes by size. */
	readingOrder: { path: string; title: string; reason: string }[];
	glossary: { term: string; definition: string; path: string }[];
}

export function buildKnowledgeMap(input: KnowledgeMapInput): KnowledgeMap {
	const { docs, graph } = input;
	const titleOf = new Map(docs.map((d) => [d.file.path, d.title]));
	const included = input.included ? new Set(input.included) : undefined;
	const inBundle = (path: string): boolean => included === undefined || included.has(path);

	const folderStats = new Map<string, { notes: number; words: number }>();
	for (const doc of docs) {
		const folder = doc.file.folder || "(root)";
		const entry = folderStats.get(folder) ?? { notes: 0, words: 0 };
		entry.notes++;
		entry.words += doc.stats.words;
		folderStats.set(folder, entry);
	}

	const termStats = new Map<string, { weight: number; notes: number }>();
	for (const terms of input.keyTerms.values()) {
		for (const { term, weight } of terms) {
			const entry = termStats.get(term) ?? { weight: 0, notes: 0 };
			entry.weight += weight;
			entry.notes++;
			termStats.set(term, entry);
		}
	}

	const tagStats = new Map<string, number>();
	for (const doc of docs) for (const tag of doc.tags) tagStats.set(tag, (tagStats.get(tag) ?? 0) + 1);

	let minTime = Number.POSITIVE_INFINITY;
	let maxTime = 0;
	for (const doc of docs) {
		const time = doc.file.mtime || 0;
		if (time > 0) {
			minTime = Math.min(minTime, time);
			maxTime = Math.max(maxTime, time);
		}
	}

	const timelineBuckets = new Map<string, number>();
	for (const doc of docs) {
		const period = periodOf(doc.file.mtime);
		timelineBuckets.set(period, (timelineBuckets.get(period) ?? 0) + 1);
	}

	const words = docs.reduce((acc, d) => acc + d.stats.words, 0);
	const tokens = docs.reduce((acc, d) => acc + d.stats.tokens, 0);
	const chars = docs.reduce((acc, d) => acc + d.stats.chars, 0);

	const readingOrder: { path: string; title: string; reason: string }[] = [];
	const pushed = new Set<string>();
	for (const hub of graph.hubs) {
		if (readingOrder.length >= 6) break;
		if (hub.inDegree === 0 || !inBundle(hub.path)) continue;
		readingOrder.push({
			path: hub.path,
			title: titleOf.get(hub.path) ?? hub.path,
			reason: hub.inDegree === 1 ? "linked from another note" : `hub — linked from ${hub.inDegree} notes`,
		});
		pushed.add(hub.path);
	}
	for (const theme of input.themes) {
		for (const path of theme.paths.slice(0, 2)) {
			if (pushed.has(path)) continue;
			pushed.add(path);
			readingOrder.push({ path, title: titleOf.get(path) ?? path, reason: `theme “${theme.label}”` });
		}
	}
	for (const doc of [...docs].sort((a, b) => b.signal - a.signal)) {
		if (readingOrder.length >= 12) break;
		if (pushed.has(doc.file.path)) continue;
		pushed.add(doc.file.path);
		readingOrder.push({ path: doc.file.path, title: doc.title, reason: "high information density" });
	}

	return {
		generatedAt: input.generatedAt.toISOString(),
		profile: input.profileName,
		roots: input.roots,
		overview: {
			notes: input.stats.kept,
			discovered: input.stats.discovered,
			words,
			tokens,
			chars,
			readingMinutes: words < 225 ? 0 : Math.round(words / 225),
			dateRange:
				Number.isFinite(minTime) && maxTime > 0
					? { from: new Date(minTime).toISOString().slice(0, 10), to: new Date(maxTime).toISOString().slice(0, 10) }
					: null,
			folders: Array.from(folderStats.entries())
				.map(([path, entry]) => ({ path, ...entry }))
				.sort((a, b) => b.words - a.words)
				.slice(0, 30),
		},
		keyTerms: Array.from(termStats.entries())
			.map(([term, entry]) => ({ term, weight: entry.weight, notes: entry.notes }))
			.sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
			.slice(0, 40),
		tags: Array.from(tagStats.entries())
			.map(([tag, count]) => ({ tag, count }))
			.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
			.slice(0, 40),
		themes: input.themes.map((theme) => ({
			id: theme.id,
			label: theme.label,
			notes: theme.paths.length,
			words: theme.words,
			paths: theme.paths,
		})),
		hubs: graph.hubs
			.filter((hub) => hub.inDegree > 0 && inBundle(hub.path))
			.slice(0, 15)
			.map((hub) => ({ path: hub.path, title: titleOf.get(hub.path) ?? hub.path, inbound: hub.inDegree, centrality: Number(hub.centrality.toFixed(3)) })),
		orphans: graph.orphans
			.filter((node) => inBundle(node.path))
			.slice(0, 40)
			.map((node) => ({ path: node.path, title: titleOf.get(node.path) ?? node.path })),
		brokenLinks: graph.broken
			.filter((b) => inBundle(b.from))
			.slice(0, 40)
			.map((b) => ({ from: b.from, target: b.target })),
		timeline: Array.from(timelineBuckets.entries())
			.map(([period, notes]) => ({ period, notes }))
			.sort((a, b) => a.period.localeCompare(b.period))
			.slice(-24),
		duplicates: input.duplicates.map((group) => ({
			representative: group.representative,
			duplicates: group.duplicates,
			similarity: Number(group.similarity.toFixed(3)),
			kind: group.kind,
		})),
		boilerplate: input.boilerplate,
		readingOrder,
		glossary: input.glossary.slice(0, 60),
	};
}

function periodOf(time: number): string {
	if (!time) return "unknown";
	const date = new Date(time);
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                  */
/* -------------------------------------------------------------------------- */

export interface MapRenderOptions {
	/** Include the reading-order suggestion. */
	readingOrder: boolean;
	/** Include the duplicate / boilerplate report. */
	quality: boolean;
	maxTerms: number;
	maxThemes: number;
}

const DEFAULT_RENDER: MapRenderOptions = { readingOrder: true, quality: true, maxTerms: 25, maxThemes: 12 };

export function knowledgeMapToMarkdown(map: KnowledgeMap, options: Partial<MapRenderOptions> = {}): string {
	const opts = { ...DEFAULT_RENDER, ...options };
	const lines: string[] = [];
	const o = map.overview;
	lines.push("## Corpus overview", "");
	lines.push(`- **${o.notes}** notes selected (out of ${o.discovered} discovered) across ${o.folders.length} folders`);
	lines.push(
		`- **${formatCount(o.words)} words** ≈ **${formatCount(o.tokens)} tokens** ≈ ${
			o.readingMinutes < 1 ? "under a minute" : `${o.readingMinutes} min`
		} of reading`,
	);
	if (o.dateRange) {
		lines.push(
			o.dateRange.from === o.dateRange.to
				? `- Content last modified on **${o.dateRange.from}**`
				: `- Content last modified between **${o.dateRange.from}** and **${o.dateRange.to}**`,
		);
	}
	if (map.tags.length > 0) {
		lines.push(`- Most used tags: ${map.tags.slice(0, 12).map((t) => `\`#${t.tag}\` (${t.count})`).join(", ")}`);
	}
	lines.push("");

	const folders = o.folders.filter((f) => f.notes > 1).slice(0, 10);
	if (folders.length > 1) {
		lines.push("### Where the content lives", "");
		for (const folder of folders) {
			lines.push(`- \`${folder.path}\` — ${folder.notes} notes, ${formatCount(folder.words)} words`);
		}
		lines.push("");
	}

	if (map.keyTerms.length > 0) {
		lines.push("### Key terms", "");
		lines.push(map.keyTerms.slice(0, opts.maxTerms).map((t) => `**${t.term}** (${t.notes})`).join(" · "));
		lines.push("");
	}

	if (map.themes.length > 0) {
		lines.push("### Themes detected", "");
		for (const theme of map.themes.slice(0, opts.maxThemes)) {
			lines.push(`**Theme ${theme.id} — ${theme.label}** — ${theme.notes} notes, ${formatCount(theme.words)} words`);
			lines.push("");
			for (const path of theme.paths.slice(0, 8)) lines.push(`- ${path}`);
			if (theme.paths.length > 8) lines.push(`- … and ${theme.paths.length - 8} more`);
			lines.push("");
		}
	}

	if (map.hubs.length > 0) {
		lines.push("### Central notes (most referenced)", "");
		for (const hub of map.hubs.slice(0, 10)) {
			lines.push(`- ${hub.title} — \`${hub.path}\` (${hub.inbound} incoming links)`);
		}
		lines.push("");
	}

	if (map.timeline.length > 1) {
		lines.push("### Timeline", "");
		lines.push(map.timeline.map((t) => `\`${t.period}\`: ${t.notes}`).join(" · "));
		lines.push("");
	}

	if (map.glossary.length > 0) {
		lines.push("### Glossary", "");
		for (const entry of map.glossary) {
			lines.push(`- **${entry.term}** — ${entry.definition}  \`(${entry.path})\``);
		}
		lines.push("");
	}

	if (opts.readingOrder && map.readingOrder.length > 0) {
		lines.push("### Suggested reading order", "");
		map.readingOrder.forEach((entry, index) => {
			lines.push(`${index + 1}. ${entry.title} — \`${entry.path}\` (${entry.reason})`);
		});
		lines.push("");
	}

	if (opts.quality) {
		const rows: string[] = [];
		if (map.duplicates.length > 0) {
			rows.push(`- **${map.duplicates.length} duplicate group(s)** were collapsed to a single copy:`);
			for (const group of map.duplicates.slice(0, 10)) {
				rows.push(`  - kept \`${group.representative}\` (${group.kind}, similarity ${group.similarity}) — removed ${group.duplicates.length} copy(ies)`);
			}
		}
		if (map.orphans.length > 0) {
			rows.push(`- **${map.orphans.length} unlinked notes** (no in/out links inside the selection)`);
		}
		if (map.brokenLinks.length > 0) {
			rows.push(`- **${map.brokenLinks.length} broken link(s)**, e.g. \`${map.brokenLinks[0].from}\` → “${map.brokenLinks[0].target}”`);
		}
		if (map.boilerplate.length > 0) {
			rows.push(
				`- **Repeated lines** were removed as boilerplate, e.g. ${map.boilerplate
					.slice(0, 3)
					.map((b) => `“${escapeMarkdown(b.text)}” (in ${b.docs} notes)`)
					.join(", ")}`,
			);
		}
		if (rows.length > 0) {
			lines.push("### Quality report", "", ...rows, "");
		}
	}

	return lines.join("\n").trim();
}

export function knowledgeMapToText(map: KnowledgeMap, options: Partial<MapRenderOptions> = {}): string {
	const markdown = knowledgeMapToMarkdown(map, options);
	return markdown
		.replace(/^#{1,6}\s*/gm, "")
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1");
}

function escapeMarkdown(text: string): string {
	return text.replace(/[*_`[\]]/g, (c) => `\\${c}`);
}
