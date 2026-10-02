/**
 * Gitignore-flavoured glob matching, dependency free.
 *
 * Supported syntax:
 *   `*`       any run of characters except `/`
 *   `**`      any run of characters including `/`
 *   `?`       exactly one character except `/`
 *   `[abc]`   character class, `[!abc]` negated
 *   `{a,b}`   alternation (nestable)
 *   `!pat`    negation (handled by {@link matchAny})
 *   `pat/`    matches the folder and everything inside it
 *
 * A pattern without `/` is matched against every path segment, so `README.md`
 * matches `notes/README.md` (like gitignore).
 */

import { escapeRegExp, normalizeVaultPath } from "./util";

const cache = new Map<string, RegExp>();

function compile(pattern: string): RegExp {
	const cached = cache.get(pattern);
	if (cached) return cached;

	let src = "";
	let i = 0;
	const n = pattern.length;
	const endsWithSlash = pattern.endsWith("/");
	const raw = endsWithSlash ? pattern.slice(0, -1) : pattern;

	// A leading `/` anchors the pattern at the root.
	const anchored = raw.startsWith("/");
	const body = anchored ? raw.slice(1) : raw;
	const hasSlash = body.includes("/");

	// No slash → match against any segment (anywhere in the path).
	src += anchored ? "^" : "(?:^|.*/)";

	i = 0;
	while (i < body.length) {
		const ch = body[i];
		if (ch === "*") {
			if (body[i + 1] === "*") {
				// `**/` collapses to "any folders"; a bare `**` matches anything.
				let j = i + 2;
				while (body[j] === "*") j++;
				if (body[j] === "/") {
					src += "(?:[^/]*/)*";
					i = j + 1;
				} else {
					src += ".*";
					i = j;
				}
				continue;
			}
			src += "[^/]*";
			i++;
			continue;
		}
		if (ch === "?") {
			src += "[^/]";
			i++;
			continue;
		}
		if (ch === "[") {
			const end = findClassEnd(body, i);
			if (end > i) {
				let cls = body.slice(i + 1, end);
				if (cls.startsWith("!")) cls = "^" + cls.slice(1);
				src += "[" + cls + "]";
				i = end + 1;
				continue;
			}
			src += "\\[";
			i++;
			continue;
		}
		if (ch === "{") {
			const end = matchBrace(body, i);
			if (end > i) {
				const parts = splitTopLevel(body.slice(i + 1, end));
				src += "(?:" + parts.map((part) => compileFragment(part)).join("|") + ")";
				i = end + 1;
				continue;
			}
			src += "\\{";
			i++;
			continue;
		}
		src += escapeRegExp(ch);
		i++;
	}

	src += endsWithSlash ? "(?:/.*)?$" : "$";
	const re = new RegExp(src, hasSlash || anchored ? "" : "");
	cache.set(pattern, re);
	return re;
}

function compileFragment(fragment: string): string {
	let out = "";
	for (let i = 0; i < fragment.length; i++) {
		const ch = fragment[i];
		if (ch === "*") {
			if (fragment[i + 1] === "*") {
				out += ".*";
				i++;
			} else out += "[^/]*";
		} else if (ch === "?") out += "[^/]";
		else out += escapeRegExp(ch);
	}
	return out;
}

function findClassEnd(text: string, start: number): number {
	for (let i = start + 1; i < text.length; i++) {
		if (text[i] === "]" && i > start + 1) return i;
	}
	return -1;
}

function matchBrace(text: string, start: number): number {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === "{") depth++;
		else if (text[i] === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function splitTopLevel(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of text) {
		if (ch === "{") depth++;
		if (ch === "}") depth--;
		if (ch === "," && depth === 0) {
			parts.push(current);
			current = "";
		} else current += ch;
	}
	parts.push(current);
	return parts;
}

/** Matches a single (non-negated) glob pattern against a vault path. */
export function matchGlob(pattern: string, path: string): boolean {
	const trimmed = pattern.trim();
	if (trimmed === "") return false;
	const normalized = normalizeVaultPath(path);
	if (trimmed === "*" || trimmed === "**" || trimmed === "**/*") return true;
	return compile(trimmed).test(normalized);
}

/**
 * Applies an ordered list of patterns. Later patterns win, and a leading `!`
 * negates: `["**​/*.md", "!drafts/**"]`.
 */
export function matchAny(patterns: string[], path: string): boolean {
	let matched = false;
	for (const pattern of patterns) {
		const trimmed = pattern.trim();
		if (trimmed === "") continue;
		if (trimmed.startsWith("!")) {
			if (matchGlob(trimmed.slice(1), path)) matched = false;
		} else if (matchGlob(trimmed, path)) {
			matched = true;
		}
	}
	return matched;
}

/** Returns true when the pattern list contains at least one positive pattern. */
export function hasPositivePattern(patterns: string[]): boolean {
	return patterns.some((p) => p.trim() !== "" && !p.trim().startsWith("!"));
}

export function isValidGlob(pattern: string): boolean {
	try {
		compile(pattern.trim().replace(/^!/, ""));
		return true;
	} catch {
		return false;
	}
}
