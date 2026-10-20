/**
 * `Bun.build` replacement over esbuild.
 *
 * The build scripts used Bun's in-process bundler with esbuild-shaped plugins
 * (`onResolve` / `onLoad`). esbuild implements that same plugin contract, so the
 * adapter mostly translates option names (`target: "bun"` → Node, Bun's `minify`
 * object → esbuild booleans) and the result shape.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as esbuild from "esbuild";
import type { BunPluginSpec } from "./module-hooks";

/** Plugin contract shared with the runtime hook adapter. */
export type BuildPlugin = BunPluginSpec;

export interface BuildOptions {
	entrypoints: string[];
	outdir?: string;
	outfile?: string;
	root?: string;
	target?: "bun" | "node" | "browser" | string;
	format?: esbuild.Format;
	platform?: "node" | "browser" | "neutral";
	splitting?: boolean;
	sourcemap?: boolean | "inline" | "external" | "linked" | "none";
	minify?: boolean | { whitespace?: boolean; syntax?: boolean; identifiers?: boolean; keepNames?: boolean };
	external?: string[];
	define?: Record<string, string>;
	loader?: Record<string, esbuild.Loader>;
	plugins?: BuildPlugin[];
	naming?: string | { entry?: string; chunk?: string; asset?: string };
	throw?: boolean;
	banner?: { js?: string; css?: string };
	logLevel?: esbuild.LogLevel;
	metafile?: boolean;
}

export interface BuildOutputFile {
	path: string;
	text(): Promise<string>;
	kind: "entry-point" | "chunk" | "asset";
}

export interface BuildOutput {
	success: boolean;
	outputs: BuildOutputFile[];
	logs: { message: string; level: "error" | "warning" | "info" | "debug" | "verbose" }[];
}

/** Bun's `with { type: "file" }` import attribute; esbuild rejects it. */
const FILE_IMPORT_ATTRIBUTE = /(\bfrom\s*)(["'])([^"']+)\2(\s+with\s*\{\s*type:\s*["']file["']\s*\})/g;
/** Bun's `with { type: "text" }` import attribute; esbuild rejects it too. */
const TEXT_IMPORT_ATTRIBUTE = /(\bfrom\s*)(["'])([^"']+)\2(\s+with\s*\{\s*type:\s*["']text["']\s*\})/g;
/** Marks an asset specifier for the plugin namespace that emits it as a file. */
const FILE_ASSET_QUERY = "?omp-file-asset";
const FILE_ASSET_NAMESPACE = "omp-file-asset";
/** Marks a text specifier for the plugin namespace that emits its contents as a string. */
const TEXT_ASSET_QUERY = "?omp-text-asset";
const TEXT_ASSET_NAMESPACE = "omp-text-asset";

const SOURCE_LOADER_BY_EXTENSION: Record<string, esbuild.Loader> = {
	".ts": "ts",
	".mts": "ts",
	".cts": "ts",
	".tsx": "tsx",
	".js": "js",
	".mjs": "js",
	".cjs": "js",
	".jsx": "jsx",
};

/**
 * Bun's bundler resolved `with { type: "file" }` imports as emitted asset files
 * and `with { type: "text" }` imports as source strings; esbuild supports
 * neither attribute. Rewrite each to a private query, resolve it into a
 * namespace whose loader matches Bun's behavior, and leave every other module to
 * the normal loader.
 */
function importAttributePlugin(): esbuild.Plugin {
	return {
		name: "omp-import-attribute",
		setup(build) {
			build.onResolve({ filter: /\?omp-file-asset$/ }, args => ({
				path: path.resolve(args.resolveDir, args.path.slice(0, -FILE_ASSET_QUERY.length)),
				namespace: FILE_ASSET_NAMESPACE,
			}));
			build.onResolve({ filter: /\?omp-text-asset$/ }, args => ({
				path: path.resolve(args.resolveDir, args.path.slice(0, -TEXT_ASSET_QUERY.length)),
				namespace: TEXT_ASSET_NAMESPACE,
			}));
			build.onLoad({ filter: /.*/, namespace: FILE_ASSET_NAMESPACE }, async args => ({
				contents: await fs.readFile(args.path),
				loader: "file",
			}));
			build.onLoad({ filter: /.*/, namespace: TEXT_ASSET_NAMESPACE }, async args => ({
				contents: await fs.readFile(args.path, "utf8"),
				loader: "text",
			}));
			build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
				const source = await fs.readFile(args.path, "utf8");
				const hasFileAttribute = source.includes('type: "file"') || source.includes("type: 'file'");
				const hasTextAttribute = source.includes('type: "text"') || source.includes("type: 'text'");
				if (!hasFileAttribute && !hasTextAttribute) return undefined;
				return {
					contents: source
						.replace(
							FILE_IMPORT_ATTRIBUTE,
							(_match, from: string, quote: string, specifier: string) =>
								`${from}${quote}${specifier}${FILE_ASSET_QUERY}${quote}`,
						)
						.replace(
							TEXT_IMPORT_ATTRIBUTE,
							(_match, from: string, quote: string, specifier: string) =>
								`${from}${quote}${specifier}${TEXT_ASSET_QUERY}${quote}`,
						),
					loader: SOURCE_LOADER_BY_EXTENSION[path.extname(args.path)] ?? "js",
				};
			});
		},
	};
}

/**
 * Bun's ESM runtime exposes `require`; Node's does not. esbuild's dynamic-require
 * helper reads a global `require`, so a Node-targeted ESM bundle needs one bound
 * to the bundle's own URL to run at all.
 */
const NODE_ESM_REQUIRE_BANNER =
	'import { createRequire as __ompCreateRequire } from "node:module";\nconst require = __ompCreateRequire(import.meta.url);';

/** Bundle entrypoints with esbuild, returning Bun's `BuildOutput` shape. */
export async function build(options: BuildOptions): Promise<BuildOutput> {
	const minify = typeof options.minify === "object" ? true : (options.minify ?? false);
	const keepNames = typeof options.minify === "object" ? (options.minify.keepNames ?? false) : false;
	// Bun's `target` names a platform; map it there and give esbuild a language level.
	const platform = options.platform ?? (options.target === "browser" ? "browser" : "node");
	const target =
		options.target === undefined ||
		options.target === "bun" ||
		options.target === "node" ||
		options.target === "browser"
			? platform === "browser"
				? "es2022"
				: "node22"
			: options.target;
	// The repository's `BunPluginSpec` mirrors esbuild's plugin contract field for
	// field; the cast bridges the two nominal option-bag types.
	const plugins = options.plugins as unknown as esbuild.Plugin[] | undefined;
	// Bun's `naming` was a complete file name; esbuild's `entryNames` is a
	// template and appends its own extension, so a literal "cli.js" became
	// "cli.js.js". Split the suffix into `outExtension`.
	const literalNaming = typeof options.naming === "string" ? options.naming : undefined;
	const namingExtension = literalNaming === undefined ? undefined : /\.((?:m|c)?js|css)$/i.exec(literalNaming)?.[1];
	const entryNames =
		literalNaming === undefined
			? typeof options.naming === "object"
				? options.naming?.entry
				: undefined
			: namingExtension
				? literalNaming.slice(0, -(namingExtension.length + 1))
				: literalNaming;
	// Without an output location esbuild still needs a configured path for CSS
	// and other assets; point it at a scratch directory, suppress the writes, and
	// hand the artifacts back from memory.
	const inMemory = !options.outdir && !options.outfile;
	const format = options.format ?? "esm";
	const banner =
		format === "esm" && platform !== "browser"
			? { ...options.banner, js: [NODE_ESM_REQUIRE_BANNER, options.banner?.js].filter(Boolean).join("\n") }
			: options.banner;
	const scratchOutdir = inMemory
		? path.join(os.tmpdir(), `omp-build-${process.pid}-${Date.now().toString(36)}`)
		: options.outdir;
	try {
		const result = await esbuild.build({
			entryPoints: options.entrypoints,
			outdir: scratchOutdir,
			outfile: options.outfile,
			absWorkingDir: options.root,
			bundle: true,
			format,
			platform,
			// Bun's bundler preferred ESM entry points; esbuild's Node default is
			// "main" first, which picks UMD builds whose dynamic `require()` calls
			// esbuild leaves to the runtime (jsonc-parser, for one).
			mainFields: platform === "browser" ? ["browser", "module", "main"] : ["module", "main"],
			target,
			// Bun parsed tsconfig `target: "ES2025"`; esbuild rejects it as an
			// unknown environment. `tsconfigRaw` merges over the file's options, so
			// only the language level is normalized here.
			tsconfigRaw: { compilerOptions: { target: "esnext" } },
			// Bun's bundler left runtime-resolved `import(expr, options)` calls
			// alone without a diagnostic; esbuild warns they cannot be analyzed.
			logOverride: { "unsupported-dynamic-import": "silent" },
			splitting: options.splitting ?? false,
			sourcemap: options.sourcemap === "none" || options.sourcemap === undefined ? false : options.sourcemap,
			minify,
			keepNames,
			external: options.external,
			define: options.define,
			loader: options.loader,
			banner,
			// Last, so a caller's own onLoad hooks see the untouched source first.
			plugins: [...(plugins ?? []), importAttributePlugin()],
			entryNames,
			outExtension: namingExtension ? { ".js": `.${namingExtension}` } : undefined,
			chunkNames: typeof options.naming === "object" ? options.naming?.chunk : undefined,
			assetNames: typeof options.naming === "object" ? options.naming?.asset : undefined,
			logLevel: options.logLevel ?? "silent",
			metafile: options.metafile ?? true,
			write: !inMemory,
		});
		const logs = [
			...result.errors.map(error => ({ message: describeMessage(error), level: "error" as const })),
			...result.warnings.map(warning => ({ message: describeMessage(warning), level: "warning" as const })),
		];
		const outputs: BuildOutputFile[] = inMemory
			? (result.outputFiles ?? []).map(file => ({
					path: file.path,
					kind: file.path.endsWith(".js") ? ("entry-point" as const) : ("asset" as const),
					text: async () => file.text,
				}))
			: Object.entries(result.metafile?.outputs ?? {}).map(([outputPath, info]) => {
					// esbuild keys metafile outputs relative to `absWorkingDir`; callers
					// (and the bundle they launch) need absolute paths. The extension
					// cannot distinguish an entry point from a `file`-loader asset
					// chunk, so read esbuild's own `entryPoint` marker.
					const absolute = path.resolve(options.root ?? process.cwd(), outputPath);
					return {
						path: absolute,
						kind: info.entryPoint === undefined ? ("asset" as const) : ("entry-point" as const),
						text: () => fs.readFile(absolute, "utf8"),
					};
				});
		return { success: result.errors.length === 0, outputs, logs };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { success: false, outputs: [], logs: [{ message, level: "error" }] };
	}
}

function describeMessage(message: esbuild.Message): string {
	const location = message.location;
	const where = location ? `${location.file}:${location.line}:${location.column}: ` : "";
	return `${where}${message.text}`;
}
