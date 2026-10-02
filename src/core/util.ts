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

/**
 * 64-bit content hash over UTF-16 code units, written with 32-bit integer math
 * only (BigInt is 20–50× slower here, and this runs once per note per export,
 * over the whole note).
 *
 * Two independently seeded FNV-1a passes are concatenated. This is *not* a
 * cryptographic hash — it exists to detect changes and to key the analysis
 * cache, where the only requirements are speed, stability across platforms and
 * a negligible collision rate over a vault-sized key space.
 */
export function hash64(input: string, seed = 0): string {
	let a = (0x811c9dc5 ^ seed) >>> 0;
	let b = (0xcbf29ce4 ^ Math.imul(seed, 0x9e3779b1)) >>> 0;
	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i);
		a = Math.imul(a ^ (code & 0xff), 0x01000193) >>> 0;
		a = Math.imul(a ^ (code >> 8), 0x01000193) >>> 0;
		b = Math.imul(b ^ (code & 0xff), 0x85ebca6b) >>> 0;
		b = Math.imul(b ^ (code >> 8), 0xc2b2ae35) >>> 0;
	}
	// Both halves get a strong finalizer so that short, similar notes diverge.
	a ^= a >>> 16;
	a = Math.imul(a, 0x7feb352d) >>> 0;
	a ^= a >>> 15;
	b ^= b >>> 15;
	b = Math.imul(b, 0x2c1b3c6d) >>> 0;
	b ^= b >>> 12;
	// `>>> 0` matters: without it the final xorshifts can leave a negative
	// int32 and `toString(16)` would emit a minus sign into the hash.
	return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/** Content hash for a document body (stable across platforms). */
export function contentHash(input: string): string {
	return hash64(input, 0x9e3779b9) + hash64(input, 0x85ebca6b);
}

/**
 * Incremental FNV-1a over a string, seeded with a previous value.
 *
 * Handy to fingerprint a list without building the joined string first:
 * `files.reduce((acc, f) => hashString(fingerprint(f), acc), seed)`.
 */
export function hashString(input: string, seed = 0x811c9dc5): number {
	let h = seed >>> 0;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
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

/** Human size for hints and reports (binary units, one decimal at most). */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "kB", "MB", "GB", "TB"];
	const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
	const value = bytes / 1024 ** exponent;
	return `${exponent === 0 ? Math.round(value) : value.toFixed(value < 10 ? 1 : 0)} ${units[exponent]}`;
}

/** `1 note` / `3 notes` — small grammar helper for the generated reports. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
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
