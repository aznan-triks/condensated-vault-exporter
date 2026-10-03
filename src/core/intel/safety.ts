/**
 * Safety scan & active secret redaction: does the bundle we are about to hand
 * to a cloud model contain credentials or sensitive connection strings?
 *
 * A vault is a private space, and merged bundles are explicitly built to be
 * uploaded to NotebookLM, ChatGPT, Claude or an embedding pipeline. Notes that
 * were perfectly safe sitting in a local folder become a different kind of
 * exposure as soon as they are pasted into a third-party service.
 *
 * This module provides:
 * 1. `scanForSecrets`: non-destructive line-by-line credential detection with
 *    redacted samples for the export report.
 * 2. `redactSecretsInText`: active in-place scrubbing that replaces matched
 *    credentials (and full multi-line PEM private key blocks) with safe
 *    `[REDACTED: …]` markers before the bundle leaves the machine.
 */

export interface SecretKind {
	id: string;
	label: string;
	pattern: RegExp;
}

export interface SecretFinding {
	/** Stable id of the matched pattern (see `SECRET_KINDS`). */
	kind: string;
	/** Human label, e.g. "AWS access key". */
	label: string;
	/** Which part of the export it was found in (1-based). */
	part: number;
	/** Redacted excerpt — never the whole secret. */
	sample: string;
}

/** Patterns are global-flag-free: `matchAll` / `RegExp(..., "g")` clones state safely. */
export const SECRET_KINDS: SecretKind[] = [
	{
		id: "private-key",
		label: "Private key block",
		pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
	},
	{
		id: "aws-access-key",
		label: "AWS access key id",
		pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/,
	},
	{
		id: "github-token",
		label: "GitHub token",
		pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
	},
	{
		id: "slack-token",
		label: "Slack token",
		pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
	},
	{
		id: "openai-key",
		label: "OpenAI / Anthropic key",
		pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/,
	},
	{
		id: "google-key",
		label: "Google API key",
		pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
	},
	{
		id: "huggingface-token",
		label: "Hugging Face token",
		pattern: /\bhf_[A-Za-z0-9]{30,}\b/,
	},
	{
		id: "stripe-key",
		label: "Stripe API key",
		pattern: /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{24,}\b/,
	},
	{
		id: "npm-token",
		label: "npm access token",
		pattern: /\bnpm_[A-Za-z0-9]{36}\b/,
	},
	{
		id: "db-connection",
		label: "Database connection URI",
		pattern: /\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis|amqp):\/\/[^:\s/@"']+:[^@\s/"']+@[^\s"'`]+/i,
	},
	{
		id: "jwt",
		label: "JSON web token",
		pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
	},
	{
		id: "named-secret",
		label: "Named secret",
		pattern:
			/\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret)\b\s*[:=]\s*["'`]?([A-Za-z0-9+/_\-.]{12,})/i,
	},
	{
		id: "bearer",
		label: "Bearer token",
		pattern: /\bBearer\s+([A-Za-z0-9\-._~+/]{24,}=*)/,
	},
];

export const PII_KINDS: SecretKind[] = [
	{
		id: "email",
		label: "Email address",
		pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,12}\b/,
	},
];

const PEM_BLOCK_RE =
	/-----BEGIN ((?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?-----END \1-----/g;

/** How many findings are kept before the scan stops looking (per export). */
const DEFAULT_MAX_FINDINGS = 50;
/** Findings are reported by kind; this caps the per-kind list too. */
const MAX_SAMPLES_PER_KIND = 3;
/** Lines longer than this are skipped: minified data, not notes. */
const MAX_LINE_LENGTH = 4000;

export interface SecretScanPart {
	index: number;
	content: string;
}

export interface SecretScanOutcome {
	findings: SecretFinding[];
	/** True when the scan stopped early because `maxFindings` was reached. */
	truncated: boolean;
}

export interface RedactionOptions {
	/** Also redact email addresses. */
	redactPii?: boolean;
}

export interface RedactionOutcome {
	text: string;
	redactedCount: number;
}

/** Redacts a match so a report can name the shape without leaking the value. */
export function redactSample(raw: string): string {
	const text = raw.trim();
	if (text.length <= 12) return `${text.slice(0, 2)}…`;
	return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

/**
 * Scans the assembled parts line by line. Only the first match per line is
 * reported: a line is either a credential or it is not, and a line full of
 * base64 would otherwise produce a page of near-identical warnings.
 */
export function scanForSecrets(parts: SecretScanPart[], maxFindings = DEFAULT_MAX_FINDINGS): SecretScanOutcome {
	const findings: SecretFinding[] = [];
	let truncated = false;
	for (const part of parts) {
		const lines = part.content.split("\n");
		for (const line of lines) {
			if (line.length === 0 || line.length > MAX_LINE_LENGTH) continue;
			for (const kind of SECRET_KINDS) {
				const match = kind.pattern.exec(line);
				if (!match) continue;
				findings.push({
					kind: kind.id,
					label: kind.label,
					part: part.index + 1,
					sample: redactSample(match[0]),
				});
				break;
			}
			if (findings.length >= maxFindings) {
				truncated = true;
				return { findings, truncated };
			}
		}
	}
	return { findings, truncated };
}

/**
 * Scrubs credentials (and optionally PII) in-place from a text string,
 * replacing each match with a descriptive `[REDACTED: …]` placeholder.
 */
export function redactSecretsInText(input: string, options: RedactionOptions = {}): RedactionOutcome {
	let redactedCount = 0;

	// 1. Collapse full multi-line PEM private key blocks first so body base64
	// lines are not left behind after the header is redacted.
	const afterPem = input.replace(PEM_BLOCK_RE, () => {
		redactedCount++;
		return "[REDACTED: Private key block]";
	});

	const activeKinds = options.redactPii ? [...SECRET_KINDS, ...PII_KINDS] : SECRET_KINDS;

	// 2. Scrub line by line for remaining single-line credentials.
	const lines = afterPem.split("\n");
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];
		if (line.length === 0 || line.length > MAX_LINE_LENGTH) continue;
		for (const kind of activeKinds) {
			const flags = kind.pattern.flags.includes("g") ? kind.pattern.flags : `${kind.pattern.flags}g`;
			const globalRe = new RegExp(kind.pattern.source, flags);
			line = line.replace(globalRe, (matched) => {
				redactedCount++;
				if (kind.id === "named-secret") {
					const sepMatch = /^([^:=]+[:=]\s*["'`]?)/.exec(matched);
					const prefix = sepMatch ? sepMatch[1] : "";
					return `${prefix}[REDACTED: ${kind.label}]`;
				}
				if (kind.id === "bearer") {
					return `Bearer [REDACTED: ${kind.label}]`;
				}
				return `[REDACTED: ${kind.label} (${redactSample(matched)})]`;
			});
		}
		lines[i] = line;
	}

	return { text: lines.join("\n"), redactedCount };
}

/** Summarizes findings by kind, most frequent first. */
export function groupSecretFindings(
	findings: SecretFinding[],
): { label: string; count: number; sample: string; part: number }[] {
	const groups = new Map<string, { label: string; count: number; sample: string; part: number }>();
	for (const finding of findings) {
		const group = groups.get(finding.kind);
		if (group) {
			group.count++;
			continue;
		}
		groups.set(finding.kind, { label: finding.label, count: 1, sample: finding.sample, part: finding.part });
	}
	return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export { MAX_SAMPLES_PER_KIND };
