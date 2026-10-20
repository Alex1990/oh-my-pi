import { constants as vmConstants, runInThisContext } from "node:vm";

const USE_MAIN_CONTEXT_DEFAULT_LOADER = vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER;

/**
 * Indirect eval — runs in the host's global scope, isolating bindings declared with
 * `const`/`let` from this module's closure. Used by both the JS eval worker and the
 * browser tab worker to execute user-supplied source without `node:vm`.
 *
 * Why not vm.runInContext: Bun crashes the parent process with SIGTRAP when
 * `Worker.terminate()` fires while a worker is mid-`vm.runInContext` synchronous loop.
 * Indirect eval does not trip that bug.
 *
 * The optional `filename` is appended as a `//# sourceURL=...` pragma so V8 attributes
 * stack frames to the user cell instead of `<anonymous>`.
 */
export function indirectEval(source: string, filename?: string): unknown {
	// ECMAScript line terminators would end the comment and turn the remainder
	// of an attacker-controlled filename into executable source. Encode only
	// those separators so ordinary absolute paths remain readable in stacks;
	// the runtime keeps the untouched filename separately for import bases.
	const sourceUrl = filename?.replace(/[\r\n\u2028\u2029]/g, separator => encodeURIComponent(separator));
	const withPragma = sourceUrl ? `${source}\n//# sourceURL=${sourceUrl}` : source;
	// `vm.runInThisContext` shares the global scope with indirect eval while
	// giving dynamic `import()` a module loader. Plain eval cannot: V8 rejects
	// `import()` there with "A dynamic import callback was not specified".
	return runInThisContext(withPragma, {
		filename: filename ?? "omp-eval",
		importModuleDynamically: USE_MAIN_CONTEXT_DEFAULT_LOADER,
	});
}

export async function awaitMaybePromise<T>(value: T | Promise<T>): Promise<T> {
	if (!value || typeof value !== "object" || typeof (value as { then?: unknown }).then !== "function") {
		return value;
	}
	return await (value as Promise<T>);
}
