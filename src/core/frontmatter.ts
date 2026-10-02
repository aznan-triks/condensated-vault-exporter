/**
 * A pragmatic YAML-subset parser tailored to Obsidian frontmatter.
 *
 * It intentionally does not implement the whole YAML spec: it covers what
 * people actually write in notes (scalars, quoted strings, nested maps, lists,
 * inline arrays/objects, block scalars, comments) and degrades gracefully —
 * an unparsable value is kept as a raw string rather than throwing, because a
 * malformed frontmatter must never break an export.
 */

import type { Frontmatter, FrontmatterValue } from "./types";

const DELIMITER = /^(-{3,}|\.{3,})\s*$/;

export function parseFrontmatter(text: string): Frontmatter {
	const empty: Frontmatter = { present: false, raw: "", endLine: 0, data: {} };
	if (!text) return empty;

	let body = text;
	let offset = 0;
	if (body.charCodeAt(0) === 0xfe_ff) {
		body = body.slice(1);
		offset = 1;
	}
	// Leading blank lines are tolerated by Obsidian's cache; be permissive.
	const firstLineEnd = body.indexOf("\n");
	const firstLine = firstLineEnd === -1 ? body : body.slice(0, firstLineEnd);
	if (firstLine.replace(/\r$/, "").trim() !== "---") return empty;

	const lines = body.split(/\r?\n/);
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (DELIMITER.test(lines[i].trim())) {
			end = i;
			break;
		}
	}
	if (end === -1) {
		// Unterminated frontmatter: Obsidian treats the whole file as body.
		return { ...empty, error: "Unterminated frontmatter" };
	}

	const raw = lines.slice(1, end).join("\n");
	let data: Record<string, FrontmatterValue> = {};
	let error: string | undefined;
	try {
		data = parseYamlBlock(raw);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
		data = {};
	}
	void offset;
	return { present: true, raw, endLine: end + 1, data, error };
}

export function stripFrontmatter(text: string): string {
	const fm = parseFrontmatter(text);
	if (!fm.present) return text;
	const lines = text.split(/\r?\n/);
	return lines.slice(fm.endLine).join("\n").replace(/^\n+/, "");
}

/* -------------------------------------------------------------------------- */
/*  YAML subset parser                                                         */
/* -------------------------------------------------------------------------- */

interface Line {
	indent: number;
	content: string;
	raw: string;
	index: number;
}

function tokenize(raw: string): Line[] {
	const out: Line[] = [];
	const lines = raw.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "") continue;
		const match = /^(\s*)(.*)$/.exec(line);
		const indent = match ? match[1].replace(/\t/g, "  ").length : 0;
		out.push({ indent, content: stripComment(line.trim()), raw: line, index: i });
	}
	return out;
}

/** Removes a trailing `# comment` that is not inside quotes. */
function stripComment(text: string): string {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle && text[i - 1] !== "\\") inDouble = !inDouble;
		else if (ch === "#" && !inSingle && !inDouble) {
			if (i === 0 || /\s/.test(text[i - 1])) return text.slice(0, i).trimEnd();
		}
	}
	return text;
}

export function parseYamlBlock(raw: string): Record<string, FrontmatterValue> {
	const lines = tokenize(raw);
	const [value, consumed] = parseNode(lines, 0, 0);
	void consumed;
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, FrontmatterValue>;
	}
	if (Array.isArray(value)) return { items: value };
	return {};
}

function parseNode(lines: Line[], start: number, indent: number): [FrontmatterValue, number] {
	if (start >= lines.length) return [null, start];
	const first = lines[start];
	if (first.content.startsWith("- ") || first.content === "-") {
		return parseSequence(lines, start, first.indent);
	}
	return parseMapping(lines, start, first.indent);
}

function parseMapping(lines: Line[], start: number, indent: number): [Record<string, FrontmatterValue>, number] {
	const map: Record<string, FrontmatterValue> = {};
	let i = start;
	while (i < lines.length) {
		const line = lines[i];
		if (line.indent < indent) break;
		if (line.indent > indent) {
			// Stray over-indented line: ignore rather than fail.
			i++;
			continue;
		}
		if (line.content.startsWith("- ")) break;
		const sep = findKeySeparator(line.content);
		if (sep === -1) {
			i++;
			continue;
		}
		const key = unquote(line.content.slice(0, sep).trim());
		const rest = line.content.slice(sep + 1).trim();
		if (rest === "" || rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
			const blockStyle = rest.startsWith("|") || rest.startsWith(">");
			const next = lines[i + 1];
			if (blockStyle) {
				const [text, nextIndex] = readBlockScalar(lines, i + 1, rest.startsWith(">"));
				map[key] = text;
				i = nextIndex;
				continue;
			}
			if (next && next.indent > line.indent) {
				const [child, nextIndex] = parseNode(lines, i + 1, next.indent);
				map[key] = child;
				i = nextIndex;
				continue;
			}
			map[key] = null;
			i++;
			continue;
		}
		map[key] = parseScalar(rest);
		i++;
	}
	return [map, i];
}

function parseSequence(lines: Line[], start: number, indent: number): [FrontmatterValue[], number] {
	const items: FrontmatterValue[] = [];
	let i = start;
	while (i < lines.length) {
		const line = lines[i];
		if (line.indent !== indent) {
			if (line.indent < indent) break;
			i++;
			continue;
		}
		if (!line.content.startsWith("-")) break;
		const rest = line.content.slice(1).trim();
		if (rest === "") {
			const next = lines[i + 1];
			if (next && next.indent > indent) {
				const [child, nextIndex] = parseNode(lines, i + 1, next.indent);
				items.push(child);
				i = nextIndex;
				continue;
			}
			items.push(null);
			i++;
			continue;
		}
		const sep = findKeySeparator(rest);
		if (sep > 0 && !rest.startsWith("[") && !rest.startsWith("{")) {
			// Inline map inside a list item (`- key: value`), possibly multi-line.
			const map: Record<string, FrontmatterValue> = {};
			const key = unquote(rest.slice(0, sep).trim());
			const value = rest.slice(sep + 1).trim();
			map[key] = value === "" ? null : parseScalar(value);
			let j = i + 1;
			while (j < lines.length && lines[j].indent > indent) j++;
			if (j > i + 1) {
				const [child] = parseMapping(lines, i + 1, lines[i + 1].indent);
				Object.assign(map, child);
			}
			items.push(map);
			i = j;
			continue;
		}
		items.push(parseScalar(rest));
		i++;
	}
	return [items, i];
}

function readBlockScalar(lines: Line[], start: number, folded: boolean): [string, number] {
	const collected: string[] = [];
	let i = start;
	const baseIndent = lines[start]?.indent ?? 0;
	while (i < lines.length && lines[i].indent >= baseIndent) {
		collected.push(lines[i].raw.slice(baseIndent));
		i++;
	}
	return [folded ? collected.join(" ") : collected.join("\n"), i];
}

/** Finds the `:` that separates a key from its value, ignoring quoted keys. */
function findKeySeparator(text: string): number {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (ch === ":" && !inSingle && !inDouble) {
			const next = text[i + 1];
			if (next === undefined || next === " " || next === "\t") return i;
		}
	}
	return -1;
}

export function parseScalar(raw: string): FrontmatterValue {
	const text = raw.trim();
	if (text === "" || text === "~" || text.toLowerCase() === "null") return null;
	if (text.startsWith("[") && text.endsWith("]")) {
		return splitInline(text.slice(1, -1)).map((part) => parseScalar(part));
	}
	if (text.startsWith("{") && text.endsWith("}")) {
		const map: Record<string, FrontmatterValue> = {};
		for (const part of splitInline(text.slice(1, -1))) {
			const sep = findKeySeparator(part);
			if (sep === -1) continue;
			map[unquote(part.slice(0, sep).trim())] = parseScalar(part.slice(sep + 1));
		}
		return map;
	}
	if (
		(text.startsWith('"') && text.endsWith('"') && text.length > 1) ||
		(text.startsWith("'") && text.endsWith("'") && text.length > 1)
	) {
		return unquote(text);
	}
	if (text === "true" || text === "True" || text === "TRUE") return true;
	if (text === "false" || text === "False" || text === "FALSE") return false;
	if (/^[+-]?\d+$/.test(text)) {
		const n = Number.parseInt(text, 10);
		return Number.isSafeInteger(n) ? n : text;
	}
	if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(text)) return Number(text);
	return text;
}

function splitInline(text: string): string[] {
	const parts: string[] = [];
	let current = "";
	let depth = 0;
	let inSingle = false;
	let inDouble = false;
	for (const ch of text) {
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		if (!inSingle && !inDouble) {
			if (ch === "[" || ch === "{") depth++;
			else if (ch === "]" || ch === "}") depth--;
			else if (ch === "," && depth === 0) {
				parts.push(current.trim());
				current = "";
				continue;
			}
		}
		current += ch;
	}
	if (current.trim() !== "") parts.push(current.trim());
	return parts;
}

function unquote(text: string): string {
	const t = text.trim();
	if (t.length > 1 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
		const inner = t.slice(1, -1);
		if (t[0] === '"') {
			return inner.replace(/\\(["\\ntr])/g, (_m, c: string) =>
				c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c,
			);
		}
		return inner.replace(/''/g, "'");
	}
	return t;
}

/* -------------------------------------------------------------------------- */
/*  Serialization                                                              */
/* -------------------------------------------------------------------------- */

export function stringifyFrontmatter(data: Record<string, FrontmatterValue>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		lines.push(...serializeEntry(key, value, 0));
	}
	return lines.join("\n");
}

function serializeEntry(key: string, value: FrontmatterValue, indent: number): string[] {
	const pad = "  ".repeat(indent);
	if (Array.isArray(value)) {
		if (value.length === 0) return [`${pad}${key}: []`];
		const allScalar = value.every((v) => v === null || typeof v !== "object");
		if (allScalar) {
			return [`${pad}${key}:`, ...value.map((v) => `${pad}  - ${serializeScalar(v)}`)];
		}
		const out = [`${pad}${key}:`];
		for (const item of value) {
			if (item && typeof item === "object" && !Array.isArray(item)) {
				const entries = Object.entries(item);
				if (entries.length === 0) {
					out.push(`${pad}  - {}`);
					continue;
				}
				out.push(`${pad}  - ${entries[0][0]}: ${serializeScalar(entries[0][1])}`);
				for (const [k, v] of entries.slice(1)) {
					out.push(...serializeEntry(k, v, indent + 2));
				}
			} else {
				out.push(`${pad}  - ${serializeScalar(item)}`);
			}
		}
		return out;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value);
		if (entries.length === 0) return [`${pad}${key}: {}`];
		return [`${pad}${key}:`, ...entries.flatMap(([k, v]) => serializeEntry(k, v, indent + 1))];
	}
	return [`${pad}${key}: ${serializeScalar(value)}`];
}

function serializeScalar(value: FrontmatterValue): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	const text = String(value);
	if (text === "" || /^[\s>|&*!%@`{}[\],#?:-]|[:#]\s|\n/.test(text) || /^(true|false|null|~)$/i.test(text)) {
		return JSON.stringify(text);
	}
	if (/^[+-]?\d+(\.\d+)?$/.test(text)) return JSON.stringify(text);
	return text;
}

/* -------------------------------------------------------------------------- */
/*  Convenience accessors                                                      */
/* -------------------------------------------------------------------------- */

export function asString(value: FrontmatterValue | undefined): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

export function asNumber(value: FrontmatterValue | undefined): number | undefined {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const n = Number(value);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

export function asStringArray(value: FrontmatterValue | undefined): string[] {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) {
		return value
			.map((v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null))
			.filter((v): v is string => v !== null)
			.map((v) => v.trim())
			.filter((v) => v !== "");
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map((v) => v.trim())
			.filter((v) => v !== "");
	}
	return [];
}

export function asDate(value: FrontmatterValue | undefined): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number") return value > 1e12 ? value : value > 1e9 ? value * 1000 : undefined;
	if (typeof value === "string") {
		const ts = Date.parse(value);
		return Number.isNaN(ts) ? undefined : ts;
	}
	return undefined;
}

/** Normalizes a tag: removes a leading `#`, trims, lowercases for comparisons. */
export function normalizeTag(tag: string): string {
	return tag.replace(/^#+/, "").trim();
}

export function tagMatches(tag: string, pattern: string): boolean {
	const t = normalizeTag(tag).toLowerCase();
	const p = normalizeTag(pattern).toLowerCase();
	if (p === "") return false;
	if (p.endsWith("/*")) return t.startsWith(p.slice(0, -1));
	if (p.endsWith("*")) return t.startsWith(p.slice(0, -1));
	return t === p || t.startsWith(p + "/");
}
