import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Node flags that let a spawned child load this repository's TypeScript
 * sources: `--experimental-transform-types` strips types, and the repository
 * loader resolves extensionless relative specifiers and text imports.
 * `--expose-gc` makes `bun.gc()` collect, which the retention fixture relies on.
 */
const NODE_TS_FLAGS = [
	"--no-warnings",
	"--experimental-transform-types",
	"--expose-gc",
	"--import",
	pathToFileURL(path.resolve(import.meta.dirname, "../../../../scripts/node-runtime-loader.mjs")).href,
];

/** `process.execPath` plus {@link NODE_TS_FLAGS} and the given script arguments. */
export function nodeTsArgs(...args: string[]): string[] {
	return [process.execPath, ...NODE_TS_FLAGS, ...args];
}
