import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// The real `obsidian` package ships typings only (no runtime entry), so
		// tests resolve it to a faithful in-repo stand-in.
		alias: {
			obsidian: fileURLToPath(new URL("./tests/obsidianMock.ts", import.meta.url)),
		},
	},
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
		globals: false,
		reporters: ["default"],
	},
});
