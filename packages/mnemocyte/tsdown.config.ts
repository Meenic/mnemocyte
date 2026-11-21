import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/ai-sdk.ts",
		"src/cli.ts",
		"src/postgres.ts",
		"src/libsql.ts",
		"src/store.ts",
		"src/store-test.ts",
		"src/embedders/*.ts",
	],
	// tsconfig.json covers the tests and config files for the editor; the
	// build reads only the settings for src/.
	tsconfig: "tsconfig.build.json",
	sourcemap: true,
	dts: { sourcemap: false },
	plugins: [
		{
			// The bin is not an export, so its declaration file would be an
			// empty `export {}` that nothing references.
			name: "drop-cli-declarations",
			generateBundle(_options, bundle) {
				delete bundle["cli.d.mts"];
			},
		},
		{
			// With `sourcemap` on, every chunk gets a sourceMappingURL comment,
			// but rolldown-plugin-dts drops the .d.mts maps without removing it.
			name: "strip-dts-map-comment",
			generateBundle(_options, bundle) {
				for (const chunk of Object.values(bundle)) {
					if (chunk.type === "chunk" && chunk.fileName.endsWith(".d.mts")) {
						chunk.code = chunk.code.replace(
							/\/\/# sourceMappingURL=\S+\s*$/,
							"",
						);
					}
				}
			},
		},
	],
});
