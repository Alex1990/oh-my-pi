/**
 * `Bun.plugin` replacement on top of Node's synchronous module hooks.
 *
 * Bun bundled its own loader and let packages register `onResolve` / `onLoad`
 * hooks (`Bun.plugin`). Node exposes the same interception point through
 * `module.registerHooks()`; this module adapts Bun's registration shape onto it.
 *
 * Hooks are process-global and installed once, mirroring Bun's semantics.
 */
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Transpiler } from "./transpiler";

export interface OnResolveArgs {
	path: string;
	importer: string;
	namespace: string;
	kind: string;
	/** Directory of the importing module, as esbuild reports it. */
	resolveDir: string;
}

export interface OnResolveResult {
	path?: string;
	namespace?: string;
	external?: boolean;
}

export interface OnLoadArgs {
	path: string;
	namespace: string;
}

export interface OnLoadResult {
	contents?: string | Uint8Array;
	loader?: "js" | "jsx" | "ts" | "tsx" | "json" | "text" | "css" | "file" | "object";
	/**
	 * Module namespace served by Bun's `loader: "object"` shape. Node's module
	 * hooks can only return source text, so the adapter regenerates an ESM
	 * module whose exports snapshot these values (Bun's object loader also
	 * snapshots).
	 */
	exports?: Record<string, unknown>;
}

/**
 * Bun's `onLoad` may return a promise. Node's synchronous `registerHooks` load
 * hook cannot await it, so asynchronous results fall through to Node's native
 * loader (with a one-time warning).
 */
export type OnLoadResultValue = OnLoadResult | Promise<OnLoadResult | null | undefined> | null | undefined;

interface PluginBuilder {
	onResolve(
		options: { filter: RegExp; namespace?: string },
		callback: (
			args: OnResolveArgs,
		) => OnResolveResult | Promise<OnResolveResult | undefined | null> | undefined | null,
	): void;
	/**
	 * Delegates to the bundler's resolver. Only available while building (esbuild
	 * plugin path); the runtime hook adapter has no resolver to call.
	 */
	resolve?(
		specifier: string,
		options?: { resolveDir?: string; kind?: string },
	): Promise<{ path?: string; errors: { text: string }[] }>;
	onLoad(
		options: { filter: RegExp; namespace?: string },
		callback: (args: OnLoadArgs) => OnLoadResultValue | Promise<OnLoadResult>,
	): void;
	/**
	 * Bun's `build.module(name, loader)` virtual module. The runtime adapter
	 * serves the loader result from the {@link VIRTUAL_MODULE_NAMESPACE}
	 * namespace so an exact bare specifier resolves to it from anywhere.
	 */
	module(name: string, loader: () => OnLoadResult | Promise<OnLoadResult>): void;
}

export interface BunPluginSpec {
	name: string;
	setup(build: PluginBuilder): void;
}

/** Bun's name for a bundler plugin object. */
export type BunPlugin = BunPluginSpec;

interface ResolveHook {
	filter: RegExp;
	namespace: string | undefined;
	callback: (args: OnResolveArgs) => OnResolveResult | Promise<OnResolveResult | undefined | null> | undefined | null;
}

interface LoadHook {
	filter: RegExp;
	namespace: string | undefined;
	callback: (args: OnLoadArgs) => OnLoadResultValue;
}

const resolveHooks: ResolveHook[] = [];
const loadHooks: LoadHook[] = [];
let hooksInstalled = false;
let warnedAsyncOnLoad = false;

const OBJECT_EXPORTS_REGISTRY = Symbol.for("oh-my-pi.module-hooks.exports");
const EXPORT_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Namespace serving `build.module()` virtual modules to the native loader. */
const VIRTUAL_MODULE_NAMESPACE = "omp-virtual";

/** Registry backing generated `loader: "object"` modules (same realm as the loaded module). */
function objectExportsRegistry(): Map<string, Record<string, unknown>> {
	let registry = Reflect.get(globalThis, OBJECT_EXPORTS_REGISTRY) as Map<string, Record<string, unknown>> | undefined;
	if (!registry) {
		registry = new Map();
		Reflect.set(globalThis, OBJECT_EXPORTS_REGISTRY, registry);
	}
	return registry;
}

/**
 * Render an ESM module that snapshots a Bun `loader: "object"` namespace.
 * Values are read from a realm-global registry, matching Bun's snapshot
 * semantics (the object is materialized before the module evaluates).
 */
function renderObjectModule(url: string, exports: Record<string, unknown>): string {
	objectExportsRegistry().set(url, exports);
	const lookup = `globalThis[Symbol.for("oh-my-pi.module-hooks.exports")].get(${JSON.stringify(url)})`;
	const lines = [`const __ompModule = ${lookup};`];
	const bindings: string[] = [];
	for (const name of Object.keys(exports)) {
		if (name === "default") continue;
		const binding = `__ompExport${bindings.length}`;
		lines.push(`const ${binding} = __ompModule[${JSON.stringify(name)}];`);
		bindings.push(EXPORT_IDENTIFIER.test(name) ? `${binding} as ${name}` : `${binding} as ${JSON.stringify(name)}`);
	}
	if (bindings.length > 0) lines.push(`export { ${bindings.join(", ")} };`);
	if (Object.hasOwn(exports, "default")) lines.push("export default __ompModule.default;");
	return `${lines.join("\n")}\n`;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
	if (typeof value !== "object" || value === null) return false;
	return "then" in value && typeof value.then === "function";
}

function warnAsyncOnLoad(): void {
	if (warnedAsyncOnLoad) return;
	warnedAsyncOnLoad = true;
	process.emitWarning(
		"Asynchronous onLoad hooks cannot run through Node's synchronous module hooks; falling back to Node's native loader.",
		{ code: "OMP_ASYNC_ONLOAD_UNSUPPORTED" },
	);
}

const LOADER_FORMAT: Record<string, "module" | "module-typescript" | "commonjs" | "json"> = {
	js: "module",
	jsx: "module",
	// Node parses `module-typescript` through its type stripper; plain "module"
	// would hand raw TypeScript to the JavaScript parser.
	ts: "module-typescript",
	tsx: "module-typescript",
	json: "json",
};

/**
 * Resource extensions imported `with { type: "text" }`.
 *
 * esbuild's transform drops import attributes, so the native loader sees a
 * plain `.md` module and rejects it. Serve these as string-default ESM.
 */
const TEXT_MODULE_EXTENSIONS = new Set([
	".md",
	".txt",
	".py",
	".lark",
	".sh",
	".plist",
	".html",
	".css",
	".rb",
	".jl",
	".applescript",
]);

/**
 * Full TypeScript transpilers for files served to Node's loader.
 *
 * Node's type stripping rejects syntax that needs code generation (parameter
 * properties, enums, namespaces), which the workspace packages use. Hook
 * results and untouched `.ts` files reached through the native loader are
 * transpiled with esbuild instead of relying on strip-only mode.
 */
const TYPESCRIPT_TRANSPILERS: Record<string, Transpiler> = {
	".ts": new Transpiler({ loader: "ts" }),
	".mts": new Transpiler({ loader: "ts" }),
	".cts": new Transpiler({ loader: "ts" }),
	".tsx": new Transpiler({ loader: "tsx" }),
};

function transpileTypeScriptSource(filePath: string, source: string): string | undefined {
	const queryIndex = filePath.indexOf("?");
	const cleanPath = queryIndex === -1 ? filePath : filePath.slice(0, queryIndex);
	const dot = cleanPath.lastIndexOf(".");
	if (dot === -1) return undefined;
	const transpiler = TYPESCRIPT_TRANSPILERS[cleanPath.slice(dot)];
	return transpiler?.transformSync(source);
}

function ensureHooksInstalled(): void {
	if (hooksInstalled) return;
	hooksInstalled = true;
	// The hooks stay installed under Vitest so suites that exercise legacy
	// extension loading (which spawns `node -e` children inheriting this
	// environment) still resolve through them. The filters registered by the
	// callers are specifier/path specific, so they do not intercept the test
	// runner's own worker modules.
	registerHooks({
		resolve(specifier, context, nextResolve) {
			// An `onResolve` hook's `namespace` restricts the *importer*: Bun only
			// consults a hook for modules loaded from that namespace. Derive it from
			// the parent URL, so a catch-all hook scoped to a virtual namespace does
			// not intercept every specifier in the process.
			const importerScheme = context.parentURL?.slice(0, context.parentURL.indexOf(":"));
			const importerNamespace = !importerScheme || importerScheme === "file" ? "file" : importerScheme;
			for (const hook of resolveHooks) {
				if (hook.namespace !== undefined && hook.namespace !== importerNamespace) continue;
				if (!hook.filter.test(specifier)) continue;
				const isFileParent = context.parentURL?.startsWith("file:") === true;
				const result = hook.callback({
					path: specifier,
					// Bun hands hooks filesystem paths; Node gives the parent module URL.
					importer:
						isFileParent && context.parentURL ? fileURLToPath(context.parentURL) : (context.parentURL ?? ""),
					namespace: importerNamespace,
					kind: context.conditions?.includes("require") ? "require-call" : "import-statement",
					// Virtual namespaces have opaque URLs (`omp-legacy-pi-host:key`),
					// for which `new URL(".", …)` is not resolvable. Their hooks work
					// on the registry key, so the cwd is the only meaningful fallback.
					resolveDir:
						isFileParent && context.parentURL ? fileURLToPath(new URL(".", context.parentURL)) : process.cwd(),
				});
				// Runtime hooks are synchronous: an async resolver cannot be awaited here.
				if (isPromiseLike(result)) {
					void Promise.resolve(result).catch(() => {});
					continue;
				}
				if (!result?.path) continue;
				if (result.external) return { url: result.path, shortCircuit: true };
				const namespace = result.namespace ?? hook.namespace ?? "file";
				if (namespace !== "file") return { url: `${namespace}:${result.path}`, shortCircuit: true };
				// A resolve hook may append Bun's `?mtime=` cache-busting query to a
				// filesystem path. `pathToFileURL` would encode the `?`, so split the
				// query off and reattach it as a URL search component.
				const queryIndex = result.path.indexOf("?");
				const filePath = queryIndex === -1 ? result.path : result.path.slice(0, queryIndex);
				const query = queryIndex === -1 ? "" : result.path.slice(queryIndex);
				return { url: `${pathToFileURL(filePath).href}${query}`, shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
		load(url, context, nextLoad) {
			const scheme = url.slice(0, url.indexOf(":"));
			const isFile = scheme === "file";
			const resourcePath = isFile ? `${fileURLToPath(url)}${new URL(url).search}` : url.slice(scheme.length + 1);
			// Bun's resource import attributes: `type: "file"` yields the path
			// string, `type: "text"` the file contents. Node has no equivalent and
			// rejects unknown attribute types, so serve them before any hook (or
			// the native loader) sees the module.
			if (isFile) {
				const attributeType = context.importAttributes?.type;
				const cleanPath = resourcePath.includes("?")
					? resourcePath.slice(0, resourcePath.indexOf("?"))
					: resourcePath;
				if (attributeType === "file") {
					return {
						format: "module",
						source: `export default ${JSON.stringify(cleanPath)};`,
						shortCircuit: true,
					};
				}
				if (attributeType === "text") {
					return {
						format: "module",
						source: `export default ${JSON.stringify(readFileSync(cleanPath, "utf8"))};`,
						shortCircuit: true,
					};
				}
			}
			let asyncFallback = false;
			for (const hook of loadHooks) {
				if (hook.namespace && hook.namespace !== (isFile ? "file" : scheme)) continue;
				if (!hook.filter.test(isFile ? resourcePath : url)) continue;
				const result = hook.callback({ path: resourcePath, namespace: isFile ? "file" : scheme });
				if (isPromiseLike(result)) {
					// Drain the rejection so a hook that still returns a promise cannot
					// surface as an unhandled rejection; Node's native loader takes over.
					void Promise.resolve(result).catch(() => {});
					warnAsyncOnLoad();
					asyncFallback = true;
					continue;
				}
				if (!result) continue;
				if (result.exports) {
					return { format: "module", source: renderObjectModule(url, result.exports), shortCircuit: true };
				}
				if (!result.contents) continue;
				const transpiled = transpileTypeScriptSource(
					resourcePath,
					typeof result.contents === "string" ? result.contents : Buffer.from(result.contents).toString("utf8"),
				);
				if (transpiled !== undefined) {
					return { format: "module", source: transpiled, shortCircuit: true };
				}
				return {
					format: LOADER_FORMAT[result.loader ?? "js"] ?? "module",
					source: result.contents,
					shortCircuit: true,
				};
			}
			// Node's default loader rejects unknown schemes. A plugin whose only
			// handler is async cannot serve this module, so degrade to an empty stub
			// instead of aborting the host process.
			if (asyncFallback && scheme !== "file" && scheme !== "data" && scheme !== "node") {
				process.emitWarning(`[omp-module-hooks] async onLoad for ${url}; serving an empty module`);
				return { format: "module", source: "export default undefined;", shortCircuit: true };
			}
			if (asyncFallback) {
				process.emitWarning(`[omp-module-hooks] async onLoad for file ${url}; falling through`);
			}
			if (isFile) {
				const cleanPath = resourcePath.includes("?")
					? resourcePath.slice(0, resourcePath.indexOf("?"))
					: resourcePath;
				// esbuild's transform drops import attributes, so a transpiled
				// `import ... with { type: "json" }` reaches Node without one.
				// Serve JSON from the loader directly instead of rejecting it.
				if (cleanPath.endsWith(".json")) {
					return { format: "json", source: readFileSync(cleanPath, "utf8"), shortCircuit: true };
				}
				const resourceExtension = nodePath.extname(cleanPath);
				if (TEXT_MODULE_EXTENSIONS.has(resourceExtension)) {
					const contents = readFileSync(cleanPath, "utf8");
					return {
						format: "module",
						source: `export default ${JSON.stringify(contents)};`,
						shortCircuit: true,
					};
				}
				if (/\.[cm]?tsx?$/.test(cleanPath)) {
					const transpiled = transpileTypeScriptSource(cleanPath, readFileSync(cleanPath, "utf8"));
					if (transpiled !== undefined) {
						return { format: "module", source: transpiled, shortCircuit: true };
					}
				}
			}
			return nextLoad(url, context);
		},
	});
}

/** Register loader hooks, matching `plugin(spec)`. */
export function plugin(spec: BunPluginSpec): void {
	ensureHooksInstalled();
	const builder: PluginBuilder = {
		onResolve(options, callback) {
			resolveHooks.push({ filter: options.filter, namespace: options.namespace, callback });
		},
		onLoad(options, callback) {
			loadHooks.push({ filter: options.filter, namespace: options.namespace, callback });
		},
		module(name, loader) {
			const filter = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
			resolveHooks.push({
				filter,
				namespace: undefined,
				callback: () => ({ path: name, namespace: VIRTUAL_MODULE_NAMESPACE }),
			});
			loadHooks.push({
				filter: /.*/,
				namespace: VIRTUAL_MODULE_NAMESPACE,
				callback: () => loader(),
			});
		},
	};
	spec.setup(builder);
}
