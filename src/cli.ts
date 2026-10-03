/**
 * Headless CLI for Condensated Vault Exporter.
 *
 * Because `src/core` is completely independent of Obsidian's DOM and runtime,
 * any local directory of Markdown and `.canvas` notes can be condensed,
 * queried, audited for credential leaks or metric drift, and packaged into
 * AI-ready bundles directly from the terminal or CI pipelines.
 *
 * Usage:
 *   npm run cli -- <vault-dir> [--profile notebooklm] [--focus "query"] [--format html] [--redact] [--preview]
 */

import * as fs from "fs";
import * as path from "path";
import { knowledgeMapToMarkdown, type KnowledgeMap } from "./core/intel/knowledgeMap";
import { BUILTIN_PROFILES, createBuiltinProfile, createDefaultProfiles } from "./core/profiles";
import { runExport } from "./core/pipeline";
import type { ExportFormat, ExportProfile, ExportResult, SinkPort, SourceFile, VaultPort } from "./core/types";
import { formatBytes, formatCount, normalizeVaultPath } from "./core/util";

const LISTED_EXTENSIONS = new Set(["md", "markdown", "mdx", "txt", "canvas", "png", "jpg", "jpeg", "gif", "webp", "svg", "pdf"]);

export class NodeFsVaultPort implements VaultPort {
	private readonly rootDir: string;

	constructor(rootDir: string) {
		this.rootDir = path.resolve(rootDir);
	}

	async listFiles(roots?: string[]): Promise<SourceFile[]> {
		const out: SourceFile[] = [];
		const walk = async (relDir: string): Promise<void> => {
			const absDir = relDir === "" ? this.rootDir : path.join(this.rootDir, relDir);
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(absDir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
				if (entry.isDirectory()) {
					await walk(relPath);
					continue;
				}
				if (!entry.isFile()) continue;
				const dot = entry.name.lastIndexOf(".");
				const ext = dot <= 0 ? "" : entry.name.slice(dot + 1).toLowerCase();
				if (!LISTED_EXTENSIONS.has(ext)) continue;
				try {
					const stat = await fs.promises.stat(path.join(this.rootDir, relPath));
					out.push({
						path: normalizeVaultPath(relPath),
						name: entry.name,
						folder: normalizeVaultPath(relDir),
						ext,
						size: stat.size,
						mtime: stat.mtimeMs,
						ctime: stat.birthtimeMs || stat.ctimeMs,
					});
				} catch {
					// Ignore unreadable files during directory listing.
				}
			}
		};

		await walk("");
		out.sort((a, b) => a.path.localeCompare(b.path));
		if (!roots || roots.length === 0) return out;
		const normalizedRoots = roots.map((r) => normalizeVaultPath(r).toLowerCase()).filter(Boolean);
		if (normalizedRoots.length === 0) return out;
		return out.filter((f) => {
			const lower = f.path.toLowerCase();
			return normalizedRoots.some((r) => lower === r || lower.startsWith(`${r}/`));
		});
	}

	async read(vaultPath: string): Promise<string> {
		const full = path.join(this.rootDir, normalizeVaultPath(vaultPath));
		return await fs.promises.readFile(full, "utf8");
	}

	async readBinary(vaultPath: string): Promise<string> {
		const full = path.join(this.rootDir, normalizeVaultPath(vaultPath));
		const buf = await fs.promises.readFile(full);
		return buf.toString("base64");
	}

	async exists(vaultPath: string): Promise<boolean> {
		const full = path.join(this.rootDir, normalizeVaultPath(vaultPath));
		try {
			await fs.promises.access(full);
			return true;
		} catch {
			return false;
		}
	}
}

export class NodeFsSinkPort implements SinkPort {
	private readonly baseDir: string;
	readonly written: string[] = [];

	constructor(baseDir: string) {
		this.baseDir = path.resolve(baseDir);
	}

	async write(relPath: string, content: string): Promise<string> {
		const target = path.isAbsolute(relPath) ? relPath : path.join(this.baseDir, normalizeVaultPath(relPath));
		await fs.promises.mkdir(path.dirname(target), { recursive: true });
		await fs.promises.writeFile(target, content, "utf8");
		this.written.push(target);
		return target;
	}
}

export interface CliOptions {
	vaultDir?: string;
	profileId: string;
	format?: ExportFormat;
	focus?: string;
	maxNotes: number;
	outDir?: string;
	redact: boolean;
	preview: boolean;
	intel: boolean;
	json: boolean;
	listProfiles: boolean;
	help: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
	const opts: CliOptions = {
		profileId: "notebooklm",
		maxNotes: 0,
		redact: false,
		preview: false,
		intel: false,
		json: false,
		listProfiles: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			opts.help = true;
		} else if (arg === "--list-profiles") {
			opts.listProfiles = true;
		} else if (arg === "--redact") {
			opts.redact = true;
		} else if (arg === "--preview" || arg === "--dry-run") {
			opts.preview = true;
		} else if (arg === "--intel" || arg === "--health") {
			opts.intel = true;
			opts.preview = true;
		} else if (arg === "--json") {
			opts.json = true;
		} else if (arg === "--profile" || arg === "-p") {
			opts.profileId = argv[++i] ?? opts.profileId;
		} else if (arg === "--format" || arg === "-f") {
			opts.format = argv[++i] as ExportFormat;
		} else if (arg === "--focus" || arg === "-q") {
			opts.focus = argv[++i] ?? "";
		} else if (arg === "--max-notes" || arg === "-n") {
			opts.maxNotes = Number.parseInt(argv[++i] ?? "0", 10) || 0;
		} else if (arg === "--out" || arg === "-o") {
			opts.outDir = argv[++i];
		} else if (!arg.startsWith("-") && !opts.vaultDir) {
			opts.vaultDir = arg;
		}
	}
	return opts;
}

export async function runCli(
	argv: string[],
	io: { log: (line: string) => void; error: (line: string) => void } = {
		log: (line) => console.log(line),
		error: (line) => console.error(line),
	},
): Promise<{ exitCode: number; result?: ExportResult }> {
	const opts = parseCliArgs(argv);

	if (opts.help) {
		io.log(
			[
				"Condensated Vault Exporter — Headless CLI",
				"",
				"Usage:",
				"  npm run cli -- <vault-dir> [options]",
				"",
				"Options:",
				"  -p, --profile <id>     Profile id (notebooklm, chat-context, claude-xml, rag-chunks, study-guide, mirror, archive)",
				"  -f, --format <fmt>     Override format (markdown, html, plain, json, jsonl, xml)",
				"  -q, --focus <query>    Topic focus & operators (e.g. '\"rank fusion\" tag:research hops:1')",
				"  -n, --max-notes <num>  Max notes to keep when using --focus (0 = no cap)",
				"  -o, --out <folder>     Override output folder relative to vault (or absolute path)",
				"      --redact           Scrub detected API keys, tokens & private keys in-place",
				"      --preview          Dry-run: print stats and report without writing files",
				"      --intel            Run Vault Intelligence audit (themes, hubs, phantoms, drift, schema, open tasks)",
				"      --json             Emit structured JSON output (useful with --intel or --preview)",
				"      --list-profiles    List built-in profiles and exit",
				"  -h, --help             Show this help message",
			].join("\n"),
		);
		return { exitCode: 0 };
	}

	if (opts.listProfiles) {
		for (const recipe of BUILTIN_PROFILES) {
			io.log(`${recipe.id.padEnd(16)} — ${recipe.name}: ${recipe.description}`);
		}
		return { exitCode: 0 };
	}

	if (!opts.vaultDir) {
		io.error("Error: missing <vault-dir>. Pass --help for usage.");
		return { exitCode: 1 };
	}

	const base = createBuiltinProfile(opts.profileId) ?? createDefaultProfiles()[0];
	const profile: ExportProfile = {
		...base,
		condensation: {
			...base.condensation,
			redactSecrets: opts.redact || Boolean(base.condensation.redactSecrets),
		},
		packaging: {
			...base.packaging,
			format: opts.format ?? base.packaging.format,
			includeKnowledgeMap: opts.intel ? true : base.packaging.includeKnowledgeMap,
			includeGlossary: opts.intel ? true : base.packaging.includeGlossary,
		},
		filters: {
			...base.filters,
			focus: opts.focus ? { query: opts.focus, maxNotes: opts.maxNotes } : base.filters.focus,
		},
		output: {
			...base.output,
			folder: opts.outDir ?? base.output.folder,
		},
	};

	const vault = new NodeFsVaultPort(opts.vaultDir);
	const sink = new NodeFsSinkPort(opts.vaultDir);
	const result = await runExport({ profile, mode: opts.preview ? "preview" : "export" }, { vault, sink });

	if (opts.intel && result.knowledgeMap) {
		const map = result.knowledgeMap as KnowledgeMap;
		if (opts.json) {
			io.log(JSON.stringify(map, null, 2));
		} else {
			io.log(
				knowledgeMapToMarkdown(map, {
					readingOrder: true,
					quality: true,
					topologyDiagram: true,
				}),
			);
		}
		return { exitCode: 0, result };
	}

	if (opts.json) {
		io.log(
			JSON.stringify(
				{
					profile: profile.name,
					stats: result.stats,
					warnings: result.warnings,
					written: result.written,
				},
				null,
				2,
			),
		);
		return { exitCode: 0, result };
	}

	io.log(
		`[${profile.name}] ${formatCount(result.stats.kept)}/${formatCount(result.stats.discovered)} notes · ${formatCount(
			result.stats.words,
		)} words · ~${formatCount(result.stats.tokens)} tokens · ${result.parts.length} part(s)`,
	);
	for (const warning of result.warnings) {
		io.log(`  ${warning}`);
	}
	if (!opts.preview && result.written.length > 0) {
		const totalBytes = result.parts.reduce((acc, p) => acc + p.chars, 0);
		io.log(`Wrote ${result.written.length} file(s) (${formatBytes(totalBytes)}):`);
		for (const written of result.written) {
			io.log(`  → ${written}`);
		}
	}
	return { exitCode: 0, result };
}

const isMain =
	typeof process !== "undefined" &&
	Array.isArray(process.argv) &&
	process.argv[1] &&
	(process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("cli.js"));

if (isMain) {
	void runCli(process.argv.slice(2)).then(({ exitCode }) => {
		if (exitCode !== 0) process.exitCode = exitCode;
	});
}
