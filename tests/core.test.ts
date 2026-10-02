import { describe, expect, it } from "vitest";
import { matchGlob, matchAny, isValidGlob } from "../src/core/glob";
import { parseFrontmatter, stringifyFrontmatter, asStringArray, tagMatches } from "../src/core/frontmatter";
import { estimateTokens, countTokens } from "../src/core/tokens";
import { hash32, naturalCompare, sanitizeFileName, slugify, normalizeVaultPath, mapLimit } from "../src/core/util";
import { splitSentences, scanLines, fenceRanges, stripInlineMarkup } from "../src/core/markdown/syntax";
import { extractLinksFromLine, resolveLinkTarget } from "../src/core/markdown/links";
import { analyzeDocument, compareSignatures, signatureSimilarity } from "../src/core/markdown/analyzer";

describe("glob", () => {
	it("matches star patterns anywhere in the path", () => {
		expect(matchGlob("*.md", "notes/a.md")).toBe(true);
		expect(matchGlob("*.md", "a.md")).toBe(true);
		expect(matchGlob("*.md", "notes/a.txt")).toBe(false);
	});

	it("supports double star", () => {
		expect(matchGlob("notes/**/*.md", "notes/a/b/c.md")).toBe(true);
		expect(matchGlob("notes/**", "notes/a/b.md")).toBe(true);
		expect(matchGlob("**/*.md", "deep/nested/x.md")).toBe(true);
	});

	it("supports folders, classes and alternation", () => {
		expect(matchGlob("drafts/", "drafts/a.md")).toBe(true);
		expect(matchGlob("drafts/", "drafts")).toBe(true);
		expect(matchGlob("*.m{d,arkdown}", "x.md")).toBe(true);
		expect(matchGlob("*.m{d,arkdown}", "x.markdown")).toBe(true);
		expect(matchGlob("file[0-9].md", "file3.md")).toBe(true);
		expect(matchGlob("file[!0-9].md", "file3.md")).toBe(false);
	});

	it("handles negation with last-match-wins", () => {
		expect(matchAny(["**/*.md", "!drafts/**"], "drafts/x.md")).toBe(false);
		expect(matchAny(["**/*.md", "!drafts/**"], "notes/x.md")).toBe(true);
		expect(matchAny(["!drafts/**"], "notes/x.md")).toBe(false);
	});

	it("validates patterns", () => {
		expect(isValidGlob("**/*.md")).toBe(true);
		expect(isValidGlob("*.[")).toBe(true);
	});
});

describe("frontmatter", () => {
	it("parses scalars, lists and nested maps", () => {
		const text = [
			"---",
			"title: My note",
			"tags:",
			"  - alpha",
			"  - beta",
			"created: 2026-01-02",
			"score: 12.5",
			"draft: false",
			"nested:",
			"  key: value",
			"inline: [1, 2, 3]",
			"quoted: \"hello: world\"",
			"empty:",
			"---",
			"Body text",
		].join("\n");
		const fm = parseFrontmatter(text);
		expect(fm.present).toBe(true);
		expect(fm.data.title).toBe("My note");
		expect(asStringArray(fm.data.tags)).toEqual(["alpha", "beta"]);
		expect(fm.data.created).toBe("2026-01-02");
		expect(fm.data.score).toBe(12.5);
		expect(fm.data.draft).toBe(false);
		expect((fm.data.nested as Record<string, unknown>).key).toBe("value");
		expect(fm.data.inline).toEqual([1, 2, 3]);
		expect(fm.data.quoted).toBe("hello: world");
		expect(fm.data.empty).toBeNull();
		expect(fm.endLine).toBe(14);
	});

	it("tolerates malformed and unterminated blocks", () => {
		expect(parseFrontmatter("---\ntitle: x").error).toBeTruthy();
		expect(parseFrontmatter("no frontmatter").present).toBe(false);
		expect(parseFrontmatter("---\n---\n").data).toEqual({});
	});

	it("round-trips through the serializer", () => {
		const data = { title: "A: B", tags: ["x", "y"], meta: { a: 1 }, flag: true };
		const raw = stringifyFrontmatter(data);
		const parsed = parseFrontmatter(`---\n${raw}\n---\n`);
		expect(parsed.data.title).toBe("A: B");
		expect(parsed.data.tags).toEqual(["x", "y"]);
		expect(parsed.data.flag).toBe(true);
		expect((parsed.data.meta as Record<string, unknown>).a).toBe(1);
	});
});

describe("tokens", () => {
	it("scales with text length and stays in a plausible range", () => {
		const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
		const stats = estimateTokens(text);
		const words = text.trim().split(/\s+/).length;
		expect(stats.tokens).toBeGreaterThan(words * 0.9);
		expect(stats.tokens).toBeLessThan(words * 2.2);
	});

	it("counts CJK characters closer to one token each", () => {
		const cjk = "这是一个测试文本".repeat(10);
		expect(countTokens(cjk)).toBeGreaterThan(cjk.length * 0.7);
	});

	it("penalizes dense symbol soup", () => {
		const code = "{}()[]<>=+-*/%$#@!&|^~`;:,.?".repeat(10);
		expect(countTokens(code)).toBeGreaterThan(0);
	});
});

describe("util", () => {
	it("hashes deterministically and distinguishes content", () => {
		expect(hash32("hello")).toBe(hash32("hello"));
		expect(hash32("hello")).not.toBe(hash32("hello!"));
	});

	it("normalizes paths", () => {
		expect(normalizeVaultPath("/a//b/c.md")).toBe("a/b/c.md");
		expect(normalizeVaultPath("a\\b\\c.md")).toBe("a/b/c.md");
	});

	it("sorts naturally", () => {
		const sorted = ["Note 10", "Note 2", "Note 1"].sort(naturalCompare);
		expect(sorted).toEqual(["Note 1", "Note 2", "Note 10"]);
	});

	it("sanitizes file names", () => {
		expect(sanitizeFileName("a/b:c*d?")).toBe("a-b-c-d");
		expect(sanitizeFileName("   ")).toBe("export");
	});

	it("slugifies", () => {
		expect(slugify("My Heading (2026)")).toBe("my-heading-2026");
	});

	it("maps with a concurrency limit and keeps order", async () => {
		const result = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => n * 2);
		expect(result).toEqual([2, 4, 6, 8, 10]);
	});
});

describe("markdown syntax", () => {
	it("detects fenced blocks including unclosed ones", () => {
		const text = ["intro", "```js", "const a = 1;", "```", "after", "~~~", "x", "~~~"].join("\n");
		const lines = scanLines(text);
		expect(lines[1].kind).toBe("fence");
		expect(lines[2].kind).toBe("code");
		expect(lines[3].kind).toBe("fence");
		expect(lines[4].kind).toBe("text");
		expect(fenceRanges(text).length).toBe(2);
		const unclosed = scanLines("```\ncode only");
		expect(unclosed[1].kind).toBe("code");
		expect(fenceRanges("```\ncode only")).toHaveLength(1);
	});

	it("splits sentences without breaking abbreviations badly", () => {
		const sentences = splitSentences("Hello world. This is a test! Is it? Yes.");
		expect(sentences.length).toBeGreaterThanOrEqual(3);
	});

	it("strips inline markup", () => {
		expect(stripInlineMarkup("**bold** and [[Link|alias]] and `code`")).toBe("bold and alias and code");
	});
});

describe("links", () => {
	it("extracts wikilinks with aliases, headings and blocks", () => {
		const { links, tags } = extractLinksFromLine("- [[Note#Heading|Alias]] and ![[Embed]] #tag/sub");
		expect(links).toHaveLength(2);
		expect(links[0]).toMatchObject({ target: "Note", heading: "Heading", alias: "Alias", isEmbed: false });
		expect(links[1]).toMatchObject({ target: "Embed", isEmbed: true });
		expect(tags).toContain("tag/sub");
	});

	it("ignores links inside inline code", () => {
		const { links } = extractLinksFromLine("use `[[NotALink]]` here");
		expect(links).toHaveLength(0);
	});

	it("resolves by name, folder and closest path", () => {
		const index = new Map([
			["folder/a.md", "folder/a.md"],
			["other/a.md", "other/a.md"],
			["b.md", "b.md"],
		]);
		expect(resolveLinkTarget("a", "folder/x.md", index)).toBe("folder/a.md");
		expect(resolveLinkTarget("b", "folder/x.md", index)).toBe("b.md");
		expect(resolveLinkTarget("missing", "x.md", index)).toBeUndefined();
	});
});

describe("analyzer", () => {
	it("extracts structure, stats and signatures", () => {
		const file = {
			path: "notes/a.md",
			name: "a.md",
			folder: "notes",
			ext: "md",
			size: 500,
			mtime: Date.now(),
			ctime: Date.now(),
		};
		const text = [
			"---",
			"tags: [project, ideas]",
			"---",
			"# Title",
			"",
			"Some prose with a [[Link]] and #inline.",
			"",
			"## Section",
			"More prose that is long enough to be counted properly by the analyzer.",
		].join("\n");
		const doc = analyzeDocument(file, text);
		expect(doc.title).toBe("Title");
		expect(doc.tags).toEqual(expect.arrayContaining(["project", "ideas", "inline"]));
		expect(doc.headings.map((h) => h.text)).toEqual(["Title", "Section"]);
		expect(doc.outgoing).toEqual(["Link"]);
		expect(doc.stats.words).toBeGreaterThan(10);
		expect(doc.topTerms.length).toBeGreaterThan(0);
		expect(doc.signal).toBeGreaterThan(0);
	});

	it("estimates similarity between related documents", () => {
		const file = (path: string) => ({ path, name: path, folder: "", ext: "md", size: 1, mtime: 0, ctime: 0 });
		const shared = Array.from(
			{ length: 60 },
			(_, i) => `Gradient descent optimises parameters step ${i} by following the slope of the loss function.`,
		).join(" ");
		const a = analyzeDocument(file("a.md"), `${shared} Backpropagation computes those gradients efficiently.`);
		const b = analyzeDocument(file("b.md"), `${shared} Regularisation keeps the weights from exploding.`);
		const c = analyzeDocument(
			file("c.md"),
			Array.from({ length: 60 }, (_, i) => `Boiling water cooks pasta; the pot number ${i} holds sauce and basil.`).join(" "),
		);
		const ab = signatureSimilarity(a.shingles, b.shingles);
		const ac = signatureSimilarity(a.shingles, c.shingles);
		expect(ab).toBeGreaterThan(0.2);
		expect(ab).toBeGreaterThan(ac);
	});
});

describe("hashes", () => {
	it("produces stable 16-character lowercase hex digests", async () => {
		const { hash64, contentHash } = await import("../src/core/util");
		for (const text of ["", "a", "hello world", "x".repeat(5000), "accents éàü and emoji 🚀"]) {
			const digest = hash64(text);
			expect(digest).toMatch(/^[0-9a-f]{16}$/);
			expect(hash64(text)).toBe(digest); // deterministic
			expect(contentHash(text)).toMatch(/^[0-9a-f]{32}$/);
		}
		// Different content, different digest.
		const seen = new Set(Array.from({ length: 500 }, (_, i) => hash64(`note number ${i}`)));
		expect(seen.size).toBe(500);
	});

	it("changes when a character changes", async () => {
		const { contentHash } = await import("../src/core/util");
		expect(contentHash("the quick brown fox")).not.toBe(contentHash("the quick brown fix"));
	});
});

describe("splitting", () => {
	it("cuts unbreakable runs down to the limit", async () => {
		const { hardSplit } = await import("../src/core/pack/chunk");
		const blob = "A".repeat(20_000); // no whitespace at all
		const pieces = hardSplit(blob, 100);
		expect(pieces.length).toBeGreaterThan(10);
		for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(360);
		expect(pieces.join("")).toBe(blob);
	});

	it("keeps words intact when splitting prose", async () => {
		const { hardSplit } = await import("../src/core/pack/chunk");
		const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
		const pieces = hardSplit(text, 50);
		expect(pieces.length).toBeGreaterThan(3);
		for (const piece of pieces) {
			expect(piece.startsWith("word")).toBe(true);
			expect(piece.endsWith(" ")).toBe(false);
		}
		expect(pieces.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
	});

	it("estimates containment from the signature and the shingle counts", () => {
		const short = analyzeDocument(
			{ path: "short.md", name: "short.md", folder: "", ext: "md", size: 0, mtime: 0, ctime: 0 },
			`# Short\n\n${Array.from({ length: 28 }, (_, i) => `Sentence ${i} about retrieval and storage systems.`).join(" ")}\n`,
		);
		// Short notes keep their exact shingles: comparison is then exact.
		expect(short.shingleHashes).not.toBeNull();
		expect(short.shingleCount).toBe(short.shingleHashes!.length);
		const comparison = compareSignatures(short.shingles, short.shingles, short.shingleCount, short.shingleCount);
		expect(comparison.jaccard).toBeCloseTo(1, 5);
		expect(comparison.containment).toBeCloseTo(1, 2);

		// A long note keeps only the MinHash signature, with an upper bound on
		// the number of distinct shingles instead of the exact count.
		const long = analyzeDocument(
			{ path: "long.md", name: "long.md", folder: "", ext: "md", size: 0, mtime: 0, ctime: 0 },
			`# Long\n\n${Array.from({ length: 1200 }, (_, i) => `Sentence ${i} about retrieval and storage systems.`).join(" ")}\n`,
		);
		expect(long.shingleHashes).toBeNull();
		expect(long.shingleCount).toBeGreaterThan(256);
		const self = compareSignatures(long.shingles, long.shingles, long.shingleCount, long.shingleCount);
		expect(self.jaccard).toBeCloseTo(1, 5);
	});
});

describe("blank lines", () => {
	it("keeps paragraph breaks instead of welding paragraphs together", async () => {
		const { collapseBlankLines } = await import("../src/core/markdown/syntax");
		expect(collapseBlankLines("a\n\nb", 1)).toBe("a\n\nb");
		expect(collapseBlankLines("a\n\n\n\n\nb", 1)).toBe("a\n\nb");
		expect(collapseBlankLines("a\n\n\n\n\nb", 2)).toBe("a\n\n\nb");
		expect(collapseBlankLines("a\n\nb", 0)).toBe("a\nb");
	});
});
