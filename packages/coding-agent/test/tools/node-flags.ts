import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Node flags that let a child process import this repository's TypeScript
 * sources directly (extensionless specifiers, `with { type: "text" }` imports,
 * and type syntax). The previous runtime did this implicitly; Node needs the
 * loader.
 */
export const TS_CHILD_FLAGS: readonly string[] = [
	"--experimental-transform-types",
	"--import",
	pathToFileURL(path.resolve(import.meta.dirname, "../../../../scripts/node-runtime-loader.mjs")).href,
	"--import",
	pathToFileURL(path.resolve(import.meta.dirname, "../fixtures/runtime-shim.ts")).href,
];
