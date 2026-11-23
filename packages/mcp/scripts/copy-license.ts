// Copies the repository's LICENSE into the package before `pnpm pack` and
// `pnpm publish` (the `prepack` script). The copy is gitignored.
import { copyFileSync } from "node:fs";

copyFileSync(
	new URL("../../../LICENSE", import.meta.url),
	new URL("../LICENSE", import.meta.url),
);
