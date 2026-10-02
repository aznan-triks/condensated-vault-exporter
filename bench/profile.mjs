import { analyzeDocument } from "../src/core/markdown/analyzer.ts";
import { transformDocument } from "../src/core/markdown/transforms.ts";
import { detectDuplicates } from "../src/core/condense/dedupe.ts";
import { createDefaultProfiles } from "../src/core/profiles.ts";

const N = Number(process.argv[2] ?? 3000);
const files = Array.from({ length: N }, (_, i) => {
	const topic = ["retrieval", "storage", "ranking"][i % 3];
	return {
		path: `notes/n${i}.md`,
		content: `---\ntags: [${topic}]\n---\n# Note ${i}\n\n${Array.from({ length: 6 }, (_, p) => `Paragraph ${p} about ${topic} with numbers ${i * 7 + p} and links [[notes/x]] plus more words to fill the note.`).join("\n\n")}\n`,
	};
});
const time = (label, fn) => {
	const t = performance.now();
	const out = fn();
	console.log(label.padEnd(22), (performance.now() - t).toFixed(0).padStart(6), "ms");
	return out;
};
const analyses = time("analyze", () => files.map((f) => analyzeDocument({ path: f.path, name: f.path, folder: "notes", ext: "md", size: f.content.length, mtime: 1, ctime: 1 }, f.content)));
const profile = createDefaultProfiles().find((p) => p.id === "notebooklm");
time("transform", () => files.map((f) => transformDocument(f.content, profile.transform, { format: "markdown", path: f.path, title: f.path, transclusion: { depth: 2, maxChars: 4000 }, boilerplate: null })));
time("dedupe", () => detectDuplicates(analyses, profile.condensation.dedupe, {}));
