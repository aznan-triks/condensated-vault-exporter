/**
 * Persisted export state: which note changed since the last export, which
 * notes were already shipped in an earlier part, and the history of runs.
 *
 * The state is intentionally tiny (hash + counters per note) so it can be
 * kept in the plugin's `data.json` even for large vaults.
 */

import type { CachedDocInfo, DocAnalysis, ExportHistoryEntry } from "../types";

export interface ExportState {
	version: 1;
	/** profileId -> path -> info */
	profiles: Record<string, Record<string, CachedDocInfo>>;
	history: ExportHistoryEntry[];
}

export function createState(): ExportState {
	return { version: 1, profiles: {}, history: [] };
}

export interface DeltaResult {
	/** Paths whose content changed or that are new. */
	changed: string[];
	/** Paths already exported with the same content, and not exported before. */
	unchanged: string[];
	/** Paths present in the previous export but not in the current selection. */
	removed: string[];
}

/**
 * Computes what is new since the last export of a profile.
 * A note counts as "unchanged" only when its hash and size match the stored
 * values *and* it was actually part of a previous export.
 */
export function computeDelta(state: ExportState, profileId: string, docs: DocAnalysis[]): DeltaResult {
	const previous = state.profiles[profileId] ?? {};
	const changed: string[] = [];
	const unchanged: string[] = [];
	const currentPaths = new Set(docs.map((d) => d.file.path));

	for (const doc of docs) {
		const info = previous[doc.file.path];
		if (!info) {
			changed.push(doc.file.path);
			continue;
		}
		const same = info.hash === doc.hash && info.size === doc.file.size;
		if (same && info.lastExportedAt) unchanged.push(doc.file.path);
		else changed.push(doc.file.path);
	}

	const removed: string[] = [];
	for (const [path, info] of Object.entries(previous)) {
		if (info.lastExportedAt && !currentPaths.has(path)) removed.push(path);
	}
	return { changed, unchanged, removed };
}

export interface RecordExportOptions {
	profileId: string;
	docs: DocAnalysis[];
	/** Paths that ended up in the bundle (after budget cuts). */
	included: string[];
	generatedAt: Date;
	outputs: string[];
	words: number;
	tokens: number;
	parts: number;
	durationMs: number;
	/** Maximum number of history entries to keep. */
	historyLimit?: number;
}

export function recordExport(state: ExportState, options: RecordExportOptions): ExportState {
	const profile = state.profiles[options.profileId] ?? {};
	const timestamp = options.generatedAt.getTime();
	for (const doc of options.docs) {
		const existing = profile[doc.file.path] ?? {
			hash: doc.hash,
			mtime: doc.file.mtime,
			size: doc.file.size,
			words: doc.stats.words,
			tokens: doc.stats.tokens,
		};
		profile[doc.file.path] = {
			hash: doc.hash,
			mtime: doc.file.mtime,
			size: doc.file.size,
			words: doc.stats.words,
			tokens: doc.stats.tokens,
			lastExportedAt: options.included.includes(doc.file.path) ? timestamp : existing.lastExportedAt ?? 0,
		};
	}
	state.profiles[options.profileId] = profile;
	state.history.unshift({
		profileId: options.profileId,
		generatedAt: options.generatedAt.toISOString(),
		outputs: options.outputs,
		notes: options.included.length,
		words: options.words,
		tokens: options.tokens,
		parts: options.parts,
		durationMs: options.durationMs,
	});
	const limit = options.historyLimit ?? 50;
	state.history = state.history.slice(0, limit);
	return state;
}

/** Drops entries for files that no longer exist, to keep the state bounded. */
export function pruneState(state: ExportState, existingPaths: Set<string>, maxAgeDays = 180): ExportState {
	const cutoff = Date.now() - maxAgeDays * 86_400_000;
	for (const [profileId, entries] of Object.entries(state.profiles)) {
		for (const [path, info] of Object.entries(entries)) {
			const stale = (info.mtime || 0) < cutoff && (info.lastExportedAt ?? 0) < cutoff;
			if (!existingPaths.has(path) && stale) delete entries[path];
		}
		state.profiles[profileId] = entries;
	}
	return state;
}

/** Total size of the stored state, for the UI (bytes of JSON, approximate). */
export function stateSize(state: ExportState): number {
	let notes = 0;
	for (const entries of Object.values(state.profiles)) notes += Object.keys(entries).length;
	return notes * 120 + state.history.length * 200;
}

/* -------------------------------------------------------------------------- */
/*  Manifest (written next to the bundle)                                      */
/* -------------------------------------------------------------------------- */

export interface ManifestFile {
	version: 1;
	plugin: { id: string; version: string };
	generatedAt: string;
	profile: { id: string; name: string };
	roots: string[];
	totals: { notes: number; words: number; tokens: number; chars: number; parts: number; durationMs: number };
	/** path -> content hash at export time. */
	hashes: Record<string, string>;
	parts: { index: number; file: string; notes: string[]; words: number; tokens: number }[];
	options: {
		format: string;
		chunking: string;
		dedupe: boolean;
		boilerplate: boolean;
		summarize: boolean;
		summaryRatio?: number;
		limits: string;
	};
	/** Human-readable notes about what happened (warnings, drops, …). */
	notes_log: string[];
}

/** Compares two manifests and lists the notes that changed between them. */
export interface ManifestDelta {
	added: string[];
	changed: string[];
	removed: string[];
	unchanged: number;
}

export function diffManifests(previous: ManifestFile | null, current: ManifestFile): ManifestDelta {
	const delta: ManifestDelta = { added: [], changed: [], removed: [], unchanged: 0 };
	if (!previous) {
		delta.added = Object.keys(current.hashes).sort();
		return delta;
	}
	for (const [path, hash] of Object.entries(current.hashes)) {
		const before = previous.hashes[path];
		if (before === undefined) delta.added.push(path);
		else if (before !== hash) delta.changed.push(path);
		else delta.unchanged++;
	}
	const currentPaths = new Set(Object.keys(current.hashes));
	for (const path of Object.keys(previous.hashes)) {
		if (!currentPaths.has(path)) delta.removed.push(path);
	}
	delta.added.sort();
	delta.changed.sort();
	delta.removed.sort();
	return delta;
}

/** Merges a previous manifest into a new one (union of hashes, newest wins). */
export function mergeManifests(previous: ManifestFile | null, current: ManifestFile): ManifestFile {
	if (!previous) return current;
	const hashes: Record<string, string> = { ...previous.hashes };
	for (const [path, hash] of Object.entries(current.hashes)) hashes[path] = hash;
	return {
		...current,
		hashes,
		notes_log: [...current.notes_log, `Merged with the previous manifest (${Object.keys(previous.hashes).length} known notes).`],
	};
}
