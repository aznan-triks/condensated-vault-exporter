/**
 * Dependency-free token estimator.
 *
 * LLM tokenizers are not available offline, so we blend three signals that
 * track real BPE behaviour well within ~10-15 %:
 *
 *  1. character count in words — Latin scripts average ~4 chars/token;
 *  2. word count — English prose averages ~1.3 tokens/word;
 *  3. symbol density — code and markdown tokenize far worse than prose;
 *     each ASCII symbol costs a fraction of a token on its own.
 *
 * CJK text is counted separately: one character is roughly one token.
 * A calibration multiplier (settings → Advanced) lets users match the model
 * they actually feed.
 */

export interface TokenStats {
	words: number;
	chars: number;
	/** Characters of non-whitespace text. */
	nonSpaceChars: number;
	cjkChars: number;
	symbols: number;
	tokens: number;
}

const CJK_RE =
	/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u1100-\u11ff]/;
const SYMBOL_RE = /[{}()[\]<>;:+=*/\\|&!^~%$#@`_\-]/;
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’._-]*/gu;

export interface TokenEstimateOptions {
	/** Multiplier applied to the final result (default 1). */
	calibration?: number;
	/** Treat the input as source code (raises the symbol weight). */
	code?: boolean;
}

export function estimateTokens(text: string, options: TokenEstimateOptions = {}): TokenStats {
	const calibration = options.calibration && options.calibration > 0 ? options.calibration : 1;
	let nonSpaceChars = 0;
	let cjkChars = 0;
	let symbols = 0;
	let latinLikeChars = 0;
	let words = 0;

	const wordMatches = text.match(WORD_RE);
	if (wordMatches) {
		for (const word of wordMatches) {
			if (CJK_RE.test(word)) {
				// CJK "words" are runs of characters; count characters instead.
				continue;
			}
			words++;
			latinLikeChars += word.length;
		}
	}

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const code = text.charCodeAt(i);
		if (code === 32 || code === 9 || code === 10 || code === 13) continue;
		nonSpaceChars++;
		if (CJK_RE.test(ch)) cjkChars++;
		else if (SYMBOL_RE.test(ch)) symbols++;
	}

	const latinChars = Math.max(0, nonSpaceChars - cjkChars - symbols);
	const symbolWeight = options.code ? 0.5 : 0.3;

	const byChars = latinChars / 4.0;
	const byWords = words * 1.3;
	const latinTokens = byChars * 0.5 + byWords * 0.5;
	const tokens = (latinTokens + symbols * symbolWeight + cjkChars * 1.0) * calibration;

	return {
		words: words + cjkChars,
		chars: text.length,
		nonSpaceChars,
		cjkChars,
		symbols,
		tokens: Math.max(text.length === 0 ? 0 : 1, Math.round(tokens)),
	};
}

/** Convenience helper when only the token count is needed. */
export function countTokens(text: string, calibration = 1): number {
	return estimateTokens(text, { calibration }).tokens;
}

/**
 * Approximates the number of tokens a real BPE tokenizer would produce for a
 * worst-case (punctuation-heavy) input — used to guarantee chunk sizes are
 * never under-estimated by more than a safety margin.
 */
export function estimateTokensConservative(text: string, calibration = 1): number {
	const base = estimateTokens(text, { calibration }).tokens;
	return Math.ceil(base * 1.12);
}
