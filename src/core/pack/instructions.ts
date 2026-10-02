/**
 * Destination "custom instructions" generator.
 *
 * A notebook or a chat session gets more useful when it is told what it is
 * looking at. Instead of leaving the user to write that prompt from scratch,
 * the bundle ships one built from the knowledge layer: what the corpus is, how
 * it is structured, how to cite it, what to distrust, and what it can be asked.
 *
 * The text is deliberately short and paste-ready (NotebookLM's custom
 * instructions field caps at 10 000 characters) and it never invents content:
 * every line is derived from statistics the engine already computed.
 */

import type { KnowledgeMap } from "../intel/knowledgeMap";
import { STOP_WORDS } from "../intel/terms";
import { formatBytes, formatCount, plural } from "../util";

export interface InstructionsInput {
	map: KnowledgeMap;
	/** `S01 …` citation scheme is on, so the prompt can explain how to cite. */
	citationIds: boolean;
	/** Words and tokens actually shipped in the bundle. */
	stats: { words: number; tokens: number; chars: number };
	profileName: string;
	parts: number;
	volumes: number;
	/** ISO date of the newest note in the bundle, when known. */
	lastModified?: string;
	/** Destination hint, e.g. "NotebookLM". */
	destination?: string;
}

export const MAX_INSTRUCTIONS_CHARS = 10_000;

/** Builds the paste-ready instruction block. */
export function buildInstructions(input: InstructionsInput): string {
	const { map } = input;
	const lines: string[] = [];
	const place = input.destination ? input.destination : "this workspace";

	lines.push(`# Instructions for ${place}`, "");
	lines.push(
		`You are given ${formatCount(map.overview.notes)} notes from a personal knowledge base` +
			` (${formatBytes(input.stats.chars)} of Markdown, ~${formatCount(input.stats.tokens)} tokens` +
			(input.parts > 1 ? `, ${input.parts} parts` : "") +
			(input.volumes > 1 ? ` grouped in ${input.volumes} volumes` : "") +
			`). They were exported with the **${input.profileName}** profile.`,
	);

	// -- what is in there -----------------------------------------------------
	if (map.overview.folders.length > 0) {
		const folders = map.overview.folders
			.slice(0, 8)
			.map((folder) => `${folder.path} (${plural(folder.notes, "note")}, ${formatCount(folder.words)} words)`)
			.join(", ");
		lines.push("", `**Where the notes live.** ${folders}.`);
	}
	if (map.overview.dateRange) {
		const { from, to } = map.overview.dateRange;
		if (from !== "" && to !== "" && from !== to) lines.push("", `**Period covered.** ${from} → ${to}.`);
		else if (to !== "") lines.push("", `**Last modified.** ${to}.`);
	}
	if (map.tags.length > 0) {
		lines.push("", `**Tags in use.** ${map.tags.slice(0, 12).map((tag) => `#${tag.tag} (${tag.count})`).join(", ")}.`);
	}
	if (map.themes.length > 0) {
		const themes = map.themes
			.slice(0, 6)
			.map((theme) => `**${theme.label}** — ${plural(theme.notes, "note")}`)
			.join("; ");
		lines.push("", `**Recurring themes.** ${themes}.`);
	}
	if (map.hubs.length > 0) {
		const hubs = map.hubs.slice(0, 5).map((hub) => hub.title).join(", ");
		lines.push("", `**Start from these.** ${hubs} are the most referenced notes.`);
	}

	// -- how to read it -------------------------------------------------------
	lines.push("", "## How the bundle is organised", "");
	if (input.parts > 1) {
		lines.push(
			`- The notes are split into ${input.parts} parts, each labelled *Part n of m*` +
				(input.volumes > 1 ? ` (and grouped in ${input.volumes} volumes to import one at a time)` : "") +
				". A part may continue a note that started in the previous one: the note title is repeated when it does.",
		);
	}
	if (input.citationIds) {
		lines.push(
			"- Every note starts with a stable citation id (`S01`, `S02`, …) and its vault path in the metadata line below the title.",
		);
		lines.push("- **Cite the ids**, e.g. “according to S07”, and quote the note title, not the part number.");
	} else {
		lines.push("- Every note starts with its title, followed by a metadata line with its vault path.");
	}
	if (map.duplicates.length > 0) {
		lines.push(
			`- ${plural(map.duplicates.length, "note")} ${map.duplicates.length === 1 ? "was a duplicate" : "were duplicates"} of another note: ` +
				"they appear as one-line stubs that name the copy that was kept.",
		);
	}
	if (map.overview.notes > 0) {
		lines.push("- Empty or near-empty notes, repeated boilerplate lines and shared template blocks were removed.");
	}

	// -- how to answer --------------------------------------------------------
	lines.push("", "## How to answer", "");
	lines.push(
		"1. Ground every statement in the sources above; say plainly when the notes do not answer a question.",
		"2. Prefer the specific numbers, names and decisions found in the notes over generic advice.",
		"3. When two notes disagree, show both and note that the vault is inconsistent — do not silently pick one.",
		input.citationIds
			? "4. End substantial answers with the citation ids you used."
			: "4. End substantial answers with the note titles you used.",
	);

	// -- what to ask ----------------------------------------------------------
	const questions = suggestQuestions(map, input);
	if (questions.length > 0) {
		lines.push("", "## Useful questions to start with", "");
		for (const question of questions) lines.push(`- ${question}`);
	}

	// -- vocabulary -----------------------------------------------------------
	// Terms that only ever appear in one note are that note's private jargon,
	// not the corpus vocabulary.
	const vocabulary = map.keyTerms
		.filter((term) => term.notes > 1 || term.weight >= 0.6)
		.filter((term) => !STOP_WORDS.has(term.term.toLowerCase()) && term.term.length >= 3)
		.slice(0, 12)
		.map((term) => term.term);
	if (vocabulary.length > 0) {
		lines.push("", `**Vocabulary that matters in this corpus.** ${vocabulary.join(", ")}.`);
	}

	lines.push(
		"",
		"---",
		"",
		`*Generated by Condensated Vault Exporter on ${map.generatedAt.slice(0, 10)}. Every figure above comes from the bundle itself.*`,
	);

	const text = lines.join("\n");
	return text.length > MAX_INSTRUCTIONS_CHARS ? `${text.slice(0, MAX_INSTRUCTIONS_CHARS - 40).trimEnd()}\n\n*… truncated by the generator.*` : text;
}

/**
 * Questions the corpus looks able to answer, derived from its own structure:
 * hubs are the questions the vault circles around, themes the questions it
 * groups, orphans the notes nobody linked.
 */
function suggestQuestions(map: KnowledgeMap, input: InstructionsInput): string[] {
	const questions: string[] = [];
	for (const hub of map.hubs.slice(0, 3)) {
		questions.push(`What does **${hub.title}** cover, and which notes depend on it?`);
	}
	for (const theme of map.themes.slice(0, 2)) {
		questions.push(`Summarise the recurring theme “${theme.label}” and list the notes behind it.`);
	}
	if (map.duplicates.length > 0) {
		questions.push("Which notes are near-duplicates, and how do they differ?");
	}
	if (map.orphans.length > 0) {
		questions.push(`Which notes are unlinked and might need to be connected to the rest?`);
	}
	if (map.brokenLinks.length > 0) {
		questions.push(`Which links point to notes that no longer exist? (${map.brokenLinks.length} were found)`);
	}
	if (input.lastModified) {
		questions.push(`What changed most recently, around ${input.lastModified.slice(0, 10)}?`);
	}
	return questions.slice(0, 6);
}
