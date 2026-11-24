// What the `mnemocyte` CLI and `mnemocyte-mcp` share to read an app's env
// files and load its memory file. This package is private: both list it as
// a devDependency and tsdown bundles it into their dist/ (ARCHITECTURE
// decision 93).

export { type LoadEnvFilesInput, loadEnvFiles } from "./env-files.js";
export {
	findMemoryFile,
	MEMORY_FILE_DIRECTORIES,
	MEMORY_FILE_NAMES,
} from "./memory-file.js";
export { registerAppResolver } from "./resolve-hook.js";
