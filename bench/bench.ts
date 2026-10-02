/**
 * Synthetic benchmark: how does the engine behave on a real-sized vault?
 *
 * Run with `npm run bench [note count]`. It reports wall-clock time, peak
 * memory and the size of the resulting bundle, which is the number that
 * matters when a run has to stay under a destination's limits.
 */
import { runExport } from "../src/core/pipeline";
import { createDefaultProfiles } from "../src/core/profiles";
import type { ExportProfile, VaultPort } from "../src/core/types";
import { normalizeVaultPath, fileExtension, baseName, parentFolder } from "../src/core/util";

const TOPICS = ["retrieval", "storage", "ranking", "ingestion", "evaluation", "tooling", "design", "ops"];

function buildVault(count: number): VaultPort & { bytes: number } {
	const files = new Map<string, { content: string; mtime: number; ctime: number }>();
	let bytes = 0;
	for (let i = 0; i < count; i++) {
		const topic = TOPICS[i % TOPICS.length];
		const folder = i % 5 === 0 ? "daily" : i % 3 === 0 ? "projects" : "notes";
		const paragraphs = Array.from({ length: 6 }, (_, p) => {
			const shared = p === 0 ? "This note belongs to the shared boilerplate block that every note repeats verbatim. " : "";
			return `${shared}Paragraph ${p} discusses ${topic} with concrete numbers like ${i * 7 + p}. It links to [[${folder}/other-${(i + 1) % count}]] and mentions #${topic}.`;
		});
		const content = `---\ntags: [${topic}, note]\n---\n# ${folder} note ${i}\n\n${paragraphs.join("\n\n")}\n`;
		const path = normalizeVaultPath(`${folder}/${topic}-${String(i).padStart(5, "0")}.md`);
		const now = Date.parse("2026-01-15T10:00:00Z") + i * 1000;
		files.set(path, { content, mtime: now, ctime: now });
		bytes += Buffer.byteLength(content, "utf8");
	}
	return {
		bytes,
		async listFiles() {
			return Array.from(files.entries()).map(([path, entry]) => ({
				path,
				name: baseName(path),
				folder: parentFolder(path),
				ext: fileExtension(path),
				size: Buffer.byteLength(entry.content, "utf8"),
				mtime: entry.mtime,
				ctime: entry.ctime,
			}));
		},
		async read(path: string) {
			const entry = files.get(path);
			if (!entry) throw new Error(`missing ${path}`);
			return entry.content;
		},
	};
}

function memoryMb(): number {
	return Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
}

async function main(): Promise<void> {
	const count = Number.parseInt(process.argv[2] ?? "1500", 10);
	const vault = buildVault(count);
	const sink = {
		written: 0,
		async write(_path: string, content: string) {
			this.written += content.length;
			return _path;
		},
	};
	console.log(`vault: ${count} notes, ${(vault.bytes / 1024 / 1024).toFixed(1)} MB of markdown`);
	for (const profile of createDefaultProfiles()) {
		global.gc?.();
		const before = memoryMb();
		const phaseMs: Record<string, number> = {};
		let lastPhase = "";
		let lastAt = performance.now();
		const started = performance.now();
		let result;
		try {
			result = await runExport(
				{ profile },
				{
					vault,
					sink,
					now: () => Date.now(),
					maxFileBytes: 8 * 1024 * 1024,
					onProgress: (event) => {
						const at = performance.now();
						if (lastPhase !== "") phaseMs[lastPhase] = (phaseMs[lastPhase] ?? 0) + (at - lastAt);
						lastPhase = event.phase;
						lastAt = at;
					},
				},
			);
		} catch (error) {
			console.log(`${profile.id.padEnd(14)} failed: ${String(error)}`);
			continue;
		}
		const elapsed = performance.now() - started;
		if (lastPhase !== "") phaseMs[lastPhase] = (phaseMs[lastPhase] ?? 0) + (performance.now() - lastAt);
		const peak = memoryMb();
		console.log(
			`${profile.id.padEnd(14)} ${elapsed.toFixed(0).padStart(5)} ms · ` +
				`${result.parts.length} part(s) · ${(result.stats.chars / 1024 / 1024).toFixed(2)} MB out · ` +
				`${result.stats.kept}/${result.stats.discovered} notes · ` +
				`heap ${before}→${peak} MB`,
		);
		if (process.env.BENCH_PHASES) {
			const phases = Object.entries(phaseMs)
				.map(([phase, ms]) => `${phase} ${ms.toFixed(0)}ms`)
				.join(" · ");
			console.log(`               ${phases}`);
		}
	}
}

void main();
