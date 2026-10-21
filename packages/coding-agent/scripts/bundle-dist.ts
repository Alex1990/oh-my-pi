#!/usr/bin/env node

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { buildDocsIndexPayload } from "./generate-docs-index";
import { createBunImportAttributesPlugin } from "./import-attributes-plugin";
import { createJsonParsePlugin } from "./json-parse-plugin";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { build } from "@oh-my-pi/pi-utils/node-build";
import { isMainModule } from "@oh-my-pi/pi-utils/node-runtime";

const packageDir = path.join(import.meta.dirname, "..");

/** `with { type: "text" }` imports are inlined by esbuild's text loader. */
const TEXT_LOADERS = {
	".md": "text" as const,
	".txt": "text" as const,
	".py": "text" as const,
	".lark": "text" as const,
	".plist": "text" as const,
};
const defaultOutDir = path.join(packageDir, "dist");
const shebang = "#!/usr/bin/env node\n";
const htmlExportAssetPattern =
	/^(?:template-[^.]+\.(?:css|html|js)|tool-views\.generated-[^.]+\.js|(?:marked|highlight)\.min-[^.]+\.js)$/;

// Native / optional / platform-specific deps are loaded from installed files.
const ALWAYS_EXTERNAL = ["@oh-my-pi/pi-natives", "@huggingface/transformers", "fastembed", "onnxruntime-node"];

// Heavy, lazily-used third-party leaf deps. Each is a declared `dependency`, so the
// published package resolves it from node_modules at runtime; bundling only embeds a
// redundant copy that bloats dist/cli.js. NEVER add a patched dependency here — the
// bundle is where a root `patchedDependencies` patch is baked in, so an externalized
// import would load the unpatched npm package in users' installs (currently
// @ark/schema is patched, so it — and arktype, which pulls @ark/schema — stay
// bundled).
const RUNTIME_EXTERNAL = ["puppeteer-core", "@babel/parser", "prettier", "jsonc-parser"];

async function runCommand(command: string[]): Promise<void> {
	const proc = bun.spawn(command, {
		cwd: packageDir,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
}

async function ensureShebang(cliPath: string): Promise<void> {
	const text = await bun.file(cliPath).text();
	if (text.startsWith(shebang)) return;
	const withoutExisting = text.startsWith("#!") ? text.slice(text.indexOf("\n") + 1) : text;
	await bun.write(cliPath, shebang + withoutExisting);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

async function cleanBundleOutputs(outDir: string): Promise<void> {
	// dist/ is shared with the dev binary (dist/omp); only remove assets
	// emitted by this script.
	let entries: string[];
	try {
		entries = await fs.readdir(outDir);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	await Promise.all(
		entries
			.filter(
				entry =>
					entry === "cli.js" ||
					entry === "docs-index.generated.txt" ||
					entry.endsWith(".node") ||
					entry.endsWith(".js.map") ||
					/\.json-[^/]+\.zst$/.test(entry) ||
					(entry.startsWith("CHANGELOG-") && entry.endsWith(".md")) ||
					htmlExportAssetPattern.test(entry),
			)
			.map(entry => fs.rm(path.join(outDir, entry), { force: true })),
	);
}

/** Builds the npm CLI bundle into `outDir`; release scripts use the package `dist` directory by default. */
export async function bundleDist(outDir: string = defaultOutDir): Promise<void> {
	const cliPath = path.join(outDir, "cli.js");
	const start = bun.nanoseconds();
	await cleanBundleOutputs(outDir);
	// The npm bundle ships no stats dashboard sources, so embed the dashboard
	// archive the same way compiled binaries do (scripts/build-binary.ts). Reset
	// afterwards to keep the checked-in placeholder empty.
	await runCommand(["pnpm", "--dir", "../stats", "run", "gen:stats"]);
	// One payload for both consumers: inlined into dist/cli.js via `--define` for
	// the bundled CLI entrypoint, and written to dist/docs-index.generated.txt so
	// SDK consumers importing `@oh-my-pi/pi-coding-agent/*` (TypeScript source, no
	// build-time embed) can still resolve omp:// docs (see src/internal-urls/docs-index.ts).
	try {
		const docsPayload = await buildDocsIndexPayload();
		// Build in-process: the docs embed payload is far larger than Linux's
		// 128KiB per-argv-string cap, so it can never be passed as a CLI
		// `--define` (posix_spawn fails with E2BIG).
		const output = await build({
			entrypoints: [path.join(packageDir, "src/cli.ts")],
			outdir: outDir,
			target: "node",
			banner: {
				js: [
					'import { fileURLToPath as __ompFileURLToPath } from "node:url";',
					'import { dirname as __ompDirname } from "node:path";',
					"const __filename = __ompFileURLToPath(import.meta.url);",
					"const __dirname = __ompDirname(__filename);",
				].join("\n"),
			},
			loader: TEXT_LOADERS,
			plugins: [
				createJsonParsePlugin(),
				await createLegacyPiVirtualModulePlugin(),
				createBunImportAttributesPlugin(),
			],
			external: [...ALWAYS_EXTERNAL, ...RUNTIME_EXTERNAL],
			define: {
				"process.env.PI_BUNDLED": JSON.stringify("true"),
				"process.env.PI_DOCS_EMBED": JSON.stringify(docsPayload.payload),
			},
			minify: {
				whitespace: true,
				syntax: true,
				identifiers: true,
				keepNames: true,
			},
			throw: false,
		});
		if (!output.success) {
			throw new Error(`CLI bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
		}
		await ensureShebang(cliPath);
		await bun.write(path.join(outDir, "docs-index.generated.txt"), docsPayload.payload);
	} finally {
		await runCommand(["pnpm", "--dir", "../stats", "run", "gen:stats:reset"]);
	}
	const stat = await fs.stat(cliPath);
	const elapsedMs = (bun.nanoseconds() - start) / 1_000_000;
	process.stdout.write(
		`Bundled coding-agent CLI to ${cliPath} (${formatBytes(stat.size)}) in ${elapsedMs.toFixed(0)}ms\n`,
	);
}

if (isMainModule(import.meta.url)) await bundleDist();
