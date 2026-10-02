/**
 * Neighbourhood scoping: export a note *and what it connects to*.
 *
 * Profiles usually export a folder or the whole vault. This adds the third
 * axis people actually ask for: "I am reading this MOC / this note — take it,
 * everything it links to, and everything that links back, and turn that into a
 * bundle". The scope is computed before the analysis pass, from a cheap
 * link-only read of the candidate files, so a neighbourhood export of ten
 * notes does not pay for a full analysis of the vault.
 */

import type { SourceFile, VaultPort } from "./types";
import { buildNameIndex, extractLinksFromLine, resolveLinkTarget } from "./markdown/links";
import { mapLimit, normalizeVaultPath, stripExtension, basename } from "./util";

export interface Neighbourhood {
	/** Vault path of the note at the centre of the scope. */
	root: string;
	/** How many link hops out from the root are included (0 = the root only). */
	hops: number;
}

export interface NeighbourhoodOutcome {
	/** Paths to keep, or `null` when the scope could not be computed. */
	paths: Set<string> | null;
	warnings: string[];
	/** Notes read to build the link map. */
	scanned: number;
}

/** Reads the links of the candidate files and returns the reachable set. */
export async function neighbourhoodScope(
	vault: VaultPort,
	files: SourceFile[],
	options: Neighbourhood,
	concurrency = 8,
): Promise<NeighbourhoodOutcome> {
	const warnings: string[] = [];
	const root = normalizeVaultPath(options.root);
	const known = new Set(files.map((file) => file.path));
	if (!known.has(root)) {
		warnings.push(`The note ${root} is not in scope — check the folders the profile targets.`);
		return { paths: null, warnings, scanned: 0 };
	}

	const pathIndex = new Map<string, string>();
	for (const path of known) pathIndex.set(path.toLowerCase(), path);
	const nameIndex = buildNameIndex(known.values());
	const outgoing = new Map<string, string[]>();
	const incoming = new Map<string, string[]>();
	let unreadable = 0;

	await mapLimit(files, Math.max(1, concurrency), async (file) => {
		let text: string;
		try {
			text = await vault.read(file.path);
		} catch (error) {
			unreadable++;
			warnings.push(`Could not read ${file.path} while expanding the neighbourhood: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const links: string[] = [];
		for (const line of text.split("\n")) {
			// Headings and prose rarely contain links; the cheap check first.
			if (!line.includes("[[") && !line.includes("](")) continue;
			const extracted = extractLinksFromLine(line);
			for (const link of extracted.links) {
				if (link.isExternal) continue;
				const target = resolveLinkTarget(link.target, file.path, pathIndex, nameIndex);
				if (target === undefined || target === "" || !known.has(target) || target === file.path) continue;
				if (!links.includes(target)) links.push(target);
			}
		}
		if (links.length === 0) return;
		outgoing.set(file.path, links);
		for (const target of links) {
			const list = incoming.get(target);
			if (list) {
				if (!list.includes(file.path)) list.push(file.path);
			} else {
				incoming.set(target, [file.path]);
			}
		}
	});

	// Breadth-first over both directions: a link out and a backlink in are both
	// "this note is connected", which is what a reader means by neighbourhood.
	const reached = new Set<string>([root]);
	let frontier = [root];
	for (let hop = 0; hop < Math.max(0, options.hops); hop++) {
		const next: string[] = [];
		for (const path of frontier) {
			for (const neighbour of [...(outgoing.get(path) ?? []), ...(incoming.get(path) ?? [])]) {
				if (reached.has(neighbour)) continue;
				reached.add(neighbour);
				next.push(neighbour);
			}
		}
		if (next.length === 0) break;
		frontier = next;
	}

	if (reached.size <= 1 && options.hops > 0) {
		warnings.push(
			`${basename(root)} has no links inside the current scope — the bundle contains only this note.`,
		);
	}
	if (unreadable > 0) {
		warnings.push(`${unreadable} note(s) could not be read while expanding the neighbourhood; links from them are missing.`);
	}
	return { paths: reached, warnings, scanned: files.length };
}

/** Human-readable label of a neighbourhood, used in the export reason. */
export function describeNeighbourhood(options: Neighbourhood): string {
	const name = stripExtension(basename(normalizeVaultPath(options.root)));
	return options.hops <= 0 ? name : `${name} + ${options.hops} hop(s)`;
}
