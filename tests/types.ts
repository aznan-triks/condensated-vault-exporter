/** Re-declares the bits of the Obsidian typings the fake app needs. */
export interface TFile {
	path: string;
	name: string;
	basename: string;
	extension: string;
	stat: { size: number; mtime: number; ctime: number };
}
export interface TFolder {
	path: string;
	name: string;
}
export interface Command {
	id: string;
	name: string;
}
export interface App {
	vault: unknown;
	workspace: unknown;
	plugins?: unknown;
}
