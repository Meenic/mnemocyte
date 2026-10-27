import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/postgres.ts",
		"src/embedders/*.ts",
		"src/stores/*.ts",
	],
	sourcemap: true,
	dts: { sourcemap: false },
	plugins: [
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
