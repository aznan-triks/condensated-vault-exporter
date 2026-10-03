/**
 * Offline Dataview DQL Evaluator & Markdown Materializer.
 *
 * Obsidian vaults frequently use ` ```dataview ` blocks for MOCs, project
 * dashboards, and index notes (`LIST FROM #project`, `TABLE status, priority
 * FROM "Projects" WHERE status != "archived" SORT file.mtime DESC`).
 *
 * When a vault is exported for an LLM, stripping Dataview blocks leaves empty
 * headings ("## Active Projects" followed by nothing), while keeping raw DQL
 * code gives the model a query without its answers. Because Pass 1 already
 * parsed every note's frontmatter, tags, links, folder, and file stats into
 * `DocAnalysis[]`, we can evaluate standard `LIST` and `TABLE` Dataview
 * queries offline and materialize them into clean Markdown lists and tables!
 */

import type { DocAnalysis, FrontmatterValue } from "../types";
import { tagMatches } from "../frontmatter";
import { basename, naturalCompare, stripExtension } from "../util";

export interface DataviewColumn {
	expr: string;
	label: string;
}

export interface ParsedDataviewQuery {
	kind: "list" | "table";
	withoutId: boolean;
	listExpr?: string;
	columns: DataviewColumn[];
	fromSources: { negated: boolean; raw: string }[];
	fromCombine: "and" | "or";
	whereClauses: string[];
	sortField?: string;
	sortDir: "asc" | "desc";
	limit: number;
}

const DATAVIEW_BLOCK_RE = /^(`{3,}|~{3,})dataview\b[^\n]*\n([\s\S]*?)^\1\s*$/gm;

/**
 * Parses a subset of Dataview Query Language (DQL) covering common `LIST` and
 * `TABLE` queries with `FROM`, `WHERE`, `SORT`, and `LIMIT`. Returns `null` if
 * the query uses unsupported syntax.
 */
export function parseDataviewQuery(rawQuery: string): ParsedDataviewQuery | null {
	const cleaned = rawQuery
		.split(/\r?\n/)
		.map((line) => line.replace(/\/\/.*$/, "").trim())
		.filter((line) => line !== "")
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned === "") return null;

	const headerMatch = /^(LIST|TABLE)(?:\s+WITHOUT\s+ID)?\b(.*)$/i.exec(cleaned);
	if (!headerMatch) return null;

	const kind = headerMatch[1].toLowerCase() as "list" | "table";
	const withoutId = /^ (?:LIST|TABLE)\s+WITHOUT\s+ID\b/i.test(` ${cleaned}`);
	const rest = headerMatch[2].trim();

	// Split clauses by top-level keywords: FROM, WHERE, SORT, LIMIT, FLATTEN, GROUP BY
	if (/\b(?:FLATTEN|GROUP\s+BY)\b/i.test(rest)) return null;

	const clauseRegex = /\b(FROM|WHERE|SORT|LIMIT)\b/gi;
	const positions: { keyword: string; index: number; after: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = clauseRegex.exec(rest)) !== null) {
		positions.push({
			keyword: m[1].toUpperCase(),
			index: m.index,
			after: m.index + m[0].length,
		});
	}

	const selectPart = (positions.length > 0 ? rest.slice(0, positions[0].index) : rest).trim();
	const clauses = new Map<string, string[]>();
	for (let i = 0; i < positions.length; i++) {
		const cur = positions[i];
		const end = i + 1 < positions.length ? positions[i + 1].index : rest.length;
		const body = rest.slice(cur.after, end).trim();
		const list = clauses.get(cur.keyword) ?? [];
		list.push(body);
		clauses.set(cur.keyword, list);
	}

	const columns: DataviewColumn[] = [];
	let listExpr: string | undefined;

	if (kind === "list") {
		if (selectPart !== "") listExpr = selectPart;
	} else if (selectPart !== "") {
		for (const rawCol of splitCommaTopLevel(selectPart)) {
			const trimmedCol = rawCol.trim();
			if (trimmedCol === "") continue;
			const asMatch = /^(.+?)\s+AS\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/i.exec(trimmedCol);
			if (asMatch) {
				columns.push({
					expr: asMatch[1].trim(),
					label: (asMatch[2] ?? asMatch[3] ?? asMatch[4] ?? asMatch[1]).trim(),
				});
			} else {
				columns.push({ expr: trimmedCol, label: trimmedCol });
			}
		}
	}

	// Parse FROM
	const fromRaw = (clauses.get("FROM") ?? [])[0] ?? "";
	const fromSources: { negated: boolean; raw: string }[] = [];
	let fromCombine: "and" | "or" = "or";
	if (fromRaw !== "") {
		if (/\bAND\b/i.test(fromRaw)) fromCombine = "and";
		const parts = fromRaw.split(/\b(?:AND|OR)\b|,/i).map((s) => s.trim()).filter(Boolean);
		for (const p of parts) {
			const neg = p.startsWith("-") || p.startsWith("!");
			const token = (neg ? p.slice(1) : p).trim();
			if (token !== "") fromSources.push({ negated: neg, raw: token });
		}
	}

	// Parse WHERE
	const whereClauses: string[] = [];
	for (const w of clauses.get("WHERE") ?? []) {
		for (const sub of w.split(/\bAND\b/i)) {
			const t = sub.trim();
			if (t !== "") whereClauses.push(t);
		}
	}

	// Parse SORT
	let sortField: string | undefined;
	let sortDir: "asc" | "desc" = "asc";
	const sortRaw = (clauses.get("SORT") ?? [])[0];
	if (sortRaw) {
		const firstSort = sortRaw.split(",")[0].trim();
		const sm = /^(\S+?)(?:\s+(ASC|DESC|ASCENDING|DESCENDING))?$/i.exec(firstSort);
		if (sm) {
			sortField = sm[1].trim();
			if (sm[2] && sm[2].toUpperCase().startsWith("DESC")) sortDir = "desc";
		}
	}

	// Parse LIMIT
	let limit = 50;
	const limitRaw = (clauses.get("LIMIT") ?? [])[0];
	if (limitRaw) {
		const parsedLimit = Number.parseInt(limitRaw, 10);
		if (Number.isFinite(parsedLimit) && parsedLimit > 0) limit = Math.min(200, parsedLimit);
	}

	return {
		kind,
		withoutId,
		listExpr,
		columns,
		fromSources,
		fromCombine,
		whereClauses,
		sortField,
		sortDir,
		limit,
	};
}

function splitCommaTopLevel(input: string): string[] {
	const result: string[] = [];
	let current = "";
	let depth = 0;
	let inQuote: string | null = null;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (inQuote) {
			current += ch;
			if (ch === inQuote) inQuote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			inQuote = ch;
			current += ch;
			continue;
		}
		if (ch === "(" || ch === "[") depth++;
		else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
		if (ch === "," && depth === 0) {
			result.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim() !== "") result.push(current);
	return result;
}

function matchesFromToken(doc: DocAnalysis, raw: string): boolean {
	if (raw.startsWith("#")) {
		const wanted = raw.slice(1).toLowerCase();
		return doc.tags.some((t) => tagMatches(t, wanted));
	}
	const folderMatch = /^["']([^"']*)["']$/.exec(raw);
	if (folderMatch) {
		const folder = folderMatch[1].replace(/^\/+|\/+$/g, "").toLowerCase();
		if (folder === "") return true;
		const docPath = doc.file.path.toLowerCase();
		return docPath === folder || docPath.startsWith(`${folder}/`);
	}
	const outgoingMatch = /^outgoing\(\[\[([^\]]+)\]\]\)$/i.exec(raw);
	if (outgoingMatch) {
		const sourceTarget = outgoingMatch[1].toLowerCase();
		return doc.file.path.toLowerCase().includes(sourceTarget);
	}
	const linkMatch = /^\[\[([^\]]+)\]\]$/.exec(raw);
	if (linkMatch) {
		const target = linkMatch[1].replace(/\.md$/i, "").toLowerCase();
		return doc.outgoing.some((o) => {
			const clean = o.replace(/\.md$/i, "").toLowerCase();
			return clean === target || clean.endsWith(`/${target}`);
		});
	}
	return false;
}

function resolveField(doc: DocAnalysis, expr: string): FrontmatterValue | undefined {
	const key = expr.trim();
	const lower = key.toLowerCase();
	switch (lower) {
		case "file.name":
			return stripExtension(basename(doc.file.path));
		case "file.path":
			return doc.file.path;
		case "file.folder":
			return doc.file.folder || "(root)";
		case "file.ext":
			return doc.file.ext;
		case "file.size":
			return doc.file.size;
		case "file.mtime":
		case "file.mday":
			return doc.file.mtime ? new Date(doc.file.mtime).toISOString().slice(0, 10) : "";
		case "file.ctime":
		case "file.cday":
			return doc.file.ctime ? new Date(doc.file.ctime).toISOString().slice(0, 10) : "";
		case "file.tags":
		case "tags":
			return doc.tags;
		case "file.outlinks":
			return doc.outgoing;
		case "title":
			return doc.title;
		case "words":
			return doc.stats.words;
		default: {
			if (key in doc.frontmatter.data) return doc.frontmatter.data[key];
			const foundKey = Object.keys(doc.frontmatter.data).find((k) => k.toLowerCase() === lower);
			return foundKey ? doc.frontmatter.data[foundKey] : undefined;
		}
	}
}

function parseLiteral(raw: string): string | number | boolean | null {
	const t = raw.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
		return t.slice(1, -1);
	}
	if (/^true$/i.test(t)) return true;
	if (/^false$/i.test(t)) return false;
	if (/^null$/i.test(t)) return null;
	if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
	return t;
}

function evaluateWhereClause(doc: DocAnalysis, clause: string): boolean {
	const trimmed = clause.trim();
	const containsMatch = /^(!)?contains\(\s*([^,]+?)\s*,\s*(.+?)\s*\)$/i.exec(trimmed);
	if (containsMatch) {
		const negate = containsMatch[1] === "!";
		const fieldVal = resolveField(doc, containsMatch[2]);
		const needle = String(parseLiteral(containsMatch[3])).replace(/^#/, "").toLowerCase();
		let hit = false;
		if (Array.isArray(fieldVal)) {
			hit = fieldVal.some((v) => String(v).replace(/^#/, "").toLowerCase().includes(needle));
		} else if (fieldVal !== undefined && fieldVal !== null) {
			hit = String(fieldVal).toLowerCase().includes(needle);
		}
		return negate ? !hit : hit;
	}

	const cmpMatch = /^([\w.-]+)\s*(!=|>=|<=|=|>|<)\s*(.+)$/.exec(trimmed);
	if (cmpMatch) {
		const lhs = resolveField(doc, cmpMatch[1]);
		const op = cmpMatch[2];
		const rhs = parseLiteral(cmpMatch[3]);
		if (lhs === undefined || lhs === null) {
			return op === "!=" && rhs !== null;
		}
		if (typeof lhs === "number" && typeof rhs === "number") {
			switch (op) {
				case "=":
					return lhs === rhs;
				case "!=":
					return lhs !== rhs;
				case ">":
					return lhs > rhs;
				case ">=":
					return lhs >= rhs;
				case "<":
					return lhs < rhs;
				case "<=":
					return lhs <= rhs;
			}
		}
		const lStr = String(lhs).toLowerCase();
		const rStr = String(rhs ?? "").toLowerCase();
		switch (op) {
			case "=":
				return lStr === rStr;
			case "!=":
				return lStr !== rStr;
			case ">":
				return naturalCompare(lStr, rStr) > 0;
			case ">=":
				return naturalCompare(lStr, rStr) >= 0;
			case "<":
				return naturalCompare(lStr, rStr) < 0;
			case "<=":
				return naturalCompare(lStr, rStr) <= 0;
		}
	}

	if (trimmed.startsWith("!")) {
		const val = resolveField(doc, trimmed.slice(1));
		return val === undefined || val === null || val === false || val === "";
	}
	const val = resolveField(doc, trimmed);
	return val !== undefined && val !== null && val !== false && val !== "";
}

function formatCellValue(value: FrontmatterValue | undefined): string {
	if (value === undefined || value === null) return "—";
	if (Array.isArray(value)) return value.map((item) => formatCellValue(item)).join(", ");
	if (typeof value === "object") return JSON.stringify(value);
	return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Evaluates a single DQL query string against `docs` and returns rendered
 * Markdown (`LIST` or `TABLE`), or `null` if the query is unsupported or
 * matches zero documents.
 */
export function evaluateDataviewQuery(rawQuery: string, docs: DocAnalysis[]): string | null {
	if (docs.length === 0) return null;
	const parsed = parseDataviewQuery(rawQuery);
	if (!parsed) return null;

	let matched = docs.filter((doc) => {
		if (parsed.fromSources.length > 0) {
			const positives = parsed.fromSources.filter((s) => !s.negated);
			const negatives = parsed.fromSources.filter((s) => s.negated);
			for (const neg of negatives) {
				if (matchesFromToken(doc, neg.raw)) return false;
			}
			if (positives.length > 0) {
				const ok =
					parsed.fromCombine === "and"
						? positives.every((p) => matchesFromToken(doc, p.raw))
						: positives.some((p) => matchesFromToken(doc, p.raw));
				if (!ok) return false;
			}
		}
		for (const clause of parsed.whereClauses) {
			if (!evaluateWhereClause(doc, clause)) return false;
		}
		return true;
	});

	if (matched.length === 0) return null;

	const sortField = parsed.sortField;
	const dir = parsed.sortDir === "desc" ? -1 : 1;
	matched = [...matched].sort((a, b) => {
		if (sortField) {
			const lower = sortField.toLowerCase();
			if (lower === "file.mtime" || lower === "file.mday") {
				const diff = (a.file.mtime || 0) - (b.file.mtime || 0);
				if (diff !== 0) return diff * dir;
			} else if (lower === "file.ctime" || lower === "file.cday") {
				const diff = (a.file.ctime || 0) - (b.file.ctime || 0);
				if (diff !== 0) return diff * dir;
			} else {
				const av = resolveField(a, sortField);
				const bv = resolveField(b, sortField);
				if (typeof av === "number" && typeof bv === "number" && av !== bv) {
					return (av - bv) * dir;
				}
				const cmp = naturalCompare(String(av ?? ""), String(bv ?? ""));
				if (cmp !== 0) return cmp * dir;
			}
		}
		return naturalCompare(a.file.path, b.file.path) * dir;
	});

	matched = matched.slice(0, parsed.limit);

	if (parsed.kind === "list") {
		const lines: string[] = [];
		for (const doc of matched) {
			const extra = parsed.listExpr ? formatCellValue(resolveField(doc, parsed.listExpr)) : "";
			const suffix = extra && extra !== "—" ? `: ${extra}` : "";
			lines.push(`- [[${doc.file.path}|${doc.title}]]${suffix}`);
		}
		return lines.join("\n");
	}

	// TABLE
	const headers: string[] = [];
	if (!parsed.withoutId) headers.push("Note");
	for (const col of parsed.columns) headers.push(col.label);
	if (headers.length === 0) headers.push("Note");

	const rows: string[] = [];
	rows.push(`| ${headers.join(" | ")} |`);
	rows.push(`| ${headers.map(() => "---").join(" | ")} |`);
	for (const doc of matched) {
		const cells: string[] = [];
		if (!parsed.withoutId || parsed.columns.length === 0) {
			cells.push(`[[${doc.file.path}|${doc.title}]]`);
		}
		for (const col of parsed.columns) {
			cells.push(formatCellValue(resolveField(doc, col.expr)));
		}
		rows.push(`| ${cells.join(" | ")} |`);
	}
	return rows.join("\n");
}

/**
 * Replaces ` ```dataview ... ``` ` blocks in `text` with materialized Markdown
 * lists/tables when they match documents in `docs`.
 */
export function materializeDataviewBlocks(
	text: string,
	docs: DocAnalysis[],
): { text: string; materialized: number } {
	if (!text.includes("dataview") || docs.length === 0) return { text, materialized: 0 };
	let materialized = 0;
	const updated = text.replace(DATAVIEW_BLOCK_RE, (fullMatch, _fence: string, query: string) => {
		const rendered = evaluateDataviewQuery(query, docs);
		if (!rendered) return fullMatch;
		materialized++;
		return rendered;
	});
	return { text: updated, materialized };
}
