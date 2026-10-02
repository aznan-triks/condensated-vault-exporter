/**
 * Fence-aware Markdown scanning primitives.
 *
 * Everything downstream (analysis, transforms, hashing) needs to know which
 * lines are *code* and which are *prose*, and it must handle the messy reality
 * of Obsidian notes: 3+ backticks or tildes, nested/indented fences, fences
 * with info strings, and unclosed fences at EOF.
 */

export type LineKind = "fence" | "code" | "text" | "blank" | "html";

export interface ScannedLine {
	/** 0-based line index. */
	index: number;
	/** Line content without its EOL marker. */
	text: string;
	kind: LineKind;
	/** Index of the opening fence when inside a fenced block. */
	fenceStart?: number;
	/** Info string of the surrounding fence (`js`, `dataview`, …). */
	fenceInfo?: string;
}

export interface FenceRange {
	start: number;
	end: number;
	info: string;
	char: string;
}

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;

export function splitLines(text: string): string[] {
	if (text === "") return [];
	return text.split("\n");
}

/**
 * Splits the document into lines, tagging fenced code blocks. A fence closes
 * only on a line made of the same character, at least as long, with nothing
 * else but whitespace after it.
 */
export function scanLines(text: string): ScannedLine[] {
	const raw = splitLines(text);
	const out: ScannedLine[] = new Array(raw.length);
	let open: { index: number; char: string; len: number; info: string } | null = null;

	for (let i = 0; i < raw.length; i++) {
		const line = raw[i].endsWith("\r") ? raw[i].slice(0, -1) : raw[i];

		if (open) {
			const close = FENCE_RE.exec(line);
			if (close && close[2][0] === open.char && close[2].length >= open.len && close[3].trim() === "") {
				out[i] = { index: i, text: line, kind: "fence", fenceStart: open.index, fenceInfo: open.info };
				open = null;
				continue;
			}
			out[i] = { index: i, text: line, kind: "code", fenceStart: open.index, fenceInfo: open.info };
			continue;
		}

		const fence = FENCE_RE.exec(line);
		if (fence) {
			open = { index: i, char: fence[2][0], len: fence[2].length, info: fence[3].trim() };
			out[i] = { index: i, text: line, kind: "fence", fenceStart: i, fenceInfo: open.info };
			continue;
		}

		if (line.trim() === "") {
			out[i] = { index: i, text: line, kind: "blank" };
			continue;
		}
		out[i] = { index: i, text: line, kind: "text" };
	}
	return out;
}

export function fenceRanges(text: string): FenceRange[] {
	const lines = splitLines(text);
	const ranges: FenceRange[] = [];
	let open: { index: number; char: string; len: number; info: string } | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
		const fence = FENCE_RE.exec(line);
		if (!open && fence) {
			open = { index: i, char: fence[2][0], len: fence[2].length, info: fence[3].trim() };
			continue;
		}
		if (open) {
			const close = FENCE_RE.exec(line);
			if (close && close[2][0] === open.char && close[2].length >= open.len && close[3].trim() === "") {
				ranges.push({ start: open.index, end: i, info: open.info, char: open.char });
				open = null;
			}
		}
	}
	if (open) ranges.push({ start: open.index, end: lines.length - 1, info: open.info, char: open.char });
	return ranges;
}

/** Removes inline code spans so their content is not parsed as markup. */
export function maskInlineCode(line: string): string {
	// Only backtick runs of equal length delimit a span.
	return line.replace(/(`+)([^`]*?)\1/g, (m) => " ".repeat(m.length));
}

export interface HeadingMatch {
	level: number;
	text: string;
}

export function matchHeading(line: string): HeadingMatch | null {
	const m = /^(\s{0,3})(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
	if (!m) return null;
	return { level: m[2].length, text: m[3].trim() };
}

/** A blockquote line: `> text`, possibly nested. */
export function matchBlockquote(line: string): { depth: number; text: string } | null {
	const m = /^(\s*)((?:>\s*)+)(.*)$/.exec(line);
	if (!m) return null;
	const markers = m[2].match(/>/g);
	return { depth: markers ? markers.length : 1, text: m[3] };
}

export function isListItem(line: string): boolean {
	return /^\s*(?:[-*+]|\d+[.)])\s+/.test(line);
}

export function isTaskItem(line: string): boolean {
	return /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX/\-]\]\s?/.test(line);
}

/** Extracts the indentation width of a line, expanding tabs. */
export function indentWidth(line: string): number {
	const m = /^[ \t]*/.exec(line);
	if (!m) return 0;
	let width = 0;
	for (const ch of m[0]) width += ch === "\t" ? 4 : 1;
	return width;
}

export function stripTrailingWhitespace(text: string): string {
	return text.replace(/[ \t]+$/gm, "");
}

/**
 * Keeps at most `max` blank lines in a row (a paragraph break is one blank
 * line, i.e. `\n\n`). Zero removes every blank line.
 *
 * Getting this wrong is not cosmetic: Markdown ends a paragraph, a list or a
 * table at a blank line, so collapsing them all welds consecutive paragraphs
 * and list items into one block.
 */
export function collapseBlankLines(text: string, max = 1): string {
	if (max <= 0) return text.replace(/\n{2,}/g, "\n");
	const re = new RegExp(`\\n{${max + 2},}`, "g");
	return text.replace(re, "\n".repeat(max + 1));
}

export function countWords(text: string): number {
	const matches = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-_.]*/gu);
	return matches ? matches.length : 0;
}

/** Splits prose into sentences, tolerating abbreviations and list items. */
export function splitSentences(text: string): string[] {
	const out: string[] = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line === "") continue;
		// Short lines (headings, list items) are treated as their own sentence.
		if (line.length < 90 && (/^#{1,6}\s/.test(line) || isListItem(line))) {
			out.push(line);
			continue;
		}
		const parts = line.split(/(?<=[.!?…])["'”»)\]]*\s+(?=[A-ZÀ-Þ“"'(]|\d)/u);
		for (const part of parts) {
			const trimmed = part.trim();
			if (trimmed !== "") out.push(trimmed);
		}
	}
	return out;
}

/** Removes Markdown markup from a line, keeping readable text. */
export function stripInlineMarkup(line: string): string {
	return line
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/!\[\[([^\]]*)\]\]/g, "$1")
		.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
		.replace(/\[\[([^\]]*)\]\]/g, "$1")
		.replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
		.replace(/(\*\*|__)(.*?)\1/g, "$2")
		.replace(/(?<![*\w])(\*|_)(?![*\s])(.*?)(?<![*\s])\1(?![*\w])/g, "$2")
		.replace(/~~(.*?)~~/g, "$1")
		.replace(/==(.*?)==/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/, "")
		.replace(/^\s*>\s?/, "")
		.replace(/\{\{[^}]*\}\}/g, "")
		.replace(/<[^>]+>/g, "");
}
