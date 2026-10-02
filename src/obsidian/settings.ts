/**
 * Plugin settings: the user's profiles plus the handful of global switches.
 *
 * Profiles are the whole configuration of an export, so the settings file is
 * essentially "a list of profiles and which one is active". Built-in profiles
 * are re-created from code on load (so a plugin update can improve them),
 * while user copies are stored verbatim.
 */

import type { ExportProfile } from "../core/types";
import {
	BUILTIN_PROFILES,
	cloneProfile,
	createBuiltinProfile,
	createDefaultProfiles,
	normalizeProfile,
} from "../core/profiles";
import { createState, pruneState, type ExportState } from "../core/state/manifest";

export interface PluginSettings {
	version: number;
	/** All profiles known to the plugin (built-ins included). */
	profiles: ExportProfile[];
	/** Profile used by the ribbon icon and the "Quick export" command. */
	activeProfileId: string;
	/** Show a progress line in the status bar. */
	statusBar: boolean;
	/** Notification style: quiet only reports problems. */
	notifications: "verbose" | "normal" | "quiet";
	/** Open the produced file(s) after a successful export. */
	openAfterExport: boolean;
	/** Remember which notes were exported, enabling incremental exports. */
	rememberHistory: boolean;
	/** Export history + per-note fingerprints (for delta runs). */
	state: ExportState;
	/** Ask before overwriting an existing bundle. */
	confirmOverwrite: boolean;
	/** Maximum number of notes analysed in parallel. */
	concurrency: number;
	/** Keep one bundle up to date automatically as the vault changes. */
	autoRefresh: AutoRefreshSettings;
}

export interface AutoRefreshSettings {
	enabled: boolean;
	/** Profile the automatic runs use. Empty means "the active profile". */
	profileId: string;
	/** Quiet period after the last change before a run starts. */
	debounceSeconds: number;
	/** Skip the run entirely when no note in scope changed. */
	skipUnchanged: boolean;
}

export const SETTINGS_VERSION = 1;

export function defaultSettings(): PluginSettings {
	const profiles = createDefaultProfiles();
	return {
		version: SETTINGS_VERSION,
		profiles,
		activeProfileId: profiles[0]?.id ?? "notebooklm",
		statusBar: true,
		notifications: "normal",
		openAfterExport: false,
		rememberHistory: true,
		state: createState(),
		confirmOverwrite: true,
		concurrency: 6,
		autoRefresh: {
			enabled: false,
			profileId: "",
			debounceSeconds: 8,
			skipUnchanged: true,
		},
	};
}

/**
 * Merges a stored settings object with the defaults. Built-in profiles are
 * rebuilt from the current code (keeping the user's edits merged on top so a
 * tweak in the settings tab survives a plugin update).
 */
export function normalizeSettings(raw: unknown): PluginSettings {
	const defaults = defaultSettings();
	if (raw === null || typeof raw !== "object") return defaults;
	const stored = raw as Partial<PluginSettings> & { profiles?: unknown };
	const profiles: ExportProfile[] = [];
	const names = new Set<string>();

	if (Array.isArray(stored.profiles)) {
		for (const entry of stored.profiles) {
			if (entry === null || typeof entry !== "object") continue;
			const profile = normalizeProfile(entry as Partial<ExportProfile>);
			if (profile.id === "" || names.has(profile.id)) continue;
			const builtin = BUILTIN_PROFILES.find((recipe) => recipe.id === profile.id);
			if (builtin) {
				// Keep the shipped definition, but honour the user's overrides.
				const base = createBuiltinProfile(profile.id);
				if (base) profiles.push({ ...base, ...profile, name: profile.name || base.name });
				else profiles.push(profile);
			} else {
				profiles.push(profile);
			}
			names.add(profile.id);
		}
	}
	for (const recipe of BUILTIN_PROFILES) {
		if (names.has(recipe.id)) continue;
		const profile = createBuiltinProfile(recipe.id);
		if (profile) {
			profiles.push(profile);
			names.add(recipe.id);
		}
	}
	if (profiles.length === 0) profiles.push(...defaults.profiles);

	const activeProfileId =
		typeof stored.activeProfileId === "string" && names.has(stored.activeProfileId)
			? stored.activeProfileId
			: profiles[0].id;

	const state =
		stored.state && typeof stored.state === "object" && (stored.state as ExportState).version === 1
			? (stored.state as ExportState)
			: createState();

	return {
		version: SETTINGS_VERSION,
		profiles,
		activeProfileId,
		statusBar: stored.statusBar ?? defaults.statusBar,
		notifications: stored.notifications ?? defaults.notifications,
		openAfterExport: stored.openAfterExport ?? defaults.openAfterExport,
		rememberHistory: stored.rememberHistory ?? defaults.rememberHistory,
		state,
		confirmOverwrite: stored.confirmOverwrite ?? defaults.confirmOverwrite,
		concurrency: clampNumber(stored.concurrency, 1, 16, defaults.concurrency),
		autoRefresh: {
			enabled: stored.autoRefresh?.enabled ?? defaults.autoRefresh.enabled,
			profileId: typeof stored.autoRefresh?.profileId === "string" ? stored.autoRefresh.profileId : "",
			debounceSeconds: clampNumber(stored.autoRefresh?.debounceSeconds, 2, 600, defaults.autoRefresh.debounceSeconds),
			skipUnchanged: stored.autoRefresh?.skipUnchanged ?? defaults.autoRefresh.skipUnchanged,
		},
	};
}

/** Shrinks the persisted state so data.json never grows without bound. */
export function compactSettings(settings: PluginSettings, existingPaths: Set<string>): PluginSettings {
	return {
		...settings,
		state: pruneState(settings.state, existingPaths),
	};
}

export function duplicateProfile(profile: ExportProfile, existing: ExportProfile[]): ExportProfile {
	const copy = cloneProfile(profile);
	copy.builtin = false;
	copy.name = uniqueName(`${profile.name} copy`, existing.map((p) => p.name));
	copy.id = uniqueId(slugId(copy.name), existing.map((p) => p.id));
	return copy;
}

function slugId(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "profile"
	);
}

function uniqueId(base: string, taken: string[]): string {
	if (!taken.includes(base)) return base;
	for (let i = 2; i < 1000; i++) {
		const candidate = `${base}-${i}`;
		if (!taken.includes(candidate)) return candidate;
	}
	return `${base}-${Date.now()}`;
}

function uniqueName(base: string, taken: string[]): string {
	if (!taken.includes(base)) return base;
	for (let i = 2; i < 1000; i++) {
		const candidate = `${base} ${i}`;
		if (!taken.includes(candidate)) return candidate;
	}
	return `${base} ${Date.now()}`;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.round(value)));
}
