/**
 * Frontmatter Property Schema Discovery ("Obsidian Properties / Bases" layer).
 *
 * Vaults increasingly rely on structured YAML properties (`status`, `priority`,
 * `type`, `owner`, `due`, `rating`) to organize notes. This module inspects the
 * parsed frontmatter across the corpus and infers the property schema: which
 * keys exist, how many notes use them, what types they hold, and their most
 * frequent values.
 */

import type { DocAnalysis, FrontmatterValue } from "../types";

export type InferredPropertyType = "string" | "number" | "boolean" | "date" | "list" | "object";

export interface PropertySchemaEntry {
	/** Frontmatter key name (e.g. `"status"`, `"type"`, `"priority"`). */
	key: string;
	/** Number of notes where this property is present and non-empty. */
	notes: number;
	/** Primary inferred type (`"mixed"` when multiple types appear across notes). */
	type: InferredPropertyType | "mixed";
	/** Inferred data types observed across notes. */
	types: InferredPropertyType[];
	/** Most frequent scalar/list values with their note counts. */
	topValues: { value: string; count: number }[];
}

/** Standard per-note metadata keys that are already tracked in `tags` or `title`. */
const BUILTIN_IGNORED_KEYS = new Set(["tags", "tag", "aliases", "alias", "title", "position", "cssclass", "cssclasses"]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?)?/;

function inferType(val: FrontmatterValue): InferredPropertyType | null {
	if (val === null || val === undefined || val === "") return null;
	if (typeof val === "boolean") return "boolean";
	if (typeof val === "number") return "number";
	if (typeof val === "string") {
		if (ISO_DATE_RE.test(val.trim())) return "date";
		return "string";
	}
	if (Array.isArray(val)) return val.length > 0 ? "list" : null;
	if (typeof val === "object") return "object";
	return null;
}

/**
 * Extracts the YAML frontmatter property schema across `docs`.
 */
export function extractPropertySchema(docs: DocAnalysis[], maxProperties = 25): PropertySchemaEntry[] {
	const byKey = new Map<
		string,
		{
			displayKey: string;
			notes: number;
			types: Set<InferredPropertyType>;
			values: Map<string, number>;
		}
	>();

	for (const doc of docs) {
		if (!doc.frontmatter.present) continue;
		for (const [rawKey, val] of Object.entries(doc.frontmatter.data)) {
			const lowerKey = rawKey.trim().toLowerCase();
			if (lowerKey === "" || BUILTIN_IGNORED_KEYS.has(lowerKey)) continue;
			const kind = inferType(val);
			if (!kind) continue;

			let entry = byKey.get(lowerKey);
			if (!entry) {
				entry = {
					displayKey: rawKey.trim(),
					notes: 0,
					types: new Set(),
					values: new Map(),
				};
				byKey.set(lowerKey, entry);
			}
			entry.notes++;
			entry.types.add(kind);

			if (kind === "string" || kind === "number" || kind === "boolean" || kind === "date") {
				const str = String(val).trim();
				if (str.length > 0 && str.length <= 60) {
					entry.values.set(str, (entry.values.get(str) ?? 0) + 1);
				}
			} else if (kind === "list" && Array.isArray(val)) {
				for (const item of val) {
					if (item === null || item === undefined || typeof item === "object") continue;
					const str = String(item).trim();
					if (str.length > 0 && str.length <= 60) {
						entry.values.set(str, (entry.values.get(str) ?? 0) + 1);
					}
				}
			}
		}
	}

	return Array.from(byKey.values())
		.map((entry) => {
			const types = Array.from(entry.types);
			return {
				key: entry.displayKey,
				notes: entry.notes,
				type: (types.length === 1 ? types[0] : "mixed") as InferredPropertyType | "mixed",
				types,
				topValues: Array.from(entry.values.entries())
					.map(([value, count]) => ({ value, count }))
					.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
					.slice(0, 6),
			};
		})
		.sort((a, b) => b.notes - a.notes || a.key.localeCompare(b.key))
		.slice(0, maxProperties);
}
