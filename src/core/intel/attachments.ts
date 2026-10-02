/**
 * Attachments the bundle cannot contain.
 *
 * The exporter is deliberately text-only: an embedded image, PDF or audio file
 * becomes a link in the bundle, not a payload. That is a real limitation, and
 * the one place a user notices it is at the destination ("why is the diagram
 * missing?"). So the export accounts for those references: which files the
 * bundled notes point at, how big they are, and how often they are referenced.
 *
 * The report lists them, the instructions file tells the destination model not
 * to invent their content, and the manifest counts them, so nothing about the
 * gap is silent.
 */

import type { DocAnalysis, SourceFile } from "../types";
import { TEXT_EXTENSIONS, normalizeVaultPath, stripExtension } from "../util";

export interface AttachmentRef {
	path: string;
	/** Extension without the dot. */
	kind: string;
	size: number;
	/** How many bundled notes embed it. */
	references: number;
}

export interface AttachmentInventory {
	/** Largest groups first. */
	refs: AttachmentRef[];
	totalBytes: number;
	/** Embeds that point at a file the vault does not have (or an external URL). */
	unresolved: string[];
	/** Human summary, e.g. "3 images, 1 PDF". */
	summary: string;
}

export interface AttachmentOptions {
	/** How many unresolved targets to name. */
	maxUnresolved?: number;
}

const GROUP_LABELS: Record<string, string> = {
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	svg: "image",
	avif: "image",
	bmp: "image",
	heic: "image",
	pdf: "PDF",
	mp3: "audio",
	wav: "audio",
	m4a: "audio",
	ogg: "audio",
	mp4: "video",
	mov: "video",
	webm: "video",
	mkv: "video",
};

function label(kind: string): string {
	return GROUP_LABELS[kind] ?? `${kind.toUpperCase()} file`;
}

/**
 * Resolves the embeds of the bundled notes against the vault's file listing.
 * `docs` should be the notes that actually made it into the bundle: a note the
 * budget dropped cannot ask for its images to be uploaded.
 */
export function collectAttachments(
	docs: DocAnalysis[],
	files: SourceFile[],
	options: AttachmentOptions = {},
): AttachmentInventory {
	const byPath = new Map<string, SourceFile>();
	const byName = new Map<string, SourceFile>();
	const byStem = new Map<string, SourceFile>();
	const byNameStem = new Map<string, SourceFile>();
	for (const file of files) {
		if (TEXT_EXTENSIONS.has(file.ext)) continue;
		const path = normalizeVaultPath(file.path);
		byPath.set(path.toLowerCase(), file);
		byName.set(file.name.toLowerCase(), file);
		const stem = stripExtension(path).toLowerCase();
		byStem.set(stem, file);
		byNameStem.set(stripExtension(path.split("/").pop() ?? path).toLowerCase(), file);
	}

	const counts = new Map<string, number>();
	const sizes = new Map<string, SourceFile>();
	const unresolved: string[] = [];
	const maxUnresolved = options.maxUnresolved ?? 20;

	for (const doc of docs) {
		const seen = new Set<string>();
		for (const link of doc.links) {
			if (!link.isEmbed || link.isExternal) continue;
			const target = link.target.trim();
			if (target === "") continue;
			const normalised = normalizeVaultPath(target.replace(/^\.\//, "")).toLowerCase();
			const name = (normalised.split("/").pop() ?? normalised).toLowerCase();
			const file =
				byPath.get(normalised) ??
				byName.get(name) ??
				byStem.get(normalised) ??
				byNameStem.get(stripExtension(name).toLowerCase());
			if (!file) {
				if (unresolved.length < maxUnresolved && !unresolved.includes(target)) unresolved.push(target);
				continue;
			}
			if (seen.has(file.path)) continue;
			seen.add(file.path);
			counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
			sizes.set(file.path, file);
		}
	}

	const refs: AttachmentRef[] = Array.from(counts.entries())
		.map(([path, references]) => ({
			path,
			references,
			kind: sizes.get(path)?.ext ?? "",
			size: sizes.get(path)?.size ?? 0,
		}))
		.sort((a, b) => b.references - a.references || b.size - a.size || a.path.localeCompare(b.path));

	const groups = new Map<string, number>();
	for (const ref of refs) {
		const key = label(ref.kind);
		groups.set(key, (groups.get(key) ?? 0) + 1);
	}
	const summary = Array.from(groups.entries())
		.map(([name, count]) => `${count} ${name}${count > 1 && !name.endsWith("file") ? "s" : ""}`)
		.join(", ");

	return {
		refs,
		totalBytes: refs.reduce((acc, ref) => acc + ref.size, 0),
		unresolved,
		summary,
	};
}
