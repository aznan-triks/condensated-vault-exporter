/**
 * Test helpers: an in-memory vault, a memory sink and a profile builder.
 */

import { analyzeDocument } from "../src/core/markdown/analyzer";
import { normalizeProfile } from "../src/core/profiles";
import type { ExportProfile, SinkPort, SourceFile, VaultPort } from "../src/core/types";
import { normalizeVaultPath, fileExtension, baseName, parentFolder } from "../src/core/util";

export interface FakeFile {
	path: string;
	content: string;
	/** Overrides the automatic modification time. */
	mtime?: number;
	ctime?: number;
	binary?: boolean;
}

export function makeFile(path: string, content: string, options: Partial<FakeFile> = {}): FakeFile {
	return { path: normalizeVaultPath(path), content, mtime: options.mtime ?? Date.parse("2026-01-15T10:00:00Z"), ...options };
}

export function fakeVault(files: FakeFile[]): VaultPort & { files: FakeFile[]; reads: string[] } {
	const map = new Map(files.map((f) => [f.path, f]));
	const reads: string[] = [];
	return {
		files,
		reads,
		async listFiles(): Promise<SourceFile[]> {
			return files.map((file) => toSourceFile(file));
		},
		async read(path: string): Promise<string> {
			reads.push(path);
			const file = map.get(normalizeVaultPath(path));
			if (!file) throw new Error(`ENOENT: ${path}`);
			return file.content;
		},
		async readBinary(path: string): Promise<string> {
			const file = map.get(normalizeVaultPath(path));
			if (!file) throw new Error(`ENOENT: ${path}`);
			return Buffer.from(file.content).toString("base64");
		},
		async exists(path: string): Promise<boolean> {
			return map.has(normalizeVaultPath(path));
		},
	};
}

export function toSourceFile(file: FakeFile): SourceFile {
	const path = normalizeVaultPath(file.path);
	return {
		path,
		name: baseName(path),
		folder: parentFolder(path),
		ext: fileExtension(path),
		size: Buffer.byteLength(file.content, "utf8"),
		mtime: file.mtime ?? Date.parse("2026-01-15T10:00:00Z"),
		ctime: file.ctime ?? file.mtime ?? Date.parse("2026-01-15T10:00:00Z"),
	};
}

export function memorySink(): SinkPort & { written: Map<string, string> } {
	const written = new Map<string, string>();
	return {
		written,
		async write(path: string, content: string) {
			written.set(normalizeVaultPath(path), content);
			return normalizeVaultPath(path);
		},
	};
}

/** Creates a profile with the NotebookLM preset, overridable inline. */
export function testProfile(overrides: DeepPartial<ExportProfile> = {}): ExportProfile {
	const base = normalizeProfile({
		id: "notebooklm",
		name: "Test profile",
		...overrides,
	} as Partial<ExportProfile>);
	if (overrides.packaging?.chunking) base.packaging.chunking = { ...base.packaging.chunking, ...overrides.packaging.chunking };
	return base;
}

export type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends (infer U)[]
		? U[]
		: T[K] extends object
			? DeepPartial<T[K]>
			: T[K];
};

/** Analyzes a set of fake files the way the pipeline does (pass 1). */
export function analyzeAll(files: FakeFile[]) {
	return files.map((file) => analyzeDocument(toSourceFile(file), file.content));
}

export function collectWarnings(warnings: string[], pattern: RegExp): string[] {
	return warnings.filter((warning) => pattern.test(warning));
}
