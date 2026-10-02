/**
 * The export report: a human-readable account of what the export did.
 *
 * A merged bundle is a lossy artefact by design — notes are dropped, lines are
 * removed as boilerplate, images become links, long notes are summarized. The
 * exporter knows every one of those decisions; the report writes them down so
 * the result can be audited instead of trusted. It is the counterpart of the
 * instructions file: that one tells the destination model what it is reading,
 * this one tells the *author* what was taken away.
 */

import type { BundleLimits, ExportDelta, PlanStats } from "../types";
import type { LimitViolation } from "./limits";
import type { TransformStats } from "../markdown/transforms";
import { formatBytes, formatCount, plural } from "../util";

export interface ReportEntry {
	path: string;
	reason: string;
}

export interface ReportDuplicate {
	representative: string;
	duplicates: string[];
	similarity: number;
}

export interface ReportBoilerplate {
	text: string;
	docs: number;
}

export interface ReportPart {
	index: number;
	path: string;
	words: number;
	tokens: number;
	sources: number;
	/** Size of the written file, in bytes. */
	bytes: number;
}

export interface ReportGraph {
	/** Edges between bundled notes. */
	links: number;
	/** Note paths with no link in or out of the bundle. */
	orphans: string[];
	/** Most-referenced notes, with their inbound link count. */
	hubs: { path: string; inbound: number }[];
	/** Outgoing targets that do not resolve inside the bundle. */
	broken: number;
}

export interface ExportReportInput {
	profileName: string;
	generatedAt: Date;
	durationMs: number;
	stats: PlanStats;
	parts: ReportPart[];
	volumes: number;
	limits: BundleLimits;
	violations: LimitViolation[];
	dropped: ReportEntry[];
	duplicates: ReportDuplicate[];
	boilerplate: ReportBoilerplate[];
	transforms: TransformStats[];
	summarized: number;
	truncated: number;
	warnings: string[];
	delta?: ExportDelta;
	graph?: ReportGraph;
}

/** How many individual lines of a list the report spells out. */
const MAX_LISTED = 8;

function bullet(path: string, suffix = ""): string {
	return `- \`${path}\`${suffix}`;
}

function capped<T>(items: T[], render: (item: T) => string): string[] {
	const lines = items.slice(0, MAX_LISTED).map(render);
	if (items.length > MAX_LISTED) lines.push(`- …and ${formatCount(items.length - MAX_LISTED)} more`);
	return lines;
}

export function buildExportReport(input: ExportReportInput): string {
	const { stats, limits } = input;
	const lines: string[] = [];
	const title = limits.label !== "" ? limits.label : input.profileName;
	lines.push(`# Export report — ${title}`, "");
	const duration = input.durationMs > 0 ? ` · ${formatCount(input.durationMs)} ms` : "";
	lines.push(
		`Profile **${input.profileName}** · generated ${input.generatedAt.toISOString().slice(0, 16).replace("T", " ")}${
			duration
		}`,
		"",
	);

	// -- what was exported -----------------------------------------------------
	const keptRatio = stats.discovered > 0 ? Math.round((stats.kept / stats.discovered) * 100) : 100;
	lines.push("## What was exported", "");
	lines.push(
		`- ${formatCount(stats.kept)} of ${formatCount(stats.discovered)} note(s) (${keptRatio} %) · ${formatCount(
			stats.words,
		)} words · ~${formatCount(stats.tokens)} tokens`,
	);
	lines.push(
		input.volumes > 1
			? `- ${plural(input.parts.length, "part")} grouped into ${plural(input.volumes, "volume")}`
			: `- ${plural(input.parts.length, "part")}`,
	);
	for (const part of input.parts.slice(0, MAX_LISTED)) {
		lines.push(bullet(part.path, ` — ${plural(part.sources, "source")}, ~${formatCount(part.tokens)} tokens`));
	}
	if (input.parts.length > MAX_LISTED) {
		lines.push(`- …and ${formatCount(input.parts.length - MAX_LISTED)} more part(s)`);
	}
	if (input.delta?.known) {
		lines.push(
			"",
			`- Since the previous export: ${formatCount(input.delta.added.length)} new, ${formatCount(
				input.delta.changed.length,
			)} changed, ${formatCount(input.delta.removed.length)} gone, ${formatCount(input.delta.unchanged)} unchanged`,
		);
	}
	lines.push("");

	// -- what was left out -----------------------------------------------------
	const leftOut: ReportEntry[] = [...input.dropped];
	if (stats.droppedAsStub > 0) leftOut.push({ path: "", reason: `${plural(stats.droppedAsStub, "near-empty note")} (stubs)` });
	if (stats.droppedAsUnreadable > 0) {
		leftOut.push({ path: "", reason: `${plural(stats.droppedAsUnreadable, "unreadable note")} (could not be read)` });
	}
	if (stats.droppedByFilter > 0) {
		leftOut.push({ path: "", reason: `${plural(stats.droppedByFilter, "note")} excluded by the profile's filters or note cap` });
	}
	lines.push("## What was left out", "");
	if (leftOut.length === 0 && input.duplicates.length === 0) {
		lines.push("Nothing — every note that matched the filters is in the bundle.", "");
	} else {
		for (const entry of input.duplicates.slice(0, MAX_LISTED)) {
			const similarity = `${Math.round(entry.similarity * 100)} %`;
			const copies = entry.duplicates.map((path) => `\`${path}\``).join(", ");
			lines.push(
				entry.duplicates.length === 1
					? `- Duplicate of \`${entry.representative}\` (similarity ${similarity}): ${copies}`
					: `- Duplicates of \`${entry.representative}\` (similarity ${similarity}): ${copies}`,
			);
		}
		if (input.duplicates.length > MAX_LISTED) {
			lines.push(`- …and ${formatCount(input.duplicates.length - MAX_LISTED)} more duplicate group(s)`);
		}
		lines.push(...capped(leftOut, (entry) => bullet(entry.path, entry.reason !== "" ? ` — ${entry.reason}` : "")));
		if (stats.kept === 0) {
			lines.push("", "> Nothing was kept: check the profile's folder, tag and date filters.");
		}
		lines.push("");
	}

	// -- how the notes hang together -------------------------------------------
	if (input.graph && input.graph.links > 0) {
		const graph = input.graph;
		lines.push("## How the notes hang together", "");
		lines.push(
			`- ${plural(graph.links, "link")} between bundled notes · ${plural(graph.orphans.length, "orphan note")} · ${plural(
				graph.broken,
				"link",
			)} leading outside the bundle`,
		);
		const topHubs = graph.hubs.filter((hub) => hub.inbound > 0).slice(0, 5);
		if (topHubs.length > 0) {
			lines.push(`- Most referenced: ${topHubs.map((hub) => `\`${hub.path}\` (${hub.inbound})`).join(", ")}`);
		}
		if (graph.orphans.length > 0) {
			lines.push(...capped(graph.orphans, (path) => bullet(path, " — nothing links to or from this note")));
		}
		lines.push("");
	}

	// -- what was cleaned up ---------------------------------------------------
	const transforms = input.transforms.reduce<TransformStats>(
		(acc, entry) => ({
			transclusions: acc.transclusions + entry.transclusions,
			transclusionChars: acc.transclusionChars + entry.transclusionChars,
			imagesInlined: acc.imagesInlined + entry.imagesInlined,
			imagesReferenced: acc.imagesReferenced + entry.imagesReferenced,
			imagesDropped: acc.imagesDropped + entry.imagesDropped,
			boilerplateLines: acc.boilerplateLines + entry.boilerplateLines,
			codeLinesElided: acc.codeLinesElided + entry.codeLinesElided,
			tasksRemoved: acc.tasksRemoved + entry.tasksRemoved,
		}),
		{
			transclusions: 0,
			transclusionChars: 0,
			imagesInlined: 0,
			imagesReferenced: 0,
			imagesDropped: 0,
			boilerplateLines: 0,
			codeLinesElided: 0,
			tasksRemoved: 0,
		},
	);
	const cleaned: string[] = [];
	if (stats.boilerplateLines > 0) cleaned.push(`${plural(stats.boilerplateLines, "repeated line")} removed as boilerplate`);
	if (transforms.transclusions > 0) cleaned.push(`${plural(transforms.transclusions, "transclusion")} inlined`);
	if (transforms.imagesInlined > 0) cleaned.push(`${plural(transforms.imagesInlined, "image")} inlined as data`);
	if (transforms.imagesReferenced > 0) {
		cleaned.push(`${plural(transforms.imagesReferenced, "image")} left as a reference (upload them separately if needed)`);
	}
	if (transforms.imagesDropped > 0) cleaned.push(`${plural(transforms.imagesDropped, "image")} dropped`);
	if (transforms.codeLinesElided > 0) cleaned.push(`${plural(transforms.codeLinesElided, "code line")} elided`);
	if (transforms.tasksRemoved > 0) cleaned.push(`${plural(transforms.tasksRemoved, "task line")} removed`);
	if (stats.summarized > 0) cleaned.push(`${plural(stats.summarized, "note")} summarized`);
	if (input.truncated > 0) cleaned.push(`${plural(input.truncated, "note")} truncated at a sentence boundary`);
	lines.push("## What was cleaned up", "");
	if (cleaned.length === 0) {
		lines.push("Nothing: the notes were exported as written.", "");
	} else {
		for (const item of cleaned) lines.push(`- ${item}`);
		if (input.boilerplate.length > 0) {
			lines.push("", "The most frequent repeated lines:", "");
			let masked = false;
			for (const sample of input.boilerplate.slice(0, 5)) {
				const text = sample.text.length > 90 ? `${sample.text.slice(0, 90)}…` : sample.text;
				const isPattern = /\d/.test(sample.text) === false && sample.text.includes("#");
				if (isPattern) masked = true;
				lines.push(`- ${isPattern ? "pattern " : ""}“${text}” — in ${plural(sample.docs, "note")}`);
			}
			if (masked) lines.push("", "*A “#” in a pattern stands for a number that differs between notes.*");
		}
		lines.push("");
	}

	// -- destination checks ----------------------------------------------------
	lines.push("## Destination checks", "");
	const checks: string[] = [];
	if (limits.maxParts > 0 && input.volumes <= 1) checks.push(`${plural(input.parts.length, "part")} of the ${limits.maxParts} allowed`);
	if (limits.maxParts > 0 && input.volumes > 1) {
		checks.push(`${plural(input.parts.length, "part")} split into ${plural(input.volumes, "volume")} of ${limits.maxParts} part(s)`);
	}
	const largest = input.parts.reduce((max, part) => Math.max(max, part.tokens), 0);
	if (limits.maxTokensPerPart > 0) checks.push(`largest part ~${formatCount(largest)} of ${formatCount(limits.maxTokensPerPart)} tokens`);
	const largestWords = input.parts.reduce((max, part) => Math.max(max, part.words), 0);
	if (limits.maxWordsPerPart > 0) checks.push(`largest part ${formatCount(largestWords)} of ${formatCount(limits.maxWordsPerPart)} words`);
	if (limits.maxTotalWords > 0) checks.push(`${formatCount(stats.words)} of ${formatCount(limits.maxTotalWords)} words in total`);
	if (limits.maxTotalTokens > 0) checks.push(`~${formatCount(stats.tokens)} of ${formatCount(limits.maxTotalTokens)} tokens in total`);
	if (limits.maxMegabytesPerPart > 0) {
		const largestBytes = input.parts.reduce((max, part) => Math.max(max, part.bytes), 0);
		checks.push(`largest part ${formatBytes(largestBytes)} of ${formatBytes(limits.maxMegabytesPerPart * 1024 * 1024)}`);
	}
	if (checks.length === 0) {
		lines.push("This profile sets no destination limits.", "");
	} else {
		for (const check of checks) lines.push(`- ✅ ${check}`);
		lines.push("");
	}
	if (input.violations.length > 0) {
		for (const violation of input.violations) {
			const icon = violation.severity === "error" ? "❌" : violation.severity === "warning" ? "⚠️" : "ℹ️";
			lines.push(`- ${icon} ${violation.message}`);
		}
		lines.push("");
	}

	// -- run notes -------------------------------------------------------------
	const notable = input.warnings.filter((warning) => !warning.startsWith("Dropped ") && warning.trim() !== "");
	if (notable.length > 0) {
		lines.push("## Run notes", "");
		for (const warning of notable.slice(0, 12)) lines.push(`- ${warning}`);
		if (notable.length > 12) lines.push(`- …and ${formatCount(notable.length - 12)} more`);
		lines.push("");
	}

	lines.push(
		`*${formatBytes(input.parts.reduce((acc, part) => acc + part.bytes, 0))} written by Condensated Vault Exporter.*`,
	);
	return lines.join("\n");
}
