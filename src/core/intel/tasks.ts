/**
 * Epistemic Task, Blocker & Open Question Harvester.
 *
 * Personal and engineering vaults accumulate action items (`- [ ] ...`),
 * in-progress work (`- [/] ...`), `TODO:` / `FIXME:` markers, and explicit
 * open questions under headings like `## Open questions` or `## Blockers`.
 *
 * This module harvests those items across the corpus, deduplicating recurring
 * daily-note tasks (tracking how many notes carry the same unfinished task) so
 * both the author and the destination LLM can see every unresolved action item
 * and open question at a glance.
 */

import type { DocAnalysis } from "../types";
import { stripInlineMarkup } from "../markdown/syntax";

export interface OpenItem {
	kind: "task" | "question" | "in-progress";
	priority: "high" | "normal";
	text: string;
	/** Most recent (or primary) note carrying this item. */
	path: string;
	title: string;
	/** How many notes in the corpus carry this exact unchecked item. */
	occurrences: number;
}

export interface OpenItemsSummary {
	tasks: OpenItem[];
	questions: OpenItem[];
	totalTasks: number;
	totalQuestions: number;
}

export type OpenItemInput = DocAnalysis | { analysis: DocAnalysis; body: string };

const OPEN_TASK_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[([ /?])\]\s+(.+)$/;
const EXPLICIT_MARKER_RE = /^(?:[-*+]\s+)?(?:TODO|FIXME|QUESTION|BLOCKER|❓)\s*[:—-]?\s+(.+)$/i;
const QUESTION_HEADING_RE = /^#{1,6}\s+.*\b(open\s+questions?|questions?|unresolved|blockers?|unknowns?)\b/i;
const HIGH_PRIORITY_RE = /🔥|⏫|🔺|\[!?(?:high|urgent|blocker|p0|p1)\]|#(?:urgent|high|blocker)\b|\b(?:FIXME|BLOCKER)\b/i;

export function extractOpenItems(inputs: OpenItemInput[], maxItems = 30): OpenItemsSummary {
	const taskMap = new Map<string, { item: OpenItem; mtime: number }>();
	const questionMap = new Map<string, { item: OpenItem; mtime: number }>();

	for (const raw of inputs) {
		const doc = "analysis" in raw ? raw.analysis : raw;
		const text = "analysis" in raw ? raw.body : doc.lineSamples.join("\n");
		const mtime = doc.file.mtime || 0;
		const lines = text.split(/\r?\n/);

		let inCode = false;
		let inQuestionSection = false;
		const seenInDoc = new Set<string>();

		for (const line of lines) {
			const trimmed = line.trim();
			if (/^(?:```|~~~)/.test(trimmed)) {
				inCode = !inCode;
				continue;
			}
			if (inCode || trimmed === "") continue;

			if (/^#{1,6}\s+/.test(trimmed)) {
				inQuestionSection = QUESTION_HEADING_RE.test(trimmed);
				continue;
			}

			// 1. Unchecked or in-progress Markdown tasks: `- [ ] ...` or `- [/] ...`
			const taskMatch = OPEN_TASK_RE.exec(line);
			if (taskMatch) {
				const cleanText = stripInlineMarkup(taskMatch[2]).trim();
				if (cleanText.length < 4 || cleanText.length > 220) continue;
				const key = `task:${cleanText.toLowerCase()}`;
				if (seenInDoc.has(key)) continue;
				seenInDoc.add(key);

				const existing = taskMap.get(key);
				if (existing) {
					existing.item.occurrences++;
					if (mtime >= existing.mtime) {
						existing.item.path = doc.file.path;
						existing.item.title = doc.title;
						existing.mtime = mtime;
					}
				} else {
					const marker = taskMatch[1];
					taskMap.set(key, {
						mtime,
						item: {
							kind: marker === "/" ? "in-progress" : "task",
							priority: HIGH_PRIORITY_RE.test(line) ? "high" : "normal",
							text: cleanText,
							path: doc.file.path,
							title: doc.title,
							occurrences: 1,
						},
					});
				}
				continue;
			}

			// 2. Explicit TODO / FIXME / QUESTION / BLOCKER markers
			const markerMatch = EXPLICIT_MARKER_RE.exec(trimmed);
			if (markerMatch) {
				const cleanText = stripInlineMarkup(markerMatch[1]).trim();
				if (cleanText.length < 6 || cleanText.length > 240) continue;
				const isQ = cleanText.endsWith("?") || /^question|❓/i.test(trimmed);
				const kind = isQ ? "question" : "task";
				const map = isQ ? questionMap : taskMap;
				const key = `${kind}:${cleanText.toLowerCase()}`;
				if (seenInDoc.has(key)) continue;
				seenInDoc.add(key);

				const existing = map.get(key);
				if (existing) {
					existing.item.occurrences++;
				} else {
					map.set(key, {
						mtime,
						item: {
							kind,
							priority: HIGH_PRIORITY_RE.test(trimmed) ? "high" : "normal",
							text: cleanText,
							path: doc.file.path,
							title: doc.title,
							occurrences: 1,
						},
					});
				}
				continue;
			}

			// 3. Questions inside an `## Open questions` or `## Blockers` section
			if (inQuestionSection) {
				const bulletStripped = trimmed.replace(/^(?:[-*+]|\d+[.)])\s+/, "").trim();
				const cleanText = stripInlineMarkup(bulletStripped).trim();
				if (cleanText.endsWith("?") && cleanText.length >= 12 && cleanText.length <= 240) {
					const key = `question:${cleanText.toLowerCase()}`;
					if (seenInDoc.has(key)) continue;
					seenInDoc.add(key);
					const existing = questionMap.get(key);
					if (existing) {
						existing.item.occurrences++;
					} else {
						questionMap.set(key, {
							mtime,
							item: {
								kind: "question",
								priority: HIGH_PRIORITY_RE.test(trimmed) ? "high" : "normal",
								text: cleanText,
								path: doc.file.path,
								title: doc.title,
								occurrences: 1,
							},
						});
					}
				}
			}
		}
	}

	const tasks = Array.from(taskMap.values())
		.sort(
			(a, b) =>
				(a.item.priority === "high" ? -1 : 1) - (b.item.priority === "high" ? -1 : 1) ||
				b.mtime - a.mtime ||
				b.item.occurrences - a.item.occurrences ||
				a.item.path.localeCompare(b.item.path),
		)
		.map((e) => e.item);

	const questions = Array.from(questionMap.values())
		.sort((a, b) => b.mtime - a.mtime || b.item.occurrences - a.item.occurrences || a.item.path.localeCompare(b.item.path))
		.map((e) => e.item);

	return {
		tasks: tasks.slice(0, maxItems),
		questions: questions.slice(0, maxItems),
		totalTasks: tasks.length,
		totalQuestions: questions.length,
	};
}
