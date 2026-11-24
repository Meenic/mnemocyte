import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/cli.ts"],
	// tsconfig.json covers the tests and config files for the editor; the
	// build reads only the settings for src/.
	tsconfig: "tsconfig.build.json",
	sourcemap: true,
	dts: { sourcemap: false },
	plugins: [
		{
			// The empty module the bundled loader maps `server-only` to
			// (SERVER_ONLY_FILE in packages/loader/src/resolve-hook.ts).
			name: "server-only-stub",
			generateBundle() {
				this.emitFile({
					type: "asset",
					fileName: "server-only.cjs",
					source:
						"// Empty on purpose: the bin loads this file in place of React's\n// server-only package, which throws outside React Server Components.\n",
				});
			},
		},
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
