/**
 * Obsidian JSON Canvas (`.canvas`) parser & Markdown converter.
 *
 * Obsidian Canvas files store spatial knowledge boards as JSON (`nodes` and
 * `edges`). Raw JSON is noisy and hard for LLMs or human readers to follow.
 * This module converts a `.canvas` file into structured Markdown:
 * - Resolves spatial containment so cards inside a visual `group` bounding box
 *   are rendered under that group's heading
 * - Orders groups and cards top-to-bottom, left-to-right (`y`, then `x`)
 * - Converts `file` cards into standard `[[wiki-links]]` so they participate in
 *   the corpus link graph and transclusion engine
 * - Renders directed `edges` (and their labels) as an explicit `## Connections`
 *   section so the board's topology is preserved in text.
 */

import { basename, stripExtension } from "../util";

export interface CanvasNode {
	id: string;
	type: "text" | "file" | "link" | "group" | string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	text?: string;
	file?: string;
	subpath?: string;
	url?: string;
	label?: string;
	color?: string;
}

export interface CanvasEdge {
	id?: string;
	fromNode: string;
	toNode: string;
	fromSide?: string;
	toSide?: string;
	label?: string;
}

export interface CanvasDocument {
	nodes?: CanvasNode[];
	edges?: CanvasEdge[];
}

function spatialCompare(a: CanvasNode, b: CanvasNode): number {
	const ay = typeof a.y === "number" ? a.y : 0;
	const by = typeof b.y === "number" ? b.y : 0;
	// Group into horizontal rows within a 40px tolerance so slightly misaligned
	// cards in the same row still read left-to-right.
	if (Math.abs(ay - by) > 40) return ay - by;
	const ax = typeof a.x === "number" ? a.x : 0;
	const bx = typeof b.x === "number" ? b.x : 0;
	if (ax !== bx) return ax - bx;
	return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

function isInsideGroup(node: CanvasNode, group: CanvasNode): boolean {
	if (
		typeof node.x !== "number" ||
		typeof node.y !== "number" ||
		typeof group.x !== "number" ||
		typeof group.y !== "number" ||
		typeof group.width !== "number" ||
		typeof group.height !== "number"
	) {
		return false;
	}
	const nw = typeof node.width === "number" ? node.width : 0;
	const nh = typeof node.height === "number" ? node.height : 0;
	const cx = node.x + nw / 2;
	const cy = node.y + nh / 2;
	return cx >= group.x && cx <= group.x + group.width && cy >= group.y && cy <= group.y + group.height;
}

function summarizeNode(node: CanvasNode, index: number): string {
	if (node.type === "group") {
		return node.label?.trim() || `Group ${index}`;
	}
	if (node.type === "file" && node.file) {
		const sub = node.subpath ? node.subpath : "";
		return `[[${node.file}${sub}]]`;
	}
	if (node.type === "link" && node.url) {
		return node.label ? `[${node.label}](${node.url})` : node.url;
	}
	if (node.text) {
		const firstLine = node.text
			.split(/\r?\n/)
			.map((l) => l.replace(/^#+\s*/, "").trim())
			.find((l) => l.length > 0);
		if (firstLine) {
			return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
		}
	}
	return `Card ${index}`;
}

function renderCard(node: CanvasNode): string {
	if (node.type === "file" && node.file) {
		const sub = node.subpath ? node.subpath : "";
		return `- **Linked note**: [[${node.file}${sub}]]`;
	}
	if (node.type === "link" && node.url) {
		return node.label ? `- **External link**: [${node.label}](${node.url})` : `- **External link**: ${node.url}`;
	}
	const text = (node.text ?? "").trim();
	return text;
}

/**
 * Converts raw `.canvas` JSON into clean, structured Markdown. If `raw` is not
 * valid Canvas JSON, returns `raw` unchanged.
 */
export function convertCanvasToMarkdown(raw: string, canvasPath = "Board.canvas"): string {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("{")) return raw;

	let parsed: CanvasDocument;
	try {
		parsed = JSON.parse(trimmed) as CanvasDocument;
	} catch {
		return raw;
	}
	if (!parsed || typeof parsed !== "object" || (!Array.isArray(parsed.nodes) && !Array.isArray(parsed.edges))) {
		return raw;
	}

	const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes.filter((n): n is CanvasNode => Boolean(n && typeof n === "object")) : [];
	const rawEdges = Array.isArray(parsed.edges) ? parsed.edges.filter((e): e is CanvasEdge => Boolean(e && typeof e === "object")) : [];

	const title = stripExtension(basename(canvasPath)) || "Canvas";
	const lines: string[] = [`# ${title}`, ""];

	const groups = rawNodes.filter((n) => n.type === "group").sort(spatialCompare);
	const cards = rawNodes.filter((n) => n.type !== "group").sort(spatialCompare);

	const nodeLabelById = new Map<string, string>();
	rawNodes.forEach((node, idx) => {
		if (node.id) nodeLabelById.set(node.id, summarizeNode(node, idx + 1));
	});

	// Assign cards to their smallest enclosing group (if any).
	const groupChildren = new Map<string, CanvasNode[]>();
	for (const g of groups) groupChildren.set(g.id, []);
	const ungrouped: CanvasNode[] = [];

	for (const card of cards) {
		const containing = groups
			.filter((g) => isInsideGroup(card, g))
			.sort((a, b) => (a.width ?? 0) * (a.height ?? 0) - (b.width ?? 0) * (b.height ?? 0));
		if (containing.length > 0) {
			groupChildren.get(containing[0].id)!.push(card);
		} else {
			ungrouped.push(card);
		}
	}

	for (const group of groups) {
		const label = group.label?.trim() || "Untitled group";
		lines.push(`## ${label}`, "");
		const children = groupChildren.get(group.id) ?? [];
		for (const child of children) {
			const rendered = renderCard(child);
			if (rendered !== "") lines.push(rendered, "");
		}
	}

	if (ungrouped.length > 0) {
		if (groups.length > 0) lines.push("## Board cards", "");
		for (const card of ungrouped) {
			const rendered = renderCard(card);
			if (rendered !== "") lines.push(rendered, "");
		}
	}

	if (rawEdges.length > 0) {
		lines.push("## Connections", "");
		for (const edge of rawEdges) {
			const fromLabel = nodeLabelById.get(edge.fromNode) ?? edge.fromNode;
			const toLabel = nodeLabelById.get(edge.toNode) ?? edge.toNode;
			const edgeLabel = edge.label?.trim();
			if (edgeLabel) {
				lines.push(`- ${fromLabel} — *${edgeLabel}* → ${toLabel}`);
			} else {
				lines.push(`- ${fromLabel} → ${toLabel}`);
			}
		}
		lines.push("");
	}

	return lines.join("\n").trim() + "\n";
}
