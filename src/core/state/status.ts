/**
 * Per-profile status: what each profile last exported, and what has changed
 * in the vault since.
 *
 * The exporter keeps two records — the sidecar manifest next to each bundle
 * (what was written) and the plugin state (size and mtime of every note at the
 * time it was exported). Together they answer the question a user actually
 * has when they open the plugin: *is my bundle still current, and what would
 * change if I exported now?* Nothing is read here: the comparison is against
 * the file listing, so a status screen for ten profiles costs one scan.
 */

import type { ExportProfile, SourceFile } from "../types";
import type { ExportState } from "./manifest";

/** The subset of a sidecar manifest (`ExportManifest`) a status screen needs. */
export interface StatusManifest {
	generatedAt?: string;
	stats?: { kept?: number; words?: number; tokens?: number };
	parts?: { index: number; path: string }[];
}

export interface ProfileStatus {
	profileId: string;
	profileName: string;
	/** Notes in scope right now, by folder/extension rules (no analysis). */
	notes: number;
	/** Bytes of those notes, as listed. */
	bytes: number;
	/** True when a previous export left enough state to diff against. */
	tracked: boolean;
	/** Notes written by the last export (0 when there was none). */
	exported: number;
	/** Epoch ms of the last export, 0 when this profile never exported. */
	lastExportAt: number;
	/** Files that appeared since that export. */
	added: number;
	/** Files whose size or mtime moved since that export. */
	changed: number;
	/** Files that were exported but are gone now. */
	removed: number;
	/** Files that are exactly as they were exported. */
	unchanged: number;
	/** Totals from the last export, when a manifest was found. */
	words: number;
	tokens: number;
	parts: number;
}

export function computeProfileStatus(
	profile: ExportProfile,
	manifest: StatusManifest | null,
	state: ExportState,
	files: SourceFile[],
): ProfileStatus {
	const recorded = state.profiles[profile.id] ?? {};
	const tracked = Object.keys(recorded).length > 0;
	let added = 0;
	let changed = 0;
	let unchanged = 0;
	const seen = new Set<string>();
	for (const file of files) {
		seen.add(file.path);
		const previous = recorded[file.path];
		if (!previous) {
			added++;
			continue;
		}
		if (previous.size === file.size && previous.mtime === file.mtime) unchanged++;
		else changed++;
	}
	let removed = 0;
	let lastExportAt = 0;
	let exported = 0;
	for (const [path, info] of Object.entries(recorded)) {
		if (!seen.has(path)) removed++;
		if (info.lastExportedAt && info.lastExportedAt > 0) {
			exported++;
			lastExportAt = Math.max(lastExportAt, info.lastExportedAt);
		}
	}
	const manifestAt = manifest?.generatedAt ? Date.parse(manifest.generatedAt) : 0;
	if (Number.isFinite(manifestAt)) lastExportAt = Math.max(lastExportAt, manifestAt);
	const stats = manifest?.stats;
	return {
		profileId: profile.id,
		profileName: profile.name,
		notes: files.length,
		bytes: files.reduce((acc, file) => acc + file.size, 0),
		tracked: tracked || manifest !== null,
		exported: stats?.kept ?? exported,
		lastExportAt,
		added,
		changed,
		removed,
		unchanged,
		words: stats?.words ?? 0,
		tokens: stats?.tokens ?? 0,
		parts: manifest?.parts?.length ?? 0,
	};
}

/** True when the recorded state says the export is behind the vault. */
export function isStale(status: ProfileStatus): boolean {
	if (status.lastExportAt === 0) return false;
	return status.added > 0 || status.changed > 0 || status.removed > 0;
}

/** Short human summary of the difference between the vault and the bundle. */
export function describeChanges(status: ProfileStatus): string {
	if (status.lastExportAt === 0) return "never exported";
	if (!isStale(status)) return "up to date";
	const parts = [
		status.added > 0 ? `${status.added} new` : "",
		status.changed > 0 ? `${status.changed} changed` : "",
		status.removed > 0 ? `${status.removed} gone` : "",
	].filter((part) => part !== "");
	return parts.join(", ");
}
