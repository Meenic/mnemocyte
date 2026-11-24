// What the `mnemocyte` CLI and `mnemocyte-mcp` share to load an app's
// memory file. This package is private: both list it as a devDependency
// and tsdown bundles it into their dist/ (ARCHITECTURE decision 93).

export {
	findMemoryFile,
	MEMORY_FILE_DIRECTORIES,
	MEMORY_FILE_NAMES,
} from "./memory-file.js";
export { registerAppResolver } from "./resolve-hook.js";
