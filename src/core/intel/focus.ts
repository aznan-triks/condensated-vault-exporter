/**
 * Topic focus & Smart Query Engine: "export what this vault knows about X".
 *
 * Folder and tag filters need the vault to be organised before the export can
 * be useful. A topic filter needs nothing: the notes are analysed anyway, so
 * the corpus can be ranked against a free-text query (with optional structured
 * operators) and only the best slice exported. It is the difference between
 * "the Retrieval folder" and "everything I have ever written that bears on
 * reranking".
 *
 * Supports:
 * - Multi-field BM25F/TF-IDF ranking (title, aliases, tags, path, section
 *   headings, and body key terms)
 * - Exact phrase bonuses (`"reciprocal rank fusion"` or multi-word queries)
 * - Prefix/stem matching (so `rerank` matches `reranking` and `reranker`)
 * - 2-letter technical acronyms (`AI`, `ML`, `DB`, `UI`, `UX`, `Go`, `TS`…)
 * - Inline operators: `tag:x`, `-tag:y`, `#x`, `path:foo`, `-path:bar`,
 *   `title:baz`, `has:code`, `has:links`, `has:embeds`, `has:headings`,
 *   `-term` negation, and `hops:1` / `+links` graph spreading activation.
 */

import type { DocAnalysis } from "../types";
import { tagMatches } from "../frontmatter";
import type { LinkGraph } from "./graph";
import { STOP_WORDS, type KeyTermsResult } from "./terms";

export interface FocusScore {
	path: string;
	score: number;
}

export interface FocusOutcome {
	/** Paths that made the cut, best first. */
	kept: string[];
	/** How many notes scored above zero. */
	matched: number;
	/** Query terms that exist in the corpus. */
	terms: string[];
	/** Query terms that do not appear anywhere (typos, jargon, other language). */
	unknown: string[];
}

export interface FocusRankOptions {
	/** Optional link graph used for co-citation boosts and `hops:N` expansion. */
	graph?: LinkGraph;
}

export interface ParsedFocusQuery {
	/** Positive search terms (normalized lowercase). */
	terms: string[];
	/** Quoted phrases (`"..."`). */
	phrases: string[];
	/** Terms that must NOT appear in the note (`-word`). */
	excludedTerms: string[];
	/** Required tags (`tag:foo` or `#foo`). */
	tagsAll: string[];
	/** Excluded tags (`-tag:foo` or `-#foo`). */
	tagsNone: string[];
	/** Required path substrings (`path:foo` or `folder:foo`). */
	pathsInclude: string[];
	/** Excluded path substrings (`-path:foo` or `-folder:foo`). */
	pathsExclude: string[];
	/** Required title substrings (`title:foo`). */
	titleInclude: string[];
	/** Structural requirements (`has:code`, `has:links`, `has:embeds`, `has:headings`, `has:tags`). */
	hasFlags: Set<string>;
	/** Structural exclusions (`-has:code`, etc.). */
	notHasFlags: Set<string>;
	/** Link hops to expand from matching notes (`hops:1`, `+links`). */
	hops: number;
	/** True when at least one structured filter operator was used. */
	hasDirectives: boolean;
}

/** Weight of a title/tag/path match, relative to a body term match (1.0). */
const HEADING_WEIGHT = 2.5;
/** Additional boost when the term is in the note's actual title or alias. */
const TITLE_EXACT_WEIGHT = 0.8;
/** Weight of a heading match: a section about the topic, not a passing mention. */
const SECTION_WEIGHT = 0.8;
/** Weight of a term that is not among the note's most characteristic terms. */
const WEAK_TERM_WEIGHT = 0.35;
/** Extra weight when the whole query (or a quoted phrase) appears in heading/section text. */
const PHRASE_WEIGHT = 1.5;
/** Discount applied when a term matches via prefix/stem rather than verbatim. */
const STEM_DISCOUNT = 0.72;

function wordsOf(text: string): Set<string> {
	const set = new Set<string>();
	const matches = text.toLowerCase().match(/[\p{L}\p{N}'’-]+/gu);
	if (!matches) return set;
	for (const word of matches) set.add(word);
	return set;
}

function normalizePhraseText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Lightweight English/French suffix stripper for prefix/stem matching on terms
 * of at least 5 characters. Never mutates short words.
 */
export function stemWord(word: string): string {
	const w = word.toLowerCase();
	if (w.length < 5) return w;
	for (const suffix of [
		"ization",
		"isation",
		"ational",
		"ements",
		"ement",
		"ations",
		"ation",
		"ities",
		"ness",
		"ings",
		"ing",
		"ers",
		"ed",
		"es",
		"er",
		"ly",
		"s",
	]) {
		if (w.endsWith(suffix) && w.length - suffix.length >= 4) {
			return w.slice(0, w.length - suffix.length);
		}
	}
	return w;
}

/**
 * Parses a focus query string into free-text terms, quoted phrases, and
 * structured operators (`tag:`, `path:`, `title:`, `has:`, `hops:`, `-term`).
 */
export function parseFocusQuery(rawQuery: string): ParsedFocusQuery {
	const phrases: string[] = [];
	const terms: string[] = [];
	const excludedTerms: string[] = [];
	const tagsAll: string[] = [];
	const tagsNone: string[] = [];
	const pathsInclude: string[] = [];
	const pathsExclude: string[] = [];
	const titleInclude: string[] = [];
	const hasFlags = new Set<string>();
	const notHasFlags = new Set<string>();
	let hops = 0;
	let hasDirectives = false;

	// 1. Extract quoted phrases first.
	const withoutQuotes = rawQuery.replace(/"([^"]+)"|\u201c([^\u201d]+)\u201d/g, (_m, g1?: string, g2?: string) => {
		const content = normalizePhraseText(g1 ?? g2 ?? "");
		if (content !== "") {
			phrases.push(content);
			for (const word of extractQueryTokens(content)) {
				if (!terms.includes(word)) terms.push(word);
			}
		}
		return " ";
	});

	// 2. Scan whitespace-delimited tokens for directives or words.
	const rawTokens = withoutQuotes.trim().split(/\s+/).filter(Boolean);
	for (const token of rawTokens) {
		const lower = token.toLowerCase();
		if (lower === "+links" || lower === "+neighbourhood" || lower === "+neighborhood") {
			hops = Math.max(hops, 1);
			hasDirectives = true;
			continue;
		}
		const hopMatch = /^hops?:(\d+)$/i.exec(token);
		if (hopMatch) {
			hops = Math.min(3, Math.max(0, Number.parseInt(hopMatch[1], 10) || 0));
			hasDirectives = true;
			continue;
		}
		const tagOp = /^(-)?(?:tag:|#)([\p{L}\p{N}_/-]+?\*?)$/iu.exec(token);
		if (tagOp) {
			hasDirectives = true;
			if (tagOp[1] === "-") tagsNone.push(tagOp[2].toLowerCase());
			else tagsAll.push(tagOp[2].toLowerCase());
			continue;
		}
		const pathOp = /^(-)?(?:path|folder|dir):(\S+)$/i.exec(token);
		if (pathOp) {
			hasDirectives = true;
			const clean = pathOp[2].replace(/^\/+|\/+$/g, "").toLowerCase();
			if (clean !== "") {
				if (pathOp[1] === "-") pathsExclude.push(clean);
				else pathsInclude.push(clean);
			}
			continue;
		}
		const titleOp = /^title:(\S+)$/i.exec(token);
		if (titleOp) {
			hasDirectives = true;
			const clean = titleOp[1].toLowerCase();
			if (clean !== "") titleInclude.push(clean);
			continue;
		}
		const hasOp = /^(-)?has:(code|links|embeds|headings|tags|tasks)$/i.exec(token);
		if (hasOp) {
			hasDirectives = true;
			const flag = hasOp[2].toLowerCase();
			if (hasOp[1] === "-") notHasFlags.add(flag);
			else hasFlags.add(flag);
			continue;
		}
		if ((token.startsWith("-") || token.startsWith("!")) && token.length > 2) {
			const negWords = extractQueryTokens(token.slice(1));
			for (const w of negWords) {
				if (!excludedTerms.includes(w)) excludedTerms.push(w);
			}
			hasDirectives = true;
			continue;
		}

		for (const word of extractQueryTokens(token)) {
			if (!terms.includes(word)) terms.push(word);
		}
	}

	return {
		terms,
		phrases,
		excludedTerms,
		tagsAll,
		tagsNone,
		pathsInclude,
		pathsExclude,
		titleInclude,
		hasFlags,
		notHasFlags,
		hops,
		hasDirectives,
	};
}

function extractQueryTokens(text: string): string[] {
	const matches = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]{1,39}/gu);
	if (!matches) return [];
	const out: string[] = [];
	for (const raw of matches) {
		if (STOP_WORDS.has(raw)) continue;
		if (/^\d+$/.test(raw)) continue;
		if (raw.includes("://")) continue;
		out.push(raw);
	}
	return out;
}

function matchesDirectives(doc: DocAnalysis, parsed: ParsedFocusQuery, allWords: Set<string>): boolean {
	if (parsed.tagsAll.length > 0) {
		for (const req of parsed.tagsAll) {
			if (!doc.tags.some((t) => tagMatches(t, req))) return false;
		}
	}
	if (parsed.tagsNone.length > 0) {
		if (doc.tags.some((t) => parsed.tagsNone.some((banned) => tagMatches(t, banned)))) return false;
	}
	const lowerPath = doc.file.path.toLowerCase();
	if (parsed.pathsInclude.length > 0) {
		if (!parsed.pathsInclude.some((p) => lowerPath.includes(p))) return false;
	}
	if (parsed.pathsExclude.length > 0) {
		if (parsed.pathsExclude.some((p) => lowerPath.includes(p))) return false;
	}
	const lowerTitle = doc.title.toLowerCase();
	if (parsed.titleInclude.length > 0) {
		if (!parsed.titleInclude.some((t) => lowerTitle.includes(t))) return false;
	}
	if (parsed.hasFlags.size > 0 || parsed.notHasFlags.size > 0) {
		const checkFlag = (flag: string): boolean => {
			switch (flag) {
				case "code":
					return doc.stats.codeLines > 0;
				case "links":
					return doc.outgoing.length > 0;
				case "embeds":
					return doc.links.some((l) => l.isEmbed);
				case "headings":
					return doc.headings.length > 0;
				case "tags":
					return doc.tags.length > 0;
				default:
					return true;
			}
		};
		for (const flag of parsed.hasFlags) if (!checkFlag(flag)) return false;
		for (const flag of parsed.notHasFlags) if (checkFlag(flag)) return false;
	}
	if (parsed.excludedTerms.length > 0) {
		for (const neg of parsed.excludedTerms) {
			if (allWords.has(neg)) return false;
		}
	}
	return true;
}

/**
 * Ranks `docs` against `query` and returns the best `maxNotes` (0 = no cap).
 * Ties break on the note's signal then alphabetically, so the result is stable
 * across runs — an export that keeps changing for no reason is impossible to
 * review.
 */
export function rankByFocus(
	docs: DocAnalysis[],
	keyTerms: KeyTermsResult,
	query: string,
	maxNotes: number,
	options: FocusRankOptions = {},
): FocusOutcome {
	const parsed = parseFocusQuery(query);
	const terms = parsed.terms;
	if (terms.length === 0 && !parsed.hasDirectives && parsed.phrases.length === 0) {
		return { kept: docs.map((doc) => doc.file.path), matched: docs.length, terms: [], unknown: [] };
	}

	// Precompute per-document word sets and normalized strings so we only scan once.
	const docMeta = docs.map((doc) => {
		const titleText = normalizePhraseText(`${doc.title} ${doc.aliases.join(" ")}`);
		const headingText = normalizePhraseText(`${doc.title} ${doc.aliases.join(" ")} ${doc.tags.join(" ")} ${doc.file.path}`);
		const sectionText = normalizePhraseText(doc.headings.map((entry) => entry.text).join(" "));
		const titleWords = wordsOf(`${doc.title} ${doc.aliases.join(" ")}`);
		const heading = wordsOf(`${doc.title} ${doc.aliases.join(" ")} ${doc.tags.join(" ")} ${doc.file.path}`);
		const sections = wordsOf(doc.headings.map((entry) => entry.text).join(" "));
		const body = new Set(doc.topTerms);
		const allWords = new Set<string>([...heading, ...sections, ...body]);
		const stems = new Map<string, string>();
		for (const w of allWords) {
			if (w.length >= 4) {
				const st = stemWord(w);
				if (!stems.has(st)) stems.set(st, w);
			}
		}
		return { doc, titleText, headingText, sectionText, titleWords, heading, sections, body, allWords, stems };
	});

	// Filter-only query (e.g. `tag:project path:Projects/ has:code`):
	if (terms.length === 0 && parsed.phrases.length === 0 && parsed.hasDirectives) {
		const filtered = docMeta
			.filter((m) => matchesDirectives(m.doc, parsed, m.allWords))
			.sort((a, b) => b.doc.signal - a.doc.signal || a.doc.file.path.localeCompare(b.doc.file.path))
			.map((m) => m.doc.file.path);
		const kept = maxNotes > 0 ? filtered.slice(0, maxNotes) : filtered;
		return { kept, matched: filtered.length, terms: [], unknown: [] };
	}

	const total = Math.max(1, docs.length);
	const unknown: string[] = [];
	const idf = new Map<string, number>();
	const stemMatchedTerm = new Map<string, string>();

	for (const term of terms) {
		let df = keyTerms.documentFrequency.get(term) ?? 0;
		if (df === 0) {
			// Check if the term appears in titles, tags, paths, headings, or 2-char words.
			for (const meta of docMeta) {
				if (meta.allWords.has(term)) df++;
			}
		}
		if (df === 0 && term.length >= 4) {
			const qStem = stemWord(term);
			for (const meta of docMeta) {
				if (meta.stems.has(qStem)) {
					df++;
					stemMatchedTerm.set(term, qStem);
				}
			}
		}
		if (df === 0) {
			unknown.push(term);
			continue;
		}
		idf.set(term, Math.log(1 + total / (1 + df)));
	}

	const known = terms.filter((term) => idf.has(term));
	const implicitPhrase = known.length > 1 ? known.join(" ") : "";
	const phrasesToCheck = uniqueStrings([...parsed.phrases, ...(implicitPhrase ? [implicitPhrase] : [])]);

	const scoreByPath = new Map<string, number>();
	for (const meta of docMeta) {
		const { doc, titleText, headingText, sectionText, titleWords, heading, sections, body, allWords, stems } = meta;
		if (!matchesDirectives(doc, parsed, allWords)) continue;

		const weights = new Map<string, number>();
		for (const entry of keyTerms.byPath.get(doc.file.path) ?? []) weights.set(entry.term, entry.weight);

		let score = 0;
		let matched = 0;

		for (const term of known) {
			const termWeight = idf.get(term) ?? 0;
			const keyword = weights.get(term);
			const inBody = body.has(term);
			const inSections = sections.has(term);
			const inHeading = heading.has(term);
			const inTitle = titleWords.has(term);

			if (keyword !== undefined || inBody || inSections || inHeading) {
				if (keyword !== undefined) score += keyword;
				else if (inBody) score += termWeight * WEAK_TERM_WEIGHT;
				if (inSections) score += termWeight * SECTION_WEIGHT;
				if (inHeading) score += termWeight * HEADING_WEIGHT;
				if (inTitle) score += termWeight * TITLE_EXACT_WEIGHT;
				matched++;
				continue;
			}

			// Fallback: prefix/stem match (e.g. `rerank` <-> `reranking`).
			const qStem = stemMatchedTerm.get(term) ?? (term.length >= 4 ? stemWord(term) : "");
			if (qStem !== "" && stems.has(qStem)) {
				const matchedWord = stems.get(qStem)!;
				const stemKeyword = weights.get(matchedWord);
				if (stemKeyword !== undefined) score += stemKeyword * STEM_DISCOUNT;
				else if (body.has(matchedWord)) score += termWeight * WEAK_TERM_WEIGHT * STEM_DISCOUNT;
				if (sections.has(matchedWord)) score += termWeight * SECTION_WEIGHT * STEM_DISCOUNT;
				if (heading.has(matchedWord)) score += termWeight * HEADING_WEIGHT * STEM_DISCOUNT;
				matched++;
			}
		}

		// A note that answers several parts of the query is more on-topic than
		// one that happens to repeat a single word.
		if (matched > 1) score *= 1 + 0.35 * (matched - 1);

		// Phrase bonus: check actual normalized text strings (not single-word sets!).
		for (const phrase of phrasesToCheck) {
			if (phrase === "") continue;
			const average =
				known.length > 0 ? known.reduce((acc, term) => acc + (idf.get(term) ?? 0), 0) / known.length : 1.0;
			if (titleText.includes(phrase) || headingText.includes(phrase)) {
				score += average * PHRASE_WEIGHT;
				if (matched === 0) matched = 1;
			} else if (sectionText.includes(phrase)) {
				score += average * (PHRASE_WEIGHT * 0.6);
				if (matched === 0) matched = 1;
			}
		}

		if (score > 0) scoreByPath.set(doc.file.path, score);
	}

	// Graph co-citation & optional hop expansion (`hops:N` or `+links`):
	if (options.graph && scoreByPath.size > 0) {
		const initialScores = new Map(scoreByPath);
		const docByPath = new Map(docMeta.map((m) => [m.doc.file.path, m]));

		// Co-citation boost among already matching notes: if a matching note links
		// to or from another matching note, boost it slightly so connected clusters
		// rank above isolated passing mentions.
		for (const [path, baseScore] of initialScores) {
			const node = options.graph.nodes.get(path);
			if (!node) continue;
			let connectedMatches = 0;
			for (const neighbour of [...node.links, ...node.backlinks]) {
				if (initialScores.has(neighbour)) connectedMatches++;
			}
			if (connectedMatches > 0) {
				scoreByPath.set(path, baseScore * (1 + Math.min(0.25, connectedMatches * 0.06)));
			}
		}

		// Explicit hop expansion (`hops:1` / `+links` in query):
		if (parsed.hops > 0) {
			let frontier = Array.from(initialScores.entries());
			for (let hop = 1; hop <= parsed.hops; hop++) {
				const decay = Math.pow(0.25, hop);
				const nextFrontier: [string, number][] = [];
				for (const [sourcePath, sourceScore] of frontier) {
					const node = options.graph.nodes.get(sourcePath);
					if (!node) continue;
					for (const neighbour of [...node.links, ...node.backlinks]) {
						if (scoreByPath.has(neighbour)) continue;
						const meta = docByPath.get(neighbour);
						if (!meta || !matchesDirectives(meta.doc, parsed, meta.allWords)) continue;
						const propagated = sourceScore * decay;
						if (propagated > 0) {
							scoreByPath.set(neighbour, propagated);
							nextFrontier.push([neighbour, propagated]);
						}
					}
				}
				if (nextFrontier.length === 0) break;
				frontier = nextFrontier;
			}
		}
	}

	const scores: FocusScore[] = Array.from(scoreByPath.entries()).map(([path, score]) => ({ path, score }));
	const byPath = new Map(docs.map((doc) => [doc.file.path, doc]));
	scores.sort(
		(a, b) =>
			b.score - a.score ||
			(byPath.get(b.path)?.signal ?? 0) - (byPath.get(a.path)?.signal ?? 0) ||
			a.path.localeCompare(b.path),
	);
	const ranked = scores.map((entry) => entry.path);
	const kept = maxNotes > 0 ? ranked.slice(0, maxNotes) : ranked;
	return { kept, matched: ranked.length, terms: known, unknown };
}

function uniqueStrings(items: string[]): string[] {
	return Array.from(new Set(items));
}
