/**
 * Contradiction & Temporal/Metric Drift Detector.
 *
 * Personal and team vaults evolve over months: an early design note states
 * `chunk overlap: 80 tokens` or `Recall@10 = 0.81`, while a later benchmark
 * note updates that to `chunk overlap: 120 tokens` or `Recall@10 = 0.83`.
 * When both notes are packed into an LLM context window without warning, the
 * model either blends the stale figure with the current one or hallucinates a
 * reconciliation.
 *
 * This module scans the selected corpus for:
 * 1. Numeric & metric drift (`Recall@10: 0.81` vs `0.83`, `timeout = 30s` vs `60s`)
 * 2. Status / boolean reversals (`feature X is enabled` vs `feature X is disabled`)
 * 3. Stale dependency links (an active note citing a note marked `status: deprecated/archived`)
 *
 * All detection is deterministic, single-pass per note, and orders each pair
 * chronologically (`older` -> `newer`) using note modification times.
 */

import type { DocAnalysis } from "../types";
import type { LinkGraph } from "./graph";
import { STOP_WORDS } from "./terms";

export interface ClaimOccurrence {
	path: string;
	title: string;
	value: string;
	excerpt: string;
	line: number;
	mtime: number;
}

export interface DriftFinding {
	kind: "metric-drift" | "status-conflict" | "stale-reference";
	/** Normalized subject or metric name (e.g. `"recall@10"`, `"chunk overlap"`). */
	subject: string;
	older: ClaimOccurrence;
	newer: ClaimOccurrence;
}

const GENERIC_METRIC_SUBJECTS = new Set([
	"step",
	"part",
	"page",
	"line",
	"item",
	"section",
	"chapter",
	"figure",
	"table",
	"note",
	"example",
	"option",
	"phase",
	"stage",
	"day",
	"week",
	"month",
	"year",
	"point",
	"rule",
	"level",
	"type",
	"case",
	"group",
	"number",
	"count",
	"total",
	"index",
	"id",
]);

const DOMAIN_METRIC_NOUNS = new Set([
	"overlap",
	"budget",
	"limit",
	"threshold",
	"latency",
	"timeout",
	"window",
	"depth",
	"score",
	"version",
	"price",
	"cost",
	"target",
	"quota",
	"ttl",
	"capacity",
	"rate",
	"size",
	"batch",
	"chunk",
	"tokens",
	"temperature",
	"recall",
	"precision",
	"accuracy",
	"f1",
	"mrr",
	"ndcg",
	"port",
	"workers",
	"concurrency",
	"retries",
	"interval",
	"debounce",
	"cutoff",
	"weight",
	"damping",
	"dimension",
	"dimensions",
	"epochs",
	"dropout",
]);

const UNITS_PATTERN =
	"(?:%|ms|s|sec|seconds|min|minutes|h|hrs|hours|d|days|k|m|gb|mb|kb|tb|tokens|words|passages|chars|characters|px|rem|rps|qps|hz|fps|usd|eur)";

const METRIC_Assignment_RE = new RegExp(
	`(?:^|[\\s|(*_-])([A-Za-z][A-Za-z0-9@_/-]{1,24}(?:\\s+[A-Za-z][A-Za-z0-9@_/-]{1,20})?)\\s*(?:=|:|\\bis\\b|\\bat\\b)\\s*(\\d+(?:\\.\\d+)?(?:\\s*${UNITS_PATTERN})?)(?=$|[\\s.,;)|*_-])`,
	"gi",
);

const STATUS_RE =
	/\b([A-Za-z][A-Za-z0-9_-]{2,24}(?:\s+[A-Za-z][A-Za-z0-9_-]{2,20})?)\s+is\s+(?:currently\s+|now\s+)?(enabled|disabled|deprecated|active|required|optional|supported|unsupported)\b/gi;

const OPPOSITE_STATUS: Record<string, string> = {
	enabled: "disabled",
	disabled: "enabled",
	deprecated: "active",
	active: "deprecated",
	required: "optional",
	optional: "required",
	supported: "unsupported",
	unsupported: "supported",
};

function normalizeSubject(raw: string): string {
	const words = raw
		.toLowerCase()
		.replace(/^[\s*_-]+|[\s*_-]+$/g, "")
		.split(/\s+/)
		.filter((w) => w.length > 1 && !STOP_WORDS.has(w));
	if (words.length === 0) return "";
	return words.slice(-2).join(" ");
}

function isMeaningfulMetric(subject: string, rawValue: string, hasExplicitColonOrEquals: boolean): boolean {
	if (subject.length < 2) return false;
	const parts = subject.split(" ");
	const last = parts[parts.length - 1];
	if (GENERIC_METRIC_SUBJECTS.has(last) || GENERIC_METRIC_SUBJECTS.has(subject)) return false;
	if (/^\d+$/.test(subject)) return false;

	// Technical identifiers like `recall@10`, `mrr@10`, `ndcg@10`, `k1`, `p95`, `top_k`:
	if (/[@_]/.test(subject) || /^[a-z]+\d+$/i.test(subject)) return true;

	// Values with explicit units (`120 tokens`, `50ms`, `0.85%`):
	if (new RegExp(`^\\d+(?:\\.\\d+)?\\s*${UNITS_PATTERN}$`, "i").test(rawValue.trim())) return true;

	// Known domain nouns (`chunk overlap`, `threshold`, `latency`, `batch size`):
	if (parts.some((p) => DOMAIN_METRIC_NOUNS.has(p))) return true;

	// Explicit `key = value` with a decimal number:
	if (hasExplicitColonOrEquals && /\d+\.\d+/.test(rawValue)) return true;

	return false;
}

function normalizeValue(raw: string): string {
	return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

function areDocsRelated(a: DocAnalysis, b: DocAnalysis, graph?: LinkGraph): boolean {
	if (a.file.folder !== "" && a.file.folder === b.file.folder) return true;
	if (graph) {
		const nodeA = graph.nodes.get(a.file.path);
		if (nodeA && (nodeA.links.includes(b.file.path) || nodeA.backlinks.includes(b.file.path))) {
			return true;
		}
	}
	const tagsA = new Set(a.tags);
	for (const t of b.tags) if (tagsA.has(t)) return true;
	const termsA = new Set(a.topTerms.slice(0, 12));
	let shared = 0;
	for (const t of b.topTerms.slice(0, 12)) {
		if (termsA.has(t)) {
			shared++;
			if (shared >= 1) return true;
		}
	}
	return false;
}

function orderPair(a: ClaimOccurrence, b: ClaimOccurrence): { older: ClaimOccurrence; newer: ClaimOccurrence } {
	if (a.mtime !== b.mtime) {
		return a.mtime < b.mtime ? { older: a, newer: b } : { older: b, newer: a };
	}
	return a.path.localeCompare(b.path) <= 0 ? { older: a, newer: b } : { older: b, newer: a };
}

export type ContradictionInput = DocAnalysis | { analysis: DocAnalysis; body: string };

/**
 * Scans `docs` for conflicting figures, status reversals, and references to
 * deprecated/archived notes. Accepts either raw `DocAnalysis[]` (using
 * `firstLines`) or `{ analysis, body }[]` (scanning the full note body).
 */
export function detectContradictions(
	inputs: ContradictionInput[],
	graph?: LinkGraph,
	maxFindings = 25,
): DriftFinding[] {
	if (inputs.length < 2) return [];

	const normalized = inputs.map((item) =>
		"analysis" in item
			? { doc: item.analysis, text: item.body }
			: { doc: item, text: item.lineSamples.join("\n") },
	);
	const docs = normalized.map((n) => n.doc);

	const metricClaims = new Map<string, { doc: DocAnalysis; occ: ClaimOccurrence }[]>();
	const statusClaims = new Map<string, { doc: DocAnalysis; occ: ClaimOccurrence }[]>();

	for (const { doc, text } of normalized) {
		const lines = text.split("\n");
		let inFence = false;
		const seenMetricInDoc = new Set<string>();
		const seenStatusInDoc = new Set<string>();

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (/^(?:```|~~~)/.test(trimmed)) {
				inFence = !inFence;
				continue;
			}
			if (inFence || trimmed === "" || trimmed.length > 300) continue;

			METRIC_Assignment_RE.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = METRIC_Assignment_RE.exec(trimmed)) !== null) {
				const fullMatch = match[0];
				const rawSubject = match[1];
				const rawValue = match[2];
				const subject = normalizeSubject(rawSubject);
				const hasExplicit = /[=:]/.test(fullMatch);
				if (!isMeaningfulMetric(subject, rawValue, hasExplicit)) continue;
				if (seenMetricInDoc.has(subject)) continue;
				seenMetricInDoc.add(subject);

				const occ: ClaimOccurrence = {
					path: doc.file.path,
					title: doc.title,
					value: normalizeValue(rawValue),
					excerpt: trimmed.slice(0, 140),
					line: doc.frontmatter.endLine + i + 1,
					mtime: doc.file.mtime || 0,
				};
				const list = metricClaims.get(subject);
				if (list) list.push({ doc, occ });
				else metricClaims.set(subject, [{ doc, occ }]);
			}

			STATUS_RE.lastIndex = 0;
			while ((match = STATUS_RE.exec(trimmed)) !== null) {
				const subject = normalizeSubject(match[1]);
				const state = match[2].toLowerCase();
				if (subject.length < 3 || GENERIC_METRIC_SUBJECTS.has(subject)) continue;
				if (seenStatusInDoc.has(subject)) continue;
				seenStatusInDoc.add(subject);

				const occ: ClaimOccurrence = {
					path: doc.file.path,
					title: doc.title,
					value: state,
					excerpt: trimmed.slice(0, 140),
					line: doc.frontmatter.endLine + i + 1,
					mtime: doc.file.mtime || 0,
				};
				const list = statusClaims.get(subject);
				if (list) list.push({ doc, occ });
				else statusClaims.set(subject, [{ doc, occ }]);
			}
		}
	}

	const findings: DriftFinding[] = [];
	const seenPairs = new Set<string>();

	// 1. Evaluate metric drift across related documents.
	for (const [subject, entries] of metricClaims) {
		if (entries.length < 2) continue;
		for (let i = 0; i < entries.length; i++) {
			for (let j = i + 1; j < entries.length; j++) {
				const a = entries[i];
				const b = entries[j];
				if (a.occ.path === b.occ.path) continue;
				if (a.occ.value === b.occ.value) continue;
				if (!areDocsRelated(a.doc, b.doc, graph)) continue;

				const { older, newer } = orderPair(a.occ, b.occ);
				const key = `metric:${subject}:${older.path}:${newer.path}`;
				if (seenPairs.has(key)) continue;
				seenPairs.add(key);
				findings.push({
					kind: "metric-drift",
					subject,
					older,
					newer,
				});
			}
		}
	}

	// 2. Evaluate status reversals across related documents.
	for (const [subject, entries] of statusClaims) {
		if (entries.length < 2) continue;
		for (let i = 0; i < entries.length; i++) {
			for (let j = i + 1; j < entries.length; j++) {
				const a = entries[i];
				const b = entries[j];
				if (a.occ.path === b.occ.path) continue;
				if (OPPOSITE_STATUS[a.occ.value] !== b.occ.value) continue;
				if (!areDocsRelated(a.doc, b.doc, graph)) continue;

				const { older, newer } = orderPair(a.occ, b.occ);
				const key = `status:${subject}:${older.path}:${newer.path}`;
				if (seenPairs.has(key)) continue;
				seenPairs.add(key);
				findings.push({
					kind: "status-conflict",
					subject,
					older,
					newer,
				});
			}
		}
	}

	// 3. Evaluate stale references (active note linking to a note whose frontmatter
	// marks it `status: deprecated | archived | obsolete | superseded`).
	if (graph) {
		const docByPath = new Map(docs.map((d) => [d.file.path, d]));
		for (const doc of docs) {
			const rawStatus = String(doc.frontmatter.data.status ?? "").toLowerCase().trim();
			if (!["deprecated", "archived", "obsolete", "superseded"].includes(rawStatus)) continue;
			const node = graph.nodes.get(doc.file.path);
			if (!node || node.backlinks.length === 0) continue;

			for (const callerPath of node.backlinks) {
				const caller = docByPath.get(callerPath);
				if (!caller) continue;
				const callerStatus = String(caller.frontmatter.data.status ?? "active").toLowerCase().trim();
				if (["deprecated", "archived", "obsolete", "superseded"].includes(callerStatus)) continue;

				const key = `stale:${doc.file.path}:${caller.file.path}`;
				if (seenPairs.has(key)) continue;
				seenPairs.add(key);
				findings.push({
					kind: "stale-reference",
					subject: doc.title,
					older: {
						path: doc.file.path,
						title: doc.title,
						value: `status: ${rawStatus}`,
						excerpt: `${doc.title} is marked ${rawStatus}`,
						line: 1,
						mtime: doc.file.mtime || 0,
					},
					newer: {
						path: caller.file.path,
						title: caller.title,
						value: `links to [[${doc.title}]]`,
						excerpt: `Cites ${doc.title} (${rawStatus})`,
						line: 1,
						mtime: caller.file.mtime || 0,
					},
				});
			}
		}
	}

	findings.sort(
		(a, b) =>
			b.newer.mtime - a.newer.mtime ||
			a.subject.localeCompare(b.subject) ||
			a.older.path.localeCompare(b.older.path),
	);
	return findings.slice(0, maxFindings);
}
