/**
 * The transform pipeline: raw note text in, clean AI-ready prose out.
 *
 * Order matters and is deliberate:
 *   1. frontmatter is separated (the renderer decides what to do with it);
 *   2. boilerplate is stripped first, so line hashes match pass 1;
 *   3. multi-line noise (comments, dataview, templater) is removed;
 *   4. per-line rewriting (code, headings, links, tags, tasks, callouts);
 *   5. embeds/attachments are resolved (async, depth-limited transclusion);
 *   6. cosmetic cleanup (blank lines, trailing spaces, trimming).
 */

import type { ExportFormat, TransformOptions } from "../types";
import { basename, stripExtension } from "../util";
import { stripBoilerplate, type BoilerplateOptions } from "../condense/boilerplate";
import { extractLinksFromLine } from "./links";
import {
	collapseBlankLines,
	countWords,
	isTaskItem,
	matchBlockquote,
	matchHeading,
	scanLines,
	stripInlineMarkup,
	stripTrailingWhitespace,
} from "./syntax";

export interface ContentResolver {
	/** Reads a note's raw text; returns null when missing/unreadable. */
	readNote(path: string): Promise<string | null>;
	/** Resolves a link target (as written) to a vault path. */
	resolve(target: string, fromPath: string): string | undefined;
	/** Reads a binary file as base64; returns null when missing. */
	readBinary?(path: string): Promise<string | null>;
	/** True when the path is an image we could inline. */
	isImage(path: string): boolean;
	/** Size in bytes, when known. */
	sizeOf(path: string): number | undefined;
}

export interface TransclusionOptions {
	depth: number;
	maxChars: number;
}

export interface TransformContext {
	format: ExportFormat;
	/** Path of the note being transformed (provenance for transclusion). */
	path: string;
	/** Displayed title of the note; a matching H1 is dropped. */
	title?: string;
	resolver?: ContentResolver;
	transclusion?: TransclusionOptions;
	boilerplate?: { hashes: Set<number>; exactHashes?: Set<number>; options: BoilerplateOptions };
}

export interface TransformStats {
	transclusions: number;
	transclusionChars: number;
	imagesInlined: number;
	imagesReferenced: number;
	imagesDropped: number;
	boilerplateLines: number;
	codeLinesElided: number;
	tasksRemoved: number;
}

export interface TransformOutput {
	text: string;
	/** Tags found inline (in order of appearance) — used by the `hoist` mode. */
	inlineTags: string[];
	/** Raw frontmatter block, when the mode keeps it. */
	frontmatterRaw: string | null;
	stats: TransformStats;
	warnings: string[];
}

const MAX_TRANSFORM_LINES = 200_000;
const CODE_COLLAPSE_THRESHOLD = 40;
const CODE_KEEP_HEAD = 8;
const CODE_KEEP_TAIL = 4;

export async function transformDocument(
	rawText: string,
	options: TransformOptions,
	context: TransformContext,
): Promise<TransformOutput> {
	const stats: TransformStats = {
		transclusions: 0,
		transclusionChars: 0,
		imagesInlined: 0,
		imagesReferenced: 0,
		imagesDropped: 0,
		boilerplateLines: 0,
		codeLinesElided: 0,
		tasksRemoved: 0,
	};
	const warnings: string[] = [];
	const inlineTags: string[] = [];

	// -- 1. frontmatter -------------------------------------------------------
	const { body, frontmatterRaw } = splitFrontmatterBlock(rawText);

	// -- 2. boilerplate -------------------------------------------------------
	let text = body;
	if (context.boilerplate && (context.boilerplate.hashes.size > 0 || (context.boilerplate.exactHashes?.size ?? 0) > 0)) {
		const stripped = stripBoilerplate(text, context.boilerplate.hashes, context.boilerplate.options, context.boilerplate.exactHashes);
		text = stripped.text;
		stats.boilerplateLines = stripped.removedLines;
	}

	// -- 3. multi-line noise --------------------------------------------------
	if (options.stripTemplaterExpressions) text = text.replace(/<%.*?%>/gs, "");
	if (options.stripObsidianComments) text = text.replace(/%%[\s\S]*?%%/g, "");
	if (options.stripHtmlComments) text = text.replace(/<!--[\s\S]*?-->/g, "");
	if (options.stripDataviewBlocks) text = stripDataviewBlocks(text);

	// -- 4. per-line rewriting ------------------------------------------------
	const lines = scanLines(text);
	const titleText = normalizeForCompare(context.title ?? stripExtension(context.path));
	const noteMinLevel = options.normalizeHeadingLevels ? shallowestHeading(lines) : 7;
	const levelShift = noteMinLevel < 7 ? options.noteHeadingLevel + 1 - noteMinLevel : 0;
	let droppedTitleHeading = false;

	const out: string[] = [];
	let codeRun: string[] = [];
	let codeFenceInfo: string | null = null;

	const flushCodeRun = () => {
		if (codeRun.length === 0) return;
		if (options.codeBlocks === "collapse" && codeRun.length > CODE_COLLAPSE_THRESHOLD) {
			const elided = codeRun.length - CODE_KEEP_HEAD - CODE_KEEP_TAIL;
			out.push(...codeRun.slice(0, CODE_KEEP_HEAD));
			out.push(`⋮ … ${elided} lines of code elided …`);
			out.push(...codeRun.slice(-CODE_KEEP_TAIL));
			stats.codeLinesElided += elided;
		} else {
			out.push(...codeRun);
		}
		codeRun = [];
	};

	for (let i = 0; i < lines.length && i < MAX_TRANSFORM_LINES; i++) {
		const line = lines[i];

		// Inside (or delimited by) a fenced block.
		if (line.kind === "code" || line.kind === "fence") {
			if (options.codeBlocks === "remove") continue;
			if (line.kind === "fence") {
				flushCodeRun();
				codeFenceInfo = line.fenceStart === i ? line.fenceInfo ?? "" : null;
				out.push(line.text);
				continue;
			}
			if (codeFenceInfo === null && line.fenceInfo !== undefined) codeFenceInfo = line.fenceInfo;
			codeRun.push(line.text);
			continue;
		}
		flushCodeRun();
		codeFenceInfo = null;

		if (line.kind === "blank") {
			out.push("");
			continue;
		}

		let current = line.text;

		// -- headings
		const heading = matchHeading(current);
		if (heading) {
			if (
				options.dedupeTitleHeading &&
				!droppedTitleHeading &&
				heading.level <= (noteMinLevel < 7 ? noteMinLevel : 1) &&
				(normalizeForCompare(heading.text) === titleText ||
					normalizeForCompare(heading.text) === normalizeForCompare(stripExtension(context.path)))
			) {
				droppedTitleHeading = true;
				continue;
			}
			if (heading.level <= noteMinLevel) droppedTitleHeading = true;
			if (levelShift !== 0) {
				const level = Math.max(1, Math.min(6, heading.level + levelShift));
				current = `${"#".repeat(level)} ${heading.text}`;
			}
		}

		// -- callouts (marker line only; the quoted body stays quoted)
		if (options.unwrapCallouts) current = unwrapCalloutMarker(current);

		// -- tasks
		if (isTaskItem(current)) {
			if (options.taskHandling === "dropDone" && /\[[xX]\]/.test(current)) {
				stats.tasksRemoved++;
				continue;
			}
			if (options.taskHandling === "clear" || options.taskHandling === "dropDone") {
				current = current.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX/\-]\]\s?/, "$1");
			}
		}

		// -- links & tags
		const extracted = extractLinksFromLine(current);
		for (const tag of extracted.tags) inlineTags.push(tag);
		current = rewriteLinks(current, options, context);
		if (options.tags === "hoist" || options.tags === "strip") current = removeTagsFromLine(current);

		out.push(current);
	}
	flushCodeRun();

	// -- 5. embeds & attachments ---------------------------------------------
	let rendered = out.join("\n");
	rendered = await resolveEmbeds(rendered, options, context, stats, warnings, 0);

	if (options.frontmatter === "keep" && frontmatterRaw) {
		rendered = `---\n${frontmatterRaw}\n---\n\n${rendered}`;
	}

	// -- 6. cleanup -----------------------------------------------------------
	if (options.trimTrailingWhitespace) rendered = stripTrailingWhitespace(rendered);
	if (options.collapseBlankLines >= 0) rendered = collapseBlankLines(rendered, options.collapseBlankLines);
	rendered = rendered.replace(/\n{3,}/g, "\n\n").trim();

	return {
		text: rendered,
		inlineTags,
		frontmatterRaw: options.frontmatter === "strip" ? null : frontmatterRaw,
		stats,
		warnings,
	};
}

function shallowestHeading(lines: ReturnType<typeof scanLines>): number {
	let min = 7;
	for (const line of lines) {
		if (line.kind !== "text") continue;
		const heading = matchHeading(line.text);
		if (heading && heading.level < min) min = heading.level;
	}
	return min;
}

/* -------------------------------------------------------------------------- */
/*  Frontmatter                                                                */
/* -------------------------------------------------------------------------- */

function splitFrontmatterBlock(text: string): { body: string; frontmatterRaw: string | null } {
	if (!/^---\r?\n/.test(text)) return { body: text, frontmatterRaw: null };
	const lines = text.split("\n");
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		const trimmed = lines[i].replace(/\r$/, "").trim();
		if (trimmed === "---" || trimmed === "...") {
			end = i;
			break;
		}
	}
	if (end === -1) return { body: text, frontmatterRaw: null };
	const raw = lines
		.slice(1, end)
		.map((l) => l.replace(/\r$/, ""))
		.join("\n");
	const body = lines
		.slice(end + 1)
		.join("\n")
		.replace(/^\n+/, "");
	return { body, frontmatterRaw: raw };
}

/* -------------------------------------------------------------------------- */
/*  Noise removal                                                              */
/* -------------------------------------------------------------------------- */

function stripDataviewBlocks(text: string): string {
	return text.replace(/^(`{3,}|~{3,})(dataview|dataviewjs|query|tasks)\b[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
}

/* -------------------------------------------------------------------------- */
/*  Links                                                                      */
/* -------------------------------------------------------------------------- */

const WIKILINK_RE = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const MDLINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g;
const BARE_URL_RE = /(?<![([<\w/])(https?:\/\/[^\s<>()[\]"']+)/g;

function rewriteLinks(line: string, options: TransformOptions, context: TransformContext): string {
	line = line.replace(WIKILINK_RE, (match, bang: string, inner: string) => {
		const isEmbed = bang === "!";
		const { target, heading, block, alias } = splitWikiTarget(inner);

		if (isEmbed) {
			if (options.embeds === "remove") return "";
			if (options.embeds === "reference") return `[[${inner}]]`;
			return match; // real transclusion happens in the async pass
		}
		if (options.wikilinks === "keep") return match;
		if (options.wikilinks === "remove") return "";
		if (options.wikilinks === "path") {
			const resolved = context.resolver?.resolve(target, context.path) ?? target;
			return appendAnchor(resolved, heading, block);
		}
		if (alias) return alias;
		const resolved = context.resolver?.resolve(target, context.path);
		const label = resolved ? stripExtension(basename(resolved)) : target === "" ? "" : stripExtension(basename(target));
		return appendAnchor(label, heading, block);
	});

	line = line.replace(MDLINK_RE, (match, bang: string, alt: string, url: string) => {
		if (/^(?:https?:|mailto:)/i.test(url)) return rewriteExternal(url, alt, bang === "!", options);
		const isImage = bang === "!" || context.resolver?.isImage(url) === true;
		if (isImage) {
			if (options.attachments === "drop") return "";
			return `![${alt || basename(url)}](${url})`;
		}
		return options.wikilinks === "remove" ? "" : `[${alt || basename(url)}](${url})`;
	});

	if (options.externalLinks === "strip") {
		line = line.replace(BARE_URL_RE, "");
	} else if (options.externalLinks === "label") {
		line = line.replace(BARE_URL_RE, (url) => url);
	}
	return line;
}

function rewriteExternal(url: string, alt: string, isImage: boolean, options: TransformOptions): string {
	if (isImage) {
		if (options.attachments === "drop") return "";
		return `![${alt || "image"}](${url})`;
	}
	switch (options.externalLinks) {
		case "strip":
			return alt || "";
		case "label":
			return alt ? `${alt} (${url})` : url;
		default:
			return `[${alt || url}](${url})`;
	}
}

function splitWikiTarget(inner: string): { target: string; heading?: string; block?: string; alias?: string } {
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
	return { target: targetPart.trim(), heading, block, alias };
}

function appendAnchor(label: string, heading?: string, block?: string): string {
	if (block) return `${label} (^${block})`;
	if (heading) return `${label} › ${heading}`;
	return label;
}

/* -------------------------------------------------------------------------- */
/*  Tags                                                                       */
/* -------------------------------------------------------------------------- */

const TAG_RE = /(^|[\s(>|,;:[{])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;

function removeTagsFromLine(line: string): string {
	return line
		.replace(TAG_RE, (_m, prefix: string) => prefix)
		.replace(/[ \t]{2,}/g, " ")
		.trimEnd();
}

/* -------------------------------------------------------------------------- */
/*  Callouts                                                                   */
/* -------------------------------------------------------------------------- */

const CALLOUT_RE = /^\[!([\w-]+)\]([+-]?)\s*(.*)$/;

function unwrapCalloutMarker(line: string): string {
	const quote = matchBlockquote(line);
	if (!quote) return line;
	const match = CALLOUT_RE.exec(quote.text.trim());
	if (!match) return line;
	const type = match[1].toLowerCase();
	const title = (match[3] ?? "").trim();
	const icon = calloutIcon(type);
	const marker = [title !== "" ? `**${title}**` : `**${capitalize(type)}**`, icon].filter(Boolean).join(" ");
	const prefix = "> ".repeat(quote.depth);
	return `${prefix}${marker}`;
}

function calloutIcon(type: string): string {
	switch (type) {
		case "warning":
		case "caution":
		case "attention":
			return "⚠️";
		case "danger":
		case "error":
			return "⛔";
		case "tip":
		case "hint":
		case "important":
			return "💡";
		case "question":
		case "faq":
			return "❓";
		case "example":
			return "🧪";
		case "quote":
			return "❝";
		case "todo":
			return "☑️";
		case "success":
		case "check":
		case "done":
			return "✅";
		case "failure":
		case "fail":
		case "missing":
			return "❌";
		case "info":
			return "ℹ️";
		case "abstract":
		case "summary":
		case "tldr":
			return "📋";
		default:
			return "";
	}
}

function capitalize(text: string): string {
	return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/* -------------------------------------------------------------------------- */
/*  Embeds, transclusion & attachments                                         */
/* -------------------------------------------------------------------------- */

const EMBED_LINE_RE = /^([ \t>]*)(!\[\[([^[\]\n]+?)\]\])[ \t]*$/gm;

async function resolveEmbeds(
	text: string,
	options: TransformOptions,
	context: TransformContext,
	stats: TransformStats,
	warnings: string[],
	depth: number,
): Promise<string> {
	if (options.embeds === "remove") return text.replace(/!\[\[[^[\]\n]+?\]\]/g, "");
	if (options.embeds === "reference") return text.replace(/!\[\[([^[\]\n]+?)\]\]/g, "[[$1]]");
	if (!context.resolver) return text;

	EMBED_LINE_RE.lastIndex = 0;
	const found: { full: string; inner: string; indent: string }[] = [];
	let m: RegExpExecArray | null;
	while ((m = EMBED_LINE_RE.exec(text)) !== null) {
		found.push({ full: m[2], inner: m[3], indent: m[1] });
	}
	if (found.length === 0) return text;

	const cache = new Map<string, string>();
	let result = text;
	for (const item of found) {
		let replacement = cache.get(item.full);
		if (replacement === undefined) {
			replacement = await resolveSingleEmbed(item, options, context, stats, warnings, depth);
			cache.set(item.full, replacement);
		}
		result = result.split(item.full).join(replacement);
	}
	return result;
}

async function resolveSingleEmbed(
	item: { full: string; inner: string; indent: string },
	options: TransformOptions,
	context: TransformContext,
	stats: TransformStats,
	warnings: string[],
	depth: number,
): Promise<string> {
	const { target, heading, block, alias } = splitWikiTarget(item.inner);
	const resolver = context.resolver;
	if (!resolver) return item.full;

	// -- images / attachments
	if (resolver.isImage(target)) {
		if (options.attachments === "drop") {
			stats.imagesDropped++;
			return "";
		}
		const resolved = resolver.resolve(target, context.path) ?? target;
		const size = resolver.sizeOf(resolved) ?? 0;
		if (options.attachments === "inline" && resolver.readBinary && size > 0 && size <= options.inlineImageMaxBytes) {
			const base64 = await resolver.readBinary(resolved);
			if (base64) {
				stats.imagesInlined++;
				const ext = (resolved.split(".").pop() ?? "png").toLowerCase();
				const mime = ext === "jpg" ? "jpeg" : ext === "svg" ? "svg+xml" : ext;
				return `![${alias ?? basename(resolved)}](data:image/${mime};base64,${base64})`;
			}
		}
		if (options.attachments === "inline" && size > options.inlineImageMaxBytes) {
			warnings.push(
				`Image ${resolved} (${Math.round(size / 1024)} kB) exceeds the inline limit — referenced instead.`,
			);
		}
		stats.imagesReferenced++;
		return `![${alias ?? basename(resolved)}](${resolved})`;
	}

	// -- note transclusion
	const resolved = resolver.resolve(target, context.path);
	if (!resolved) {
		warnings.push(`Embed target not found: ${target} (in ${context.path})`);
		return item.full;
	}
	const maxDepth = context.transclusion?.depth ?? 2;
	if (depth >= maxDepth) {
		return `*(${stripExtension(basename(resolved))} — transclusion depth limit reached)*`;
	}
	const nested = await resolver.readNote(resolved);
	if (nested === null) {
		warnings.push(`Could not read transcluded note: ${resolved}`);
		return item.full;
	}

	let content = nested;
	if (heading) content = extractSection(content, heading) ?? content;
	if (block) content = extractBlock(content, block) ?? content;

	const limit = context.transclusion?.maxChars ?? 20_000;
	if (content.length > limit) {
		content = `${content.slice(0, limit)}\n\n*… transclusion truncated at ${limit} characters …*`;
	}

	content = await resolveEmbeds(
		content,
		options,
		{ ...context, path: resolved },
		stats,
		warnings,
		depth + 1,
	);

	stats.transclusions++;
	stats.transclusionChars += content.length;

	const label = alias ?? stripExtension(basename(resolved));
	const marker = markerFor(context.format, label);
	return `${marker.begin}\n${content.trim()}\n${marker.end}`;
}

function markerFor(format: ExportFormat, label: string): { begin: string; end: string } {
	switch (format) {
		case "xml":
			return { begin: `<transclusion source="${escapeXml(label)}">`, end: `</transclusion>` };
		case "plain":
			return { begin: `--- [transcluded: ${label}] ---`, end: `--- [end transclusion] ---` };
		case "json":
		case "jsonl":
			return { begin: `/* transcluded: ${label} */`, end: `/* end transclusion */` };
		default:
			return { begin: `<!-- ⤵ transcluded from "${label}" -->`, end: `<!-- ⤴ end transclusion -->` };
	}
}

/* -------------------------------------------------------------------------- */
/*  Transclusion helpers                                                       */
/* -------------------------------------------------------------------------- */

/** Extracts the section under a heading (Obsidian `[[Note#Heading]]`). */
export function extractSection(text: string, heading: string): string | null {
	const lines = text.split("\n");
	const wanted = normalizeForCompare(heading);
	let start = -1;
	let level = 0;
	for (let i = 0; i < lines.length; i++) {
		const h = matchHeading(lines[i]);
		if (!h) continue;
		if (start === -1) {
			if (normalizeForCompare(h.text) === wanted) {
				start = i;
				level = h.level;
			}
			continue;
		}
		if (h.level <= level) return lines.slice(start, i).join("\n").trim();
	}
	if (start === -1) return null;
	return lines.slice(start).join("\n").trim();
}

/** Extracts a `^block-id` reference (the paragraph or list item carrying it). */
export function extractBlock(text: string, blockId: string): string | null {
	const lines = text.split("\n");
	const needle = `^${blockId}`;
	const index = lines.findIndex((l) => l.includes(needle));
	if (index === -1) return null;
	let start = index;
	while (start > 0 && lines[start - 1].trim() !== "" && !/^#{1,6}\s/.test(lines[start - 1]) && !/^\s*[-*+]/.test(lines[start - 1])) {
		start--;
	}
	return lines
		.slice(start, index + 1)
		.join("\n")
		.replace(needle, "")
		.trim();
}

/* -------------------------------------------------------------------------- */
/*  Misc                                                                       */
/* -------------------------------------------------------------------------- */

export function normalizeForCompare(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function escapeXml(text: string): string {
	return text.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] ?? c);
}

/** Structural summary of a transformed note, used by the quality report. */
export interface NoteShape {
	headings: number;
	lists: number;
	codeLines: number;
	words: number;
	links: number;
}

export function shapeOf(text: string): NoteShape {
	const lines = scanLines(text);
	let headings = 0;
	let lists = 0;
	let codeLines = 0;
	let links = 0;
	for (const line of lines) {
		if (line.kind === "code" || line.kind === "fence") codeLines++;
		else {
			if (matchHeading(line.text)) headings++;
			else if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line.text)) lists++;
			links += (line.text.match(/\[\[|\]\(/g) ?? []).length;
		}
	}
	return { headings, lists, codeLines, words: countWords(stripInlineMarkup(text)), links };
}
