/**
 * Link, embed and tag extraction.
 *
 * Handles Obsidian wikilinks (`[[Note]]`, `[[Note|alias]]`, `[[Note#H]]`,
 * `[[Note#^block]]`, `![[Note]]`), Markdown links/images, bare URLs and inline
 * tags — while ignoring anything inside code spans or fences.
 */

import type { LinkRef } from "../types";
import { matchBlockquote, maskInlineCode } from "./syntax";

const WIKILINK_RE = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const MDLINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g;
const AUTOLINK_RE = /<((?:https?|mailto):[^>\s]+)>/g;
const BARE_URL_RE = /(?<![([<\w])((?:https?:\/\/|www\.)[^\s<>()"'\]]+)/g;
/**
 * Inline tag (`#tag`, `#nested/tag`). Shared with the transform pass so that
 * stripping and extracting always agree on what a tag is.
 */
export const INLINE_TAG_RE = /(^|[\s(>|,;:[{])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;

export interface ExtractedLinks {
	links: LinkRef[];
	tags: string[];
}

export function extractLinksFromLine(line: string): ExtractedLinks {
	const links: LinkRef[] = [];
	const tags: string[] = [];

	// A blockquote marker is not markup we need to preserve for link parsing,
	// but keeping it does not hurt. Code spans are masked.
	const bq = matchBlockquote(line);
	const scan = bq ? bq.text : line;
	const masked = maskInlineCode(scan);

	WIKILINK_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = WIKILINK_RE.exec(masked)) !== null) {
		const isEmbed = m[1] === "!";
		const inner = m[2];
		let alias: string | undefined;
		const pipe = inner.indexOf("|");
		let targetPart = inner;
		if (pipe !== -1) {
			alias = inner.slice(pipe + 1).trim();
			targetPart = inner.slice(0, pipe);
		}
		let heading: string | undefined;
		let block: string | undefined;
		const hash = targetPart.indexOf("#");
		if (hash !== -1) {
			const anchor = targetPart.slice(hash + 1).trim();
			targetPart = targetPart.slice(0, hash);
			if (anchor.startsWith("^")) block = anchor.slice(1);
			else if (anchor !== "") heading = anchor;
		}
		const target = targetPart.trim();
		links.push({
			target,
			heading,
			block,
			alias,
			isEmbed,
			isExternal: /^(?:https?|mailto):/i.test(target),
			url: /^(?:https?|mailto):/i.test(target) ? target : undefined,
		});
	}

	MDLINK_RE.lastIndex = 0;
	while ((m = MDLINK_RE.exec(masked)) !== null) {
		const url = m[3].replace(/\s+"[^"]*"$/, "").trim();
		links.push({
			target: url,
			alias: m[2] || undefined,
			isEmbed: m[1] === "!",
			isExternal: /^(?:https?|mailto):/i.test(url),
			url,
		});
	}

	AUTOLINK_RE.lastIndex = 0;
	while ((m = AUTOLINK_RE.exec(masked)) !== null) {
		links.push({ target: m[1], isEmbed: false, isExternal: true, url: m[1] });
	}

	BARE_URL_RE.lastIndex = 0;
	while ((m = BARE_URL_RE.exec(masked)) !== null) {
		links.push({ target: m[1], isEmbed: false, isExternal: true, url: m[1] });
	}

	INLINE_TAG_RE.lastIndex = 0;
	while ((m = INLINE_TAG_RE.exec(masked)) !== null) {
		const tag = m[2].replace(/\/+$/, "");
		if (tag === "" || /^\d+$/.test(tag)) continue;
		tags.push(tag);
	}

	return { links, tags };
}

/** Strips a tag from a line (used by the `strip`/`hoist` tag modes). */
export function removeInlineTags(line: string): string {
	return line.replace(INLINE_TAG_RE, (_m, prefix: string) => prefix);
}

/** True when the line consists only of links/embeds and whitespace. */
export function isLinksOnly(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed === "") return false;
	if (trimmed.startsWith("#")) return false;
	const withoutList = trimmed.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "");
	if (withoutList === "") return false;
	let consumed = 0;
	WIKILINK_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = WIKILINK_RE.exec(withoutList)) !== null) consumed += m[0].length;
	MDLINK_RE.lastIndex = 0;
	while ((m = MDLINK_RE.exec(withoutList)) !== null) consumed += m[0].length;
	const leftovers = withoutList
		.replace(WIKILINK_RE, "")
		.replace(MDLINK_RE, "")
		.replace(/[\s\-–—•*+.,;:()[\]{}|]/g, "");
	void consumed;
	return leftovers.length === 0;
}

/** Resolves a wikilink target against the set of known vault paths. */
export function resolveLinkTarget(
	target: string,
	fromPath: string,
	index: Map<string, string>,
): string | undefined {
	if (target === "") return undefined;
	const lookup = (candidate: string): string | undefined => index.get(candidate.toLowerCase());

	const direct = lookup(target);
	if (direct) return direct;

	// Obsidian also resolves by file name only, preferring the same folder.
	const lastSlash = target.lastIndexOf("/");
	const nameOnly = lastSlash === -1 ? target : target.slice(lastSlash + 1);
	const folder = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
	const candidates: string[] = [];

	const sameFolder = folder === "" ? nameOnly : `${folder}/${nameOnly}`;
	for (const candidate of [sameFolder, nameOnly]) {
		for (const variation of [candidate, `${candidate}.md`]) {
			const resolved = lookup(variation);
			if (resolved) candidates.push(resolved);
		}
	}
	if (candidates.length > 0) {
		// Prefer the shortest path (closest to the vault root) for determinism.
		return candidates.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
	}

	// Last resort: any file whose name matches, whatever the folder.
	const suffix = `/${nameOnly.toLowerCase()}.md`;
	for (const [key, path] of index) {
		if (key.endsWith(suffix)) return path;
	}
	return undefined;
}
