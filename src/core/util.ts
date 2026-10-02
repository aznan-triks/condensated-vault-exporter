/**
 * Small dependency-free helpers shared by the whole engine.
 */

/* -------------------------------------------------------------------------- */
/*  Paths                                                                      */
/* -------------------------------------------------------------------------- */

/** Normalizes a vault path: forward slashes, no leading/trailing slash. */
export function normalizeVaultPath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
}

export function parentFolder(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

export function baseName(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? path : path.slice(i + 1);
}

/** Alias kept for readability at call sites. */
export const basename = baseName;

export function dirName(path: string): string {
	return parentFolder(path);
}

export function fileExtension(path: string): string {
	const base = baseName(path);
	const i = base.lastIndexOf(".");
	return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

export function stripExtension(path: string): string {
	const base = baseName(path);
	const i = base.lastIndexOf(".");
	return i <= 0 ? base : base.slice(0, i);
}

/** True when `path` equals `root` or lives under it. */
export function isInside(path: string, root: string): boolean {
	if (root === "") return true;
	const r = normalizeVaultPath(root);
	return path === r || path.startsWith(r + "/");
}

export function joinPath(...parts: string[]): string {
	return normalizeVaultPath(parts.filter((p) => p !== "" && p != null).join("/"));
}

/** Natural comparison so `Note 2` sorts before `Note 10`. */
export function naturalCompare(a: string, b: string): number {
	const chunk = /(\d+)|(\D+)/g;
	const ax = a.toLowerCase().match(chunk) ?? [];
	const bx = b.toLowerCase().match(chunk) ?? [];
	const len = Math.min(ax.length, bx.length);
	for (let i = 0; i < len; i++) {
		const as = ax[i];
		const bs = bx[i];
		const an = parseInt(as, 10);
		const bn = parseInt(bs, 10);
		const aIsNum = !Number.isNaN(an) && /^\d/.test(as);
		const bIsNum = !Number.isNaN(bn) && /^\d/.test(bs);
		if (aIsNum && bIsNum) {
			if (an !== bn) return an < bn ? -1 : 1;
			if (as.length !== bs.length) return as.length < bs.length ? -1 : 1;
		} else if (as !== bs) {
			return as < bs ? -1 : 1;
		}
	}
	return ax.length - bx.length;
}

/** Removes characters that are illegal in file names on Windows, macOS, Linux. */
export function sanitizeFileName(name: string, fallback = "export"): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[.\-\s]+/, "")
		.replace(/[.\-\s]+$/, "")
		.replace(/\s{2,}/g, " ")
		.trim();
	return cleaned.length === 0 ? fallback : cleaned.slice(0, 180);
}

export function slugify(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/[`*_~^[\]]/g, "")
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.replace(/\s+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-|-$/g, "");
}

/* -------------------------------------------------------------------------- */
/*  Hashing                                                                    */
/* -------------------------------------------------------------------------- */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/**
 * 64-bit FNV-1a over UTF-16 code units, then a fnv1a/xorshift mix to spread
 * bits. Fast (no crypto dependency, works on mobile), and good enough for
 * change detection — this is *not* a cryptographic hash.
 */
export function hash64(input: string, seed = 0): string {
	let h = FNV_OFFSET ^ BigInt(seed >>> 0);
	for (let i = 0; i < input.length; i++) {
		h ^= BigInt(input.charCodeAt(i) & 0xff);
		h = (h * FNV_PRIME) & MASK64;
		h ^= BigInt((input.charCodeAt(i) >> 8) & 0xff);
		h = (h * FNV_PRIME) & MASK64;
	}
	// xorshift* finalizer
	h ^= h >> 33n;
	h = (h * 0xff51afd7ed558ccdn) & MASK64;
	h ^= h >> 33n;
	return h.toString(16).padStart(16, "0");
}

/** Content hash for a document body (stable across platforms). */
export function contentHash(input: string): string {
	return hash64(input, 0x9e3779b9) + hash64(input, 0x85ebca6b);
}

/** Fast, well-distributed 32-bit hash of a string (used for MinHash seeds). */
export function hash32(input: string, seed = 0): number {
	let h = (0x811c9dc5 ^ seed) >>> 0;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b) >>> 0;
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35) >>> 0;
	h ^= h >>> 16;
	return h >>> 0;
}

/* -------------------------------------------------------------------------- */
/*  Misc                                                                       */
/* -------------------------------------------------------------------------- */

export function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

export function unique<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}

export function sum(values: number[]): number {
	let total = 0;
	for (const v of values) total += v;
	return total;
}

/** Formats a byte/char count for humans (1.2k, 3.4M…). */
export function formatCount(n: number): string {
	if (!Number.isFinite(n)) return "0";
	if (Math.abs(n) < 1000) return String(Math.round(n));
	if (Math.abs(n) < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
	return (n / 1_000_000).toFixed(1) + "M";
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes} min ${seconds} s`;
}

/** Escapes a string for inclusion in a regular expression. */
export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces `{{key}}` and `{{key:arg}}` placeholders. */
export function applyTemplate(template: string, variables: Record<string, string>): string {
	return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*(?::([^}]*))?\}\}/g, (_m, key: string) => {
		const value = variables[key];
		return value === undefined ? "" : value;
	});
}

/** Runs `fn` over a list with a concurrency cap, preserving order. */
export async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

/** Yields to the event loop so long exports never freeze the UI. */
export function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Deterministic PRNG (mulberry32) — used where reproducibility matters. */
export function createRng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
