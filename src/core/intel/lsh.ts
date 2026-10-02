/**
 * Small LSH (locality-sensitive hashing) index over MinHash signatures.
 *
 * Shared by duplicate detection and by the "related notes" index: both need
 * to find, for a given signature, the (few) other documents that could be
 * similar, without comparing every pair.
 *
 * 4 rows per band gives ~99 % recall above 0.85 similarity while keeping the
 * candidate lists small for dissimilar documents.
 */

export const BAND_ROWS = 4;
const SIGNATURE_LENGTH = 32;

export type LshIndex = Map<string, number[]>[];

export function buildLshIndex(signatures: (Uint32Array | null)[], bandRows = BAND_ROWS): LshIndex {
	const bandCount = Math.floor(SIGNATURE_LENGTH / bandRows);
	const index: LshIndex = new Array(bandCount);
	for (let b = 0; b < bandCount; b++) index[b] = new Map();

	for (let i = 0; i < signatures.length; i++) {
		const sig = signatures[i];
		if (!sig || sig.length !== SIGNATURE_LENGTH) continue;
		for (let b = 0; b < bandCount; b++) {
			const key = bandKey(sig, b, bandRows);
			const list = index[b].get(key);
			if (list) list.push(i);
			else index[b].set(key, [i]);
		}
	}
	return index;
}

export function bandKey(sig: Uint32Array, band: number, bandRows = BAND_ROWS): string {
	const start = band * bandRows;
	let key = "";
	for (let i = start; i < start + bandRows && i < sig.length; i++) key += sig[i].toString(36) + "|";
	return key;
}

/**
 * Returns the candidate ids that collide with `signature` in at least one
 * band, capped at `maxCandidates` (the first bands are the cheapest signals).
 */
export function candidatesOf(
	index: LshIndex,
	signature: Uint32Array | null,
	exclude?: number,
	maxCandidates = 200,
): number[] {
	if (!signature || signature.length !== SIGNATURE_LENGTH) return [];
	const found = new Set<number>();
	for (let b = 0; b < index.length; b++) {
		const list = index[b].get(bandKey(signature, b));
		if (!list) continue;
		for (const id of list) {
			if (id === exclude) continue;
			found.add(id);
			if (found.size >= maxCandidates) return Array.from(found);
		}
	}
	return Array.from(found);
}

/** How many bands a signature has (for reporting / tie-breaking). */
export function bandCount(bandRows = BAND_ROWS): number {
	return Math.floor(SIGNATURE_LENGTH / bandRows);
}
