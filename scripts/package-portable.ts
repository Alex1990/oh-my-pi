#!/usr/bin/env node
/**
 * Assemble a self-contained release directory for one target.
 *
 * Layout:
 *   oyp-<target>/
 *     oyp(.cmd)            launcher, runs the bundled Node runtime
 *     runtime/node(.exe)   pinned Node.js runtime
 *     app/cli.js           CLI bundle
 *     app/<assets>         esbuild-emitted assets (models.json.zst, templates…)
 *     app/node_modules/    external runtime dependencies, pruned per target
 *     LICENSE, THIRD-PARTY-NOTICES.txt
 *
 * The launcher never consults the host: no system Node.js, no install, no
 * post-install downloads.
 *
 * Usage:
 *   node --experimental-transform-types --import ./scripts/node-runtime-loader.mjs \
 *     scripts/package-portable.ts \
 *     --target win32-x64 --node <path-to-node-binary> --deps <hoisted-node_modules> \
 *     [--out <dir>]
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface TargetSpec {
	readonly platform: "win32" | "darwin";
	readonly arch: "x64" | "arm64";
	readonly nodeBinary: string;
	readonly addons: readonly string[];
	readonly launcher: string;
}

const TARGETS: Record<string, TargetSpec> = {
	"win32-x64": {
		platform: "win32",
		arch: "x64",
		nodeBinary: "node.exe",
		addons: ["pi_natives.win32-x64-baseline.node"],
		launcher: '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0app\\cli.js" %*\r\n',
	},
	"darwin-arm64": {
		platform: "darwin",
		arch: "arm64",
		nodeBinary: "node",
		addons: ["pi_natives.darwin-arm64.node"],
		launcher: '#!/bin/sh\nexec "$(dirname "$0")/runtime/node" "$(dirname "$0")/app/cli.js" "$@"\n',
	},
};

const WINDOWS_INSTALL_CMD = `@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 pause
`;

const WINDOWS_INSTALL_PS1 = `$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$src = $PSScriptRoot
$dir = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "oyp" }
if ($src.TrimEnd('\\') -eq $dir.TrimEnd('\\')) {
	throw "This copy is already the installed directory: $dir"
}

if (Test-Path $dir) {
	Remove-Item -Recurse -Force $dir
}
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item -Path (Join-Path $src "*") -Destination $dir -Recurse -Force

$changedPath = $false
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$dir*") {
	[Environment]::SetEnvironmentVariable("Path", "$userPath;$dir", "User")
	$changedPath = $true
}

& (Join-Path $dir "oyp.cmd") --version
if ($LASTEXITCODE -ne 0) {
	throw "Installed oyp cannot start"
}

Write-Host ""
Write-Host "Installed oyp to $dir" -ForegroundColor Green
if ($changedPath) {
	Write-Host "Open a new terminal, then run 'oyp'."
} else {
	Write-Host "Run 'oyp' to get started."
}
`;

const repoRoot = path.resolve(import.meta.dirname, "..");

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

async function copyDir(from: string, to: string, filter?: (src: string) => boolean): Promise<void> {
	await fs.cp(from, to, { recursive: true, dereference: true, filter });
}

/** Keep only the target platform/arch under every onnxruntime-node/bin, including nested copies. */
async function pruneOnnxRuntime(nodeModules: string, spec: TargetSpec): Promise<void> {
	for (const entry of await fs.readdir(nodeModules, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(nodeModules, entry.name);
		if (entry.name === "onnxruntime-node") {
			await pruneOnnxRuntimeBin(dir, spec);
			continue;
		}
		if (entry.name.startsWith("@")) {
			for (const child of await fs.readdir(dir, { withFileTypes: true })) {
				if (!child.isDirectory()) continue;
				const childDir = path.join(dir, child.name);
				if (child.name === "onnxruntime-node") await pruneOnnxRuntimeBin(childDir, spec);
				else if (await exists(path.join(childDir, "node_modules"))) {
					await pruneOnnxRuntime(path.join(childDir, "node_modules"), spec);
				}
			}
			continue;
		}
		const nested = path.join(dir, "node_modules");
		if (await exists(nested)) await pruneOnnxRuntime(nested, spec);
	}
}

async function pruneOnnxRuntimeBin(packageDir: string, spec: TargetSpec): Promise<void> {
	const binRoot = path.join(packageDir, "bin");
	if (!(await exists(binRoot))) return;
	for (const variant of await fs.readdir(binRoot)) {
		const variantDir = path.join(binRoot, variant);
		for (const platform of await fs.readdir(variantDir)) {
			const platformDir = path.join(variantDir, platform);
			if (platform !== spec.platform) {
				await fs.rm(platformDir, { recursive: true, force: true });
				continue;
			}
			for (const arch of await fs.readdir(platformDir)) {
				if (arch !== spec.arch) await fs.rm(path.join(platformDir, arch), { recursive: true, force: true });
			}
		}
	}
}

/** Keep only the target platform/arch packages emitted by optionalDependencies. */
async function pruneOptionalPlatformPackages(nodeModules: string, spec: TargetSpec): Promise<void> {
	const platformTokens = ["darwin", "linux", "win32", "windows", "android", "freebsd"];
	for (const entry of await fs.readdir(nodeModules)) {
		if (entry.startsWith("@")) {
			const scope = path.join(nodeModules, entry);
			for (const child of await fs.readdir(scope)) {
				await pruneIfOtherPlatform(path.join(scope, child), `${entry}/${child}`, spec, platformTokens);
			}
			continue;
		}
		await pruneIfOtherPlatform(path.join(nodeModules, entry), entry, spec, platformTokens);
	}
}

async function pruneIfOtherPlatform(
	dir: string,
	name: string,
	spec: TargetSpec,
	platformTokens: readonly string[],
): Promise<void> {
	if (!(await exists(path.join(dir, "package.json")))) return;
	const token = platformTokens.find(value => name.includes(value));
	if (!token) return;
	const matchesPlatform =
		(spec.platform === "win32" && (token === "win32" || token === "windows")) ||
		(spec.platform === "darwin" && token === "darwin");
	const archToken = name.includes("arm64") ? "arm64" : name.includes("x64") ? "x64" : undefined;
	if (!matchesPlatform || (archToken && archToken !== spec.arch)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function findPackageDir(name: string, fromDir: string): Promise<string> {
	let dir = fromDir;
	while (true) {
		const candidate = path.join(dir, "node_modules", name);
		if (await exists(candidate)) return fs.realpath(candidate);
		const parent = path.dirname(dir);
		if (parent === dir) throw new Error(`Cannot resolve package ${name} from ${fromDir}`);
		dir = parent;
	}
}

/**
 * Copy one runtime package and its dependency tree into `destParent`.
 * Packages already copied by real path are skipped — Node's upward resolution
 * finds the installed copy. Version conflicts land nested beside their parent.
 */
async function installRuntimePackage(
	name: string,
	fromDir: string,
	destParent: string,
	seen: Set<string>,
): Promise<void> {
	const real = await findPackageDir(name, fromDir);
	if (seen.has(real)) return;
	seen.add(real);
	const dest = path.join(destParent, name);
	await fs.mkdir(path.dirname(dest), { recursive: true });
	await copyDir(real, dest, src => path.basename(src) !== "node_modules");
	const manifest = JSON.parse(await fs.readFile(path.join(real, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
		optionalDependencies?: Record<string, string>;
	};
	for (const dep of Object.keys(manifest.dependencies ?? {})) {
		await installRuntimePackage(dep, real, path.join(dest, "node_modules"), seen);
	}
	for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
		try {
			await installRuntimePackage(dep, real, path.join(dest, "node_modules"), seen);
		} catch {
			// Platform-specific optional package for another target; not installed here.
		}
	}
}

async function main(): Promise<void> {
	const targetId = arg("target") ?? "win32-x64";
	const spec = TARGETS[targetId];
	if (!spec) throw new Error(`Unknown target ${targetId}; known: ${Object.keys(TARGETS).join(", ")}`);
	const nodeSource = arg("node");
	const depsSource = arg("deps");
	if (!nodeSource) throw new Error("--node is required");

	const binariesDir = path.join(repoRoot, "packages", "coding-agent", "binaries");
	const nativesDir = path.join(repoRoot, "packages", "natives");
	const outRoot = path.resolve(arg("out") ?? path.join(os.tmpdir(), "oyp-portable"));
	const stage = path.join(outRoot, `oyp-${targetId}`);
	const appDir = path.join(stage, "app");

	await fs.rm(stage, { recursive: true, force: true });
	await fs.mkdir(appDir, { recursive: true });
	await fs.mkdir(path.join(stage, "runtime"), { recursive: true });

	// 1. CLI bundle and its emitted assets; launchers are rebuilt below.
	await copyDir(binariesDir, appDir, src => {
		const name = path.basename(src);
		return !name.startsWith("oyp-") && name !== "portable";
	});
	await fs.writeFile(path.join(appDir, "package.json"), '{"name":"oyp-app","private":true,"type":"module"}\n');

	// 2. Native addon package: loader files plus exactly this target's .node.
	const nativesDest = path.join(appDir, "node_modules", "@oh-my-pi", "pi-natives");
	await fs.mkdir(nativesDest, { recursive: true });
	await fs.copyFile(path.join(nativesDir, "package.json"), path.join(nativesDest, "package.json"));
	await copyDir(path.join(nativesDir, "native"), path.join(nativesDest, "native"));
	for (const entry of await fs.readdir(path.join(nativesDest, "native"))) {
		if (entry.endsWith(".node") && !spec.addons.includes(entry)) {
			await fs.rm(path.join(nativesDest, "native", entry), { force: true });
		}
	}
	await fs.rm(path.join(nativesDest, "native", ".build"), { recursive: true, force: true });

	// 3. External runtime dependencies, pruned to this target.
	const appModules = path.join(appDir, "node_modules");
	await fs.mkdir(appModules, { recursive: true });
	if (depsSource) {
		for (const entry of await fs.readdir(depsSource)) {
			if (entry === ".bin" || entry === ".modules.yaml" || entry === ".pnpm" || entry === ".package-lock.json")
				continue;
			await copyDir(path.join(depsSource, entry), path.join(appModules, entry));
		}
	} else {
		const seen = new Set<string>();
		for (const name of ["onnxruntime-node", "fastembed", "prettier"]) {
			await installRuntimePackage(name, repoRoot, appModules, seen);
		}
	}
	await pruneOnnxRuntime(appModules, spec);
	await pruneOptionalPlatformPackages(appModules, spec);

	// 4. Pinned Node runtime.
	await fs.copyFile(nodeSource, path.join(stage, "runtime", spec.nodeBinary));
	if (spec.platform !== "win32") await fs.chmod(path.join(stage, "runtime", spec.nodeBinary), 0o755);

	// 5. Launcher and notices.
	const launcherName = spec.platform === "win32" ? "oyp.cmd" : "oyp";
	const launcherPath = path.join(stage, launcherName);
	await fs.writeFile(launcherPath, spec.launcher);
	if (spec.platform !== "win32") await fs.chmod(launcherPath, 0o755);
	for (const notice of ["LICENSE", "THIRD-PARTY-NOTICES.txt"]) {
		const from = path.join(repoRoot, notice);
		if (await exists(from)) await fs.copyFile(from, path.join(stage, notice));
	}
	if (spec.platform === "win32") {
		await fs.writeFile(path.join(stage, "install.cmd"), WINDOWS_INSTALL_CMD);
		await fs.writeFile(path.join(stage, "install.ps1"), WINDOWS_INSTALL_PS1);
	}

	const size = await directorySize(stage);
	console.log(`staged ${path.relative(repoRoot, stage)} (${(size / 1024 / 1024).toFixed(1)} MiB)`);
}

async function directorySize(root: string): Promise<number> {
	let total = 0;
	const entries = await fs.readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) total += await directorySize(full);
		else if (entry.isSymbolicLink()) total += (await fs.stat(full)).size;
		else total += (await fs.stat(full)).size;
	}
	return total;
}

await main();
