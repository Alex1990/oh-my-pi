#!/usr/bin/env node
/**
 * Build the release distribution for every target platform.
 *
 * A target is a Node launcher (`oyp-<id>` on POSIX, `oyp-<id>.cmd` on Windows)
 * plus one shared `cli.js` bundle. The CLI itself is platform-independent, so
 * the bundle is produced once and every selected target shares it; only the
 * launcher differs.
 */
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { COMPILED_EXTERNAL_DEPENDENCIES, bundleCodingAgent, writeLauncher } from "../packages/coding-agent/scripts/compile-binary";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

interface BinaryTarget {
	id: string;
	platform: "darwin" | "linux" | "win32";
	arch: "x64" | "arm64";
	outfile: string;
}

const repoRoot = path.join(import.meta.dirname, "..");
const binariesDir = path.join(repoRoot, "packages", "coding-agent", "binaries");
const entrypoint = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const transformersManifest: unknown = createRequire(import.meta.url)("@huggingface/transformers/package.json");
if (
	typeof transformersManifest !== "object" ||
	transformersManifest === null ||
	!("version" in transformersManifest) ||
	typeof transformersManifest.version !== "string"
) {
	throw new Error("@huggingface/transformers package manifest has no string version");
}
const transformersVersion = transformersManifest.version;
const isDryRun = process.argv.includes("--dry-run");

function target(id: string, platform: BinaryTarget["platform"], arch: BinaryTarget["arch"], file: string): BinaryTarget {
	return { id, platform, arch, outfile: `packages/coding-agent/binaries/${file}` };
}

const targets: BinaryTarget[] = [
	target("darwin-arm64", "darwin", "arm64", "oyp-darwin-arm64"),
	target("darwin-x64", "darwin", "x64", "oyp-darwin-x64"),
	target("linux-x64", "linux", "x64", "oyp-linux-x64"),
	target("linux-arm64", "linux", "arm64", "oyp-linux-arm64"),
	target("linux-musl-x64", "linux", "x64", "oyp-linux-musl-x64"),
	target("linux-musl-arm64", "linux", "arm64", "oyp-linux-musl-arm64"),
	target("win32-x64", "win32", "x64", "oyp-windows-x64.cmd"),
	target("win32-arm64", "win32", "arm64", "oyp-windows-arm64.cmd"),
];

function parseRequestedTargets(): Set<string> | null {
	const flagIndex = process.argv.indexOf("--targets");
	const flagValue =
		flagIndex >= 0
			? process.argv[flagIndex + 1]
			: (process.argv.find(arg => arg.startsWith("--targets="))?.split("=", 2)[1] ?? bun.env.RELEASE_TARGETS);

	if (!flagValue) return null;

	return new Set(
		flagValue
			.split(",")
			.map(value => value.trim())
			.filter(Boolean),
	);
}

async function runCommand(command: string[], cwd: string): Promise<void> {
	const proc = bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
}

async function generateBundle(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN pnpm run gen:stats");
		console.log("DRY RUN pnpm --dir packages/collab-web run gen:tool-views");
		return;
	}
	await runCommand(["pnpm", "run", "gen:stats"], repoRoot);
	await runCommand(["pnpm", "--dir", "packages/collab-web", "run", "gen:tool-views"], repoRoot);
}

async function resetArtifacts(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN pnpm run gen:stats:reset");
		return;
	}
	await runCommand(["pnpm", "run", "gen:stats:reset"], repoRoot);
}

async function main(): Promise<void> {
	const requestedTargets = parseRequestedTargets();
	const selectedTargets = requestedTargets ? targets.filter(target => requestedTargets.has(target.id)) : targets;

	if (requestedTargets) {
		const unknownTargets = [...requestedTargets].filter(
			requestedTarget => !targets.some(target => target.id === requestedTarget),
		);
		if (unknownTargets.length > 0) throw new Error(`Unknown release target(s): ${unknownTargets.join(", ")}`);
	}
	if (selectedTargets.length === 0) throw new Error("No release targets selected.");

	await fs.mkdir(binariesDir, { recursive: true });
	try {
		await generateBundle();
		if (isDryRun) {
			console.log(
				`DRY RUN bundle outfile=packages/coding-agent/binaries/cli.js external=${COMPILED_EXTERNAL_DEPENDENCIES.join(",")}`,
			);
			for (const selected of selectedTargets) console.log(`DRY RUN launcher ${selected.outfile} (${selected.platform})`);
			return;
		}
		await bundleCodingAgent({
			repoRoot,
			entrypoint,
			outfile: path.join(binariesDir, "cli.js"),
			transformersVersion,
			minifyIdentifiers: true,
		});
		for (const selected of selectedTargets) {
			await writeLauncher(path.join(repoRoot, selected.outfile), selected.platform);
		}
	} finally {
		await resetArtifacts();
	}
}

await main();
