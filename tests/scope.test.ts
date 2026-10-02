import { describe, expect, it } from "vitest";

import { neighbourhoodScope } from "../src/core/scope";
import { fakeVault, makeFile } from "./helpers";

function vaultWith(files: { path: string; content: string }[]) {
	return fakeVault(files.map((file) => makeFile(file.path, file.content)));
}

describe("neighbourhood scope", () => {
	const files = [
		{ path: "moc.md", content: "# MOC\n\n- [[alpha]]\n- [[beta|B]]\n" },
		{ path: "alpha.md", content: "# Alpha\n\nLinks to [[gamma]].\n" },
		{ path: "beta.md", content: "# Beta\n\nNothing here.\n" },
		{ path: "gamma.md", content: "# Gamma\n\nDeep note.\n" },
		{ path: "orphan.md", content: "# Orphan\n\nNo links at all.\n" },
		{ path: "backlink.md", content: "# Backlink\n\nPoints at [[moc]].\n" },
	];

	it("follows links out and backlinks in", async () => {
		const vault = vaultWith(files);
		const oneHop = await neighbourhoodScope(vault, vault.files as never, { root: "moc.md", hops: 1 });
		expect(oneHop.paths).not.toBeNull();
		expect([...(oneHop.paths ?? [])].sort()).toEqual(["alpha.md", "backlink.md", "beta.md", "moc.md"]);

		const twoHops = await neighbourhoodScope(vault, vault.files as never, { root: "moc.md", hops: 2 });
		expect([...(twoHops.paths ?? [])].sort()).toEqual(["alpha.md", "backlink.md", "beta.md", "gamma.md", "moc.md"]);
		expect(twoHops.paths?.has("orphan.md")).toBe(false);
	});

	it("keeps only the root at zero hops", async () => {
		const vault = vaultWith(files);
		const none = await neighbourhoodScope(vault, vault.files as never, { root: "alpha.md", hops: 0 });
		expect([...(none.paths ?? [])]).toEqual(["alpha.md"]);
	});

	it("warns when the note is not in scope or has no links", async () => {
		const vault = vaultWith(files);
		const outside = await neighbourhoodScope(vault, vault.files as never, { root: "elsewhere.md", hops: 1 });
		expect(outside.paths).toBeNull();
		expect(outside.warnings.join(" ")).toContain("not in scope");

		const lonely = await neighbourhoodScope(vault, vault.files as never, { root: "orphan.md", hops: 1 });
		expect([...(lonely.paths ?? [])]).toEqual(["orphan.md"]);
		expect(lonely.warnings.join(" ")).toContain("no links inside the current scope");
	});

	it("resolves links by name, path and alias without leaving the scope", async () => {
		const vault = vaultWith([
			{ path: "notes/index.md", content: "# Index\n\n[[Projects/atlas]] and [[atlas|the alias]] and [md](notes/other.md) and [web](https://example.com)\n" },
			{ path: "Projects/atlas.md", content: "# Atlas\n" },
			{ path: "notes/other.md", content: "# Other\n" },
		]);
		const outcome = await neighbourhoodScope(vault, vault.files as never, { root: "notes/index.md", hops: 1 });
		expect([...(outcome.paths ?? [])].sort()).toEqual(["Projects/atlas.md", "notes/index.md", "notes/other.md"]);
	});

	it("survives an unreadable note and reports it", async () => {
		const vault = vaultWith(files);
		const original = vault.read.bind(vault);
		vault.read = async (path: string) => {
			// Alpha is the only note that links to gamma.
			if (path === "alpha.md") throw new Error("boom");
			return original(path);
		};
		const outcome = await neighbourhoodScope(vault, vault.files as never, { root: "moc.md", hops: 2 });
		expect(outcome.paths?.has("gamma.md")).toBe(false);
		expect(outcome.warnings.join(" ")).toContain("could not be read");
	});
});
