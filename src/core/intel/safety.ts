/**
 * Safety scan: does the thing we are about to hand to a cloud model contain
 * credentials?
 *
 * A vault is a private space, and merged bundles are explicitly built to be
 * uploaded to NotebookLM, ChatGPT or an embedding pipeline. Notes that were
 * perfectly safe sitting in a local folder become a different kind of exposure
 * as soon as they are pasted into a third-party service. The exporter already
 * knows exactly which bytes are leaving the machine, so it can say so.
 *
 * The scan is deliberately shallow: a set of well-known credential shapes,
 * matched line by line. It is a smoke detector, not a vault scanner — the
 * findings are reported with a redacted sample so the warning never becomes
 * the leak it warns about.
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

/** Patterns are global-flag-free: `matchAll` needs its own copy of the state. */
export const SECRET_KINDS: SecretKind[] = [
	{ id: "private-key", label: "Private key block", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
	{ id: "aws-access-key", label: "AWS access key id", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
	{ id: "github-token", label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
	{ id: "slack-token", label: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
	{ id: "openai-key", label: "OpenAI key", pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/ },
	{ id: "google-key", label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ id: "jwt", label: "JSON web token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
	{ id: "named-secret", label: "Named secret", pattern: /\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret)\b\s*[:=]\s*["'`]?([A-Za-z0-9+/_\-.]{12,})/i },
	{ id: "bearer", label: "Bearer token", pattern: /\bBearer\s+([A-Za-z0-9\-._~+/]{24,}=*)/ },
];

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

/** Summarizes findings by kind, most frequent first. */
export function groupSecretFindings(findings: SecretFinding[]): { label: string; count: number; sample: string; part: number }[] {
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
